/**
 * Manifest invariants. These are the constraints that are expensive to notice late:
 * a missing permission fails at runtime on a user's machine, and a stray host permission
 * or network call is a privacy regression that no unit test would otherwise catch.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';

const EXT = 'shelf';
const manifest = JSON.parse(readFileSync(join(EXT, 'manifest.json'), 'utf8'));

/** Every .js file we ship. */
function sourceFiles(dir = join(EXT, 'src')) {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? sourceFiles(p) : extname(p) === '.js' ? [p] : [];
  });
}

/** Source with comments removed, so a chrome.* mentioned in prose isn't counted. */
function code(path) {
  return readFileSync(path, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/**
 * chrome.* namespaces available to every extension with no manifest entry.
 * `permissions` is here because requesting optional permissions cannot itself require
 * a permission — that would be circular.
 */
const NO_DECLARATION_NEEDED = new Set([
  'runtime', 'action', 'permissions', 'i18n', 'extension', 'test',
  // chrome.windows needs no permission of its own. Only the url/title/favIconUrl
  // properties of a tab are gated, and we only ever set { focused: true }.
  'windows',
]);

/**
 * APIs switched on by a top-level MANIFEST KEY rather than by a permission. Declaring
 * these under "permissions" does nothing; omitting the key leaves the API undefined at
 * runtime with no warning at load.
 */
const MANIFEST_KEY_GATED = { commands: 'commands' };

/**
 * APIs we reach through HOST permissions rather than a named permission, with the
 * reason each is deliberate. Adding one of these to manifest.permissions would be the
 * easy fix and the wrong one — read the reason before touching this.
 */
const HOST_PERMISSION_GATED = {
  tabs:
    'chrome.tabs.query({url}) filters by URL using host permissions for those origins, ' +
    'and we only ever query the origins the user has already granted. Declaring the ' +
    '"tabs" permission instead would put "Read your browsing history" on the install ' +
    'screen of a product whose entire pitch is that it reads nothing.',
};

test('manifest declares every chrome API the source actually calls', () => {
  const declared = new Set(manifest.permissions ?? []);
  const missing = new Set();

  for (const file of sourceFiles()) {
    for (const [, ns] of code(file).matchAll(/\bchrome\.([a-zA-Z]+)\b/g)) {
      if (declared.has(ns)) continue;
      if (NO_DECLARATION_NEEDED.has(ns)) continue;
      if (ns in HOST_PERMISSION_GATED) continue;
      if (ns in MANIFEST_KEY_GATED) continue;
      missing.add(`${ns} (${file})`);
    }
  }
  assert.deepEqual([...missing], [], 'undeclared chrome APIs');
});

test('never requests broad host access at install — TRD §9', () => {
  // The single most consequential line in the manifest. Broad host access at install
  // pushes Chrome Web Store review into the slow tier, and Safari forces per-site
  // granting regardless, so it buys nothing and costs weeks.
  assert.equal(manifest.host_permissions, undefined, 'host_permissions must not exist');
  assert.deepEqual(manifest.optional_host_permissions, ['http://*/*', 'https://*/*']);
});

test('extension pages cannot open a network connection — TRD §14', () => {
  const csp = manifest.content_security_policy?.extension_pages ?? '';
  assert.match(csp, /connect-src 'none'/, 'CSP must pin connect-src to none');
  assert.match(csp, /script-src 'self'/, 'no remote code — required by MV3 anyway');
});

test('no source file contains a network primitive', () => {
  const banned = /\bfetch\s*\(|XMLHttpRequest|WebSocket|EventSource|sendBeacon|importScripts/;
  for (const file of sourceFiles()) {
    assert.doesNotMatch(code(file), banned, `network primitive in ${file}`);
  }
});

test('no source file references a remote origin', () => {
  // Catches remote fonts, CDN scripts, favicon fetching, and analytics endpoints.
  for (const file of sourceFiles()) {
    const hits = [...code(file).matchAll(/https?:\/\/[^\s'"`)]+/g)].map((m) => m[0]);
    assert.deepEqual(hits, [], `remote origin in ${file}`);
  }
});

/** Every shipped file that can pull a resource: JS, CSS, HTML. */
function assetFiles(dir = EXT) {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return assetFiles(p);
    return ['.js', '.css', '.html'].includes(extname(p)) ? [p] : [];
  });
}

test('no shipped CSS or HTML references a remote origin', () => {
  // The JS-only check above would have missed the whole font question: a stylesheet can
  // pull a webfont, an image, or an @import from anywhere, and none of it looks like a
  // network call in code review.
  for (const file of assetFiles()) {
    const hits = [...readFileSync(file, 'utf8').matchAll(/https?:\/\/[^\s'"`)]+/g)]
      .map((m) => m[0])
      .filter((u) => !u.startsWith('https://fonts.googleapis.com/css2?')); // prose in comments
    assert.deepEqual(hits, [], `remote origin in ${file}`);
  }
});

test('every local url() in shipped CSS resolves on disk', () => {
  for (const file of assetFiles().filter((f) => extname(f) === '.css')) {
    const dir = file.slice(0, file.lastIndexOf('/'));
    for (const [, ref] of readFileSync(file, 'utf8').matchAll(/url\(['"]?([^'")]+)['"]?\)/g)) {
      if (ref.startsWith('data:')) continue;
      assert.doesNotThrow(() => statSync(join(dir, ref)), `${file} references missing ${ref}`);
    }
  }
});

test('bundled fonts are real woff2 and carry their licence', () => {
  // OFL 1.1 permits redistribution but requires the licence travel with the files.
  // Shipping the binaries without it is the kind of omission that surfaces at store
  // review, after the submission queue.
  const fonts = readdirSync(join(EXT, 'fonts'));
  assert.ok(fonts.includes('OFL.txt'), 'fonts/OFL.txt missing');
  for (const f of fonts.filter((n) => n.endsWith('.woff2'))) {
    const head = readFileSync(join(EXT, 'fonts', f)).subarray(0, 4).toString('latin1');
    assert.equal(head, 'wOF2', `${f} is not a woff2`);
  }
});

test('every path the manifest names exists on disk', () => {
  const paths = new Set([
    ...Object.values(manifest.icons ?? {}),
    ...Object.values(manifest.action?.default_icon ?? {}),
    manifest.background?.service_worker,
    manifest.action?.default_popup,
    manifest.options_page,
  ].filter(Boolean));

  for (const p of paths) {
    assert.doesNotThrow(() => statSync(join(EXT, p)), `manifest names a missing file: ${p}`);
  }
});

test('content.js, if present, is never registered as a module', () => {
  // Content scripts cannot be ES modules. If this ever regresses it fails silently on
  // the page rather than loudly at load.
  const declared = manifest.content_scripts ?? [];
  for (const entry of declared) {
    assert.notEqual(entry.type, 'module', 'content scripts must be classic');
  }
});

test('host-permission-gated APIs stay out of manifest.permissions', () => {
  // The failure this guards against is someone hitting the undeclared-API test above and
  // "fixing" it by declaring the permission — which would silently add an install-time
  // warning that contradicts the product.
  const declared = new Set(manifest.permissions ?? []);
  for (const [api, reason] of Object.entries(HOST_PERMISSION_GATED)) {
    assert.ok(!declared.has(api), `"${api}" must not be declared. ${reason}`);
  }
});

test('manifest-key-gated APIs have their key present', () => {
  // The failure mode this catches is silent: chrome.commands is simply undefined if the
  // "commands" key is missing, and nothing complains at extension load.
  for (const [api, key] of Object.entries(MANIFEST_KEY_GATED)) {
    assert.ok(manifest[key], `chrome.${api} is used but manifest."${key}" is absent`);
  }
});

test('the keyboard shortcut does not collide with a Chrome default', () => {
  // Chrome silently drops a suggested_key that clashes with one of its own shortcuts,
  // and the command then never fires — with no error anywhere.
  const RESERVED = new Set([
    'Ctrl+Shift+T', 'Ctrl+Shift+N', 'Ctrl+Shift+W', 'Ctrl+Shift+Q',
    'Ctrl+Shift+J', 'Ctrl+Shift+I', 'Ctrl+Shift+C', 'Ctrl+Shift+B',
    'Ctrl+Shift+O', 'Ctrl+Shift+D', 'Ctrl+Shift+P', 'Ctrl+Shift+M',
  ]);
  for (const [name, def] of Object.entries(manifest.commands ?? {})) {
    for (const key of Object.values(def.suggested_key ?? {})) {
      const normalised = key.replace(/^Command\+/, 'Ctrl+').replace(/^MacCtrl\+/, 'Ctrl+');
      assert.ok(!RESERVED.has(normalised), `${name} uses reserved shortcut ${key}`);
    }
  }
});

test('no shipped script assigns HTML from a string', () => {
  // Every string rendered on the shelf came off a web page — passage text, titles,
  // domains. Building DOM nodes means there is no escaping step to forget. innerHTML
  // on this page would be an XSS hole in the one document that can read the whole
  // library, and it would look completely ordinary in review.
  for (const file of sourceFiles()) {
    assert.doesNotMatch(
      code(file),
      /\.(innerHTML|outerHTML)\s*=|insertAdjacentHTML|document\.write/,
      `HTML-from-string in ${file}`
    );
  }
});

test('extension pages load only local scripts and styles', () => {
  for (const file of assetFiles().filter((f) => extname(f) === '.html')) {
    const html = readFileSync(file, 'utf8');
    for (const [, ref] of html.matchAll(/(?:src|href)="([^"]+)"/g)) {
      assert.ok(!/^https?:/.test(ref), `${file} loads remote ${ref}`);
    }
    // MV3 forbids inline script anyway; assert it so the failure is a test, not a
    // blank page with a CSP violation in a console nobody has open.
    assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>[\s\S]*?\S[\s\S]*?<\/script>/,
      `${file} contains inline script`);
  }
});

test('the popup replaces the temporary grant handler, not sits beside it', () => {
  // action.onClicked never fires while a default_popup exists. Leaving that listener in
  // would be dead code that reads as live, and the next person to touch permissions
  // would reasonably believe two paths grant access.
  const bg = code(join(EXT, 'src', 'background.js'));
  if (manifest.action?.default_popup) {
    assert.doesNotMatch(bg, /chrome\.action\.onClicked/,
      'default_popup is set, so action.onClicked is dead — remove it');
  }
});

test('every command has a handler', () => {
  // A declared command with no listener is a shortcut that silently does nothing.
  const bg = code(join(EXT, 'src', 'background.js'));
  for (const name of Object.keys(manifest.commands ?? {})) {
    assert.ok(bg.includes(`'${name}'`), `command "${name}" declared but never handled`);
  }
});

test('onboarding and popup are reachable and complete', () => {
  for (const page of ['src/popup.html', 'src/welcome.html']) {
    const html = readFileSync(join(EXT, page), 'utf8');
    for (const [, ref] of html.matchAll(/(?:src|href)="([^"]+)"/g)) {
      assert.doesNotThrow(() => statSync(join(EXT, 'src', ref)), `${page} references missing ${ref}`);
    }
  }
});

test('every element id a page script reaches for exists in its markup', () => {
  // document.getElementById returns null for a typo, and every call site here is either
  // `.textContent = ` or `.addEventListener(` — both of which throw inside whatever
  // handler they were in, taking the rest of that function with them. A mistyped id in
  // markup that never renders in a unit test is otherwise found by a user.
  for (const [script, markup] of [
    ['popup.js', 'popup.html'],
    ['shelf.js', 'shelf.html'],
    ['welcome.js', 'welcome.html'],
  ]) {
    const html = readFileSync(join(EXT, 'src', markup), 'utf8');
    const ids = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
    const used = new Set(
      [...code(join(EXT, 'src', script)).matchAll(/\$\('([^']+)'\)/g)].map((m) => m[1])
    );
    assert.deepEqual([...used].filter((id) => !ids.has(id)), [],
      `${script} reaches for ids that ${markup} does not define`);
  }
});

test('onboarding cannot be skipped past the backup screen by a single click', () => {
  // PRD §9: screen 2 "is not skippable without either configuring a backup or explicitly
  // dismissing a you-have-no-backup warning". The dismissal must cost more than the
  // agreement, or it is not a warning.
  const js = code(join(EXT, 'src', 'welcome.js'));
  assert.match(js, /revealConfirm/, 'the skip button must reveal a confirmation');
  assert.doesNotMatch(js, /skip-backup'\)\.addEventListener\('click', \(\) => go\(/,
    'the skip button must not advance directly');
  const html = readFileSync(join(EXT, 'src', 'welcome.html'), 'utf8');
  assert.match(html, /id="confirm-next"[^>]*disabled/, 'continue must start disabled');
  assert.match(html, /id="accept"/, 'an explicit acknowledgement is required');
});

test('no callback-only chrome API is awaited as a promise', () => {
  // chrome.contextMenus.create returns the new id SYNCHRONOUSLY and reports failure
  // through runtime.lastError. Awaiting it awaits a string, so a try/catch around it can
  // never see the error — which is how "Cannot create item with duplicate id" ended up
  // in the extension error panel as an Unchecked runtime.lastError rather than being
  // handled. Only the callback form consumes it.
  const CALLBACK_ONLY = [
    'contextMenus.create',
  ];
  for (const file of sourceFiles()) {
    const src = code(file);
    for (const api of CALLBACK_ONLY) {
      assert.ok(!src.includes(`await chrome.${api}`),
        `${file} awaits chrome.${api}, which is not a promise — use the callback form`);
    }
  }
});

test('context menu creation consumes runtime.lastError', () => {
  const bg = code(join(EXT, 'src', 'background.js'));
  assert.match(bg, /chrome\.contextMenus\.create\([^)]*,\s*\(\)\s*=>/s,
    'create() must pass a callback so lastError is read');
  assert.match(bg, /chrome\.runtime\.lastError/,
    'the callback must actually read lastError');
});
