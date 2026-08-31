/**
 * Shelf It — service worker.
 *
 * Owns every write (TRD §4). The shelf page reads IndexedDB directly, but nothing else
 * writes to it: content.js and the popup send messages here instead.
 *
 * ES module, per "type": "module" in the manifest. content.js is a CLASSIC script and
 * cannot import from here — it talks over the message protocol in §8.
 *
 * TRD §10, because MV3 tears this worker down after ~30s idle:
 *   - No module-scope mutable state that matters. Everything below is either a constant
 *     or derived per-call. The worker restarts and loses nothing.
 *   - No setTimeout beyond a couple of seconds. The badge flash is the only timer here
 *     and it is 1.6s; anything longer would need chrome.alarms.
 *   - The IndexedDB handle is cached in db.js, which resets it on close. See withDb().
 */

import * as db from './db.js';
import {
  NORMALIZE_VERSION, normalizeUrl, urlHash, domainOf, collapseWhitespace,
} from './util.js';

const MENU_ID = 'shelf-save-selection';
const MENU_OPEN_ID = 'shelf-open';

/**
 * Fallback when storage.local has no defaultColor yet. TRD §5.3.
 *
 * Empty, not 'yellow'. A colour every clip carries by default is not a code — the
 * timeline would be a column of identical dots and U9's "distinguish kinds of passage"
 * would distinguish nothing. Colour is applied deliberately or not at all.
 */
const DEFAULT_COLOR = '';

const log = (...args) => console.debug('[shelf:sw]', ...args);

/* ================================================================== *
 * Clip assembly
 * ================================================================== */

/**
 * Build a clip record from a capture. Shape is TRD §5.1.
 *
 * Pure apart from the id, the clock, and one storage read — deliberately so, because
 * every save path (context menu now; the bar and popup later) funnels through here and
 * must produce identical records. A second assembly site is how the two paths drift.
 *
 * @param {object} capture
 * @param {string} capture.text     the passage, pre-collapse
 * @param {string} capture.url      source URL, timestamp included if media (TRD §7.2)
 * @param {string} [capture.title]
 * @param {{prefix?: string, suffix?: string}} [capture.context]
 * @param {number|null} [capture.seconds]
 * @param {string} [capture.color]
 * @param {string} [capture.note]
 * @returns {Promise<object>}
 */
async function buildClip(capture) {
  const url = String(capture.url ?? '').trim();
  const canonicalUrl = normalizeUrl(url);

  return {
    id: crypto.randomUUID(),
    text: collapseWhitespace(capture.text),
    note: collapseWhitespace(capture.note ?? ''),
    color: capture.color ?? (await defaultColor()),

    url,
    canonicalUrl,
    urlHash: await urlHash(canonicalUrl),
    // Version the rules that produced this hash, so a future rule change can find the
    // records that need rehashing instead of silently orphaning them. TRD §5.4.
    normalizeVersion: NORMALIZE_VERSION,

    domain: domainOf(url),
    title: collapseWhitespace(capture.title ?? ''),

    // TRD §6's hedge. Unused in v1. Empty from the context-menu path — info.selectionText
    // arrives without a Range, so there is nothing to take prefix/suffix from. The save
    // bar supplies both at step 5.
    context: {
      prefix: String(capture.context?.prefix ?? '').slice(0, 32),
      suffix: String(capture.context?.suffix ?? '').slice(0, 32),
    },

    seconds: Number.isFinite(capture.seconds) ? Math.floor(capture.seconds) : null,
    savedAt: Date.now(),
    isPublic: false,     // export inclusion is opt-in, never a default. TRD §12.
  };
}

/** defaultColor from storage.local, with a fallback. TRD §5.3. */
async function defaultColor() {
  try {
    const { defaultColor: c } = await chrome.storage.local.get('defaultColor');
    return c ?? DEFAULT_COLOR;
  } catch {
    return DEFAULT_COLOR;
  }
}

/**
 * Assemble, write, and report. The single write path.
 *
 * PRD §8.1: the clip is written before any confirmation renders. The badge flash below
 * happens strictly after the transaction commits, so a user who navigates away the
 * instant they click has still saved.
 *
 * @returns {Promise<{ok: true, id: string, pageCount: number} | {ok: false, error: string}>}
 */
async function saveClip(capture) {
  try {
    const clip = await buildClip(capture);

    if (!clip.text) {
      // TRD principle: never guess at content. Nothing to save is not an error, but it
      // is not a save either — say so rather than writing an empty record.
      log('save skipped — empty text');
      return { ok: false, error: 'empty' };
    }

    await db.addClip(clip);
    const pageCount = await db.countByUrlHash(clip.urlHash);
    // The source tag distinguishes the three save paths in the log. They all funnel
    // through here by design (§8), which makes them indistinguishable without it.
    log('saved via', capture.source || 'unknown', '—', clip.id, clip.domain,
        'pageCount', pageCount);

    flashBadge('✓', '#A8462A');
    return { ok: true, id: clip.id, pageCount };
  } catch (err) {
    console.error('[shelf:sw] save failed', err);
    flashBadge('!', '#8A5A1F');
    return { ok: false, error: String(err?.message ?? err) };
  }
}

/**
 * Brief toolbar-badge confirmation.
 *
 * The context menu is the one save path with no UI of its own (TRD §9.1 — it works on
 * sites with no permission granted, where no content script can run). Without this the
 * user gets no signal at all that anything happened.
 */
function flashBadge(text, color) {
  chrome.action.setBadgeBackgroundColor({ color });
  chrome.action.setBadgeText({ text });
  setTimeout(() => chrome.action.setBadgeText({ text: '' }), 1600);
}

/* ================================================================== *
 * Context menu — the universal fallback, TRD §9.1
 *
 * info.selectionText arrives with the click, independent of host permissions. This is
 * why it is the first save path built: it is the only one that works everywhere, and
 * everything else degrades to it.
 * ================================================================== */

/**
 * In-flight installation, so concurrent callers share one pass rather than racing
 * removeAll against create.
 *
 * This IS module-scope mutable state, which §10 warns about — but it is a cache whose
 * loss is harmless. When the worker respawns it resets to null and the menu is simply
 * reinstalled, which is exactly what we want.
 * @type {Promise<void> | null}
 */
let menuReady = null;

function ensureContextMenu() {
  if (!menuReady) menuReady = installContextMenu();
  return menuReady;
}

/**
 * Create one menu item, consuming any error.
 *
 * chrome.contextMenus.create is NOT promise-based. It returns the id synchronously and
 * reports failure through runtime.lastError, so `await create(...)` awaits a string and
 * a try/catch around it can never see the failure — which is exactly how "Cannot create
 * item with duplicate id" surfaced as an Unchecked runtime.lastError in the extensions
 * error panel instead of being handled here.
 *
 * The callback form is the only way to consume it. A duplicate id means the item already
 * exists, which is the state we wanted anyway, so it is logged rather than treated as a
 * failure.
 */
function createMenu(props) {
  chrome.contextMenus.create(props, () => {
    const err = chrome.runtime.lastError;
    if (err) log('menu item', props.id, '—', err.message);
  });
}

async function installContextMenu() {
  // Callback form, so removal is genuinely complete before anything is created.
  // Context menus survive worker teardown, so a respawn finds the previous set still
  // registered and every create would collide.
  await new Promise((resolve) => chrome.contextMenus.removeAll(resolve));

  createMenu({
    id: MENU_ID,
    title: 'Save selection to Shelf It',
    contexts: ['selection'],
  });

  // On the toolbar icon itself. The popup owns the left click, so the shelf needs its
  // own way in from there.
  createMenu({
    id: MENU_OPEN_ID,
    title: 'Open shelf',
    contexts: ['action'],
  });

  log('context menu installed');
}

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === MENU_OPEN_ID) {
    openShelf();
    return;
  }
  if (info.menuItemId !== MENU_ID) return;
  saveClip({
    source: 'context-menu',
    text: info.selectionText ?? '',
    // info.pageUrl is present even without host permissions; tab.url may not be.
    url: info.pageUrl ?? tab?.url ?? '',
    title: tab?.title ?? '',
  });
});

/* ================================================================== *
 * Opening the shelf
 * ================================================================== */

/**
 * Focus the shelf if it is already open, otherwise open it.
 *
 * Without the reuse check, every invocation leaves another copy behind — and since the
 * page holds the whole library in memory, duplicates are both untidy and wasteful.
 */
async function openShelf() {
  const url = chrome.runtime.getURL('src/shelf.html');
  const [existing] = await chrome.tabs.query({ url });
  if (existing?.id) {
    await chrome.tabs.update(existing.id, { active: true });
    if (existing.windowId) await chrome.windows.update(existing.windowId, { focused: true });
    log('shelf focused');
    return;
  }
  await chrome.tabs.create({ url });
  log('shelf opened');
}

chrome.commands.onCommand.addListener((command) => {
  log('command', command);
  if (command === 'open-shelf') openShelf();
  if (command === 'save-page') savePageByShortcut();
});

/**
 * Save the current page from the keyboard. Completes TRD §9.1's degradation table.
 *
 * §9 warns that chrome.commands other than _execute_action do NOT grant activeTab, so
 * this cannot request permission on its own and cannot read an unpermitted page. That is
 * the one row in the table marked with a badge: not granted -> shortcut fails visibly
 * with `!`, and the user falls back to right-click, which always works.
 */
async function savePageByShortcut() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const origins = originPatternFor(tab?.url);

  if (!origins || !(await chrome.permissions.contains({ origins }))) {
    // §9.1's badge. Silence here would read as the shortcut being broken.
    log('save-page: no access to', tab?.url);
    flashBadge('!', '#8A5A1F');
    return;
  }

  let text = '';
  try {
    const [result] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => {
        const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();
        for (const sel of ['meta[property="og:description"]',
                           'meta[name="twitter:description"]',
                           'meta[name="description"]']) {
          const v = clean(document.querySelector(sel)?.content);
          if (v) return v;
        }
        const article = clean(document.querySelector('article')?.innerText);
        return article.length > 200 ? article.slice(0, 600) : '';
      },
    });
    text = result?.result ?? '';
  } catch (err) {
    log('excerpt unavailable', err?.message);
  }

  await saveClip({ source: 'shortcut', text, url: tab.url, title: tab.title ?? '' });
}

/* ================================================================== *
 * Lifecycle
 * ================================================================== */

chrome.runtime.onInstalled.addListener(async (details) => {
  log('onInstalled', details.reason);
  await ensureContextMenu();

  // First-run stamp. The no-backup escalation counts from here (PRD §9, §12).
  //
  // Deliberately NOT gated on reason === 'install'. Anyone who installed before this
  // field existed — and anyone whose first install predates an update — would otherwise
  // never get one, and getMeta('installedAt') falling back to Date.now() means the
  // seven-day warning silently never escalates. A missing stamp is the one case that
  // needs writing, whatever the reason.
  const existing = await db.getMeta('installedAt');
  if (existing === undefined) {
    await db.setMeta('installedAt', Date.now());
    log('installedAt stamped');
  }

  // First run only. PRD §9 — four screens whose job is expectation-setting, because both
  // of the things most likely to cause angry churn are expectation failures.
  if (details.reason === 'install') {
    chrome.tabs.create({ url: chrome.runtime.getURL('src/welcome.html') });
  }
});

// Menus survive worker teardown but not always a browser restart. Cheap to re-assert.
chrome.runtime.onStartup.addListener(() => {
  log('onStartup');
  ensureContextMenu();
  syncContentScripts();
});

/* ================================================================== *
 * Runtime content-script registration — TRD §9
 *
 * The save bar only exists on origins the user has explicitly granted. Nothing is
 * declared in the manifest, because a static content_scripts block would require
 * host_permissions at install — the exact thing §9 forbids.
 *
 * Re-synced on every worker spawn and whenever permissions change, so granting a site
 * takes effect without a browser restart.
 * ================================================================== */

const SCRIPT_ID = 'shelf-bar';

/**
 * Match pattern for a URL's origin, or null if the page is one extensions cannot touch.
 * @param {string|undefined} url
 * @returns {string[]|null}
 */
function originPatternFor(url) {
  try {
    const u = new URL(String(url));
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return [u.origin + '/*'];
  } catch {
    return null;
  }
}

async function syncContentScripts() {
  try {
    const { origins = [] } = await chrome.permissions.getAll();
    const matches = origins.filter((o) => o.startsWith('http://') || o.startsWith('https://'));

    // Unregister before registering, or a duplicate id throws (§9). Absent id also
    // throws, hence the swallow — there is no "unregister if present".
    try {
      await chrome.scripting.unregisterContentScripts({ ids: [SCRIPT_ID] });
    } catch {
      /* not registered yet */
    }

    if (!matches.length) {
      log('content scripts: no granted origins');
      return;
    }

    await chrome.scripting.registerContentScripts([{
      id: SCRIPT_ID,
      js: ['src/content.js'],
      matches,
      runAt: 'document_idle',
      allFrames: false,
      world: 'ISOLATED',
    }]);
    log('content scripts registered for', matches.length, 'origin(s)');

    await injectIntoOpenTabs(matches);
  } catch (err) {
    console.error('[shelf:sw] content script sync failed', err);
  }
}

/**
 * Registration only affects future navigations. Without this, granting a site does
 * nothing until the user reloads — which reads as the grant having failed.
 *
 * content.js guards on window.__shelfLoaded, so injecting into a tab that already has
 * it is a no-op.
 */
async function injectIntoOpenTabs(matches) {
  const tabs = await chrome.tabs.query({ url: matches });
  await Promise.all(tabs.map(async (tab) => {
    if (!tab.id) return;
    try {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['src/content.js'] });
    } catch (err) {
      // Expected on pages an extension may never touch: the web store, chrome:// pages,
      // PDFs. Not worth failing the whole sync over.
      log('inject skipped for tab', tab.id, String(err && err.message));
    }
  }));
}

chrome.permissions.onAdded.addListener((p) => {
  log('permissions added', p.origins);
  syncContentScripts();
});

chrome.permissions.onRemoved.addListener((p) => {
  log('permissions removed', p.origins);
  syncContentScripts();
});

/* ================================================================== *
 * Message protocol — TRD §8
 * ================================================================== */

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || typeof msg.type !== 'string') return false;

  switch (msg.type) {
    case 'SAVE_CLIP':
      saveClip(msg.payload ?? {}).then(sendResponse);
      return true;      // keep the channel open for the async reply

    case 'PAGE_STATE':
      pageState(msg.payload ?? {}).then(sendResponse);
      return true;

    default:
      return false;
  }
});

/**
 * What the popup needs to render: how many clips from this page, how many overall, and
 * whether this origin has been granted host access. TRD §8.
 */
async function pageState({ url }) {
  try {
    const canonical = normalizeUrl(String(url ?? ''));
    const [pageCount, total, granted] = await Promise.all([
      db.countByUrlHash(await urlHash(canonical)),
      db.countClips(),
      hasHostPermission(url),
    ]);
    return { ok: true, pageCount, total, granted };
  } catch (err) {
    console.error('[shelf:sw] pageState failed', err);
    return { ok: false, error: String(err?.message ?? err) };
  }
}

/**
 * Has the user granted host access for this URL?
 *
 * Never requests — only asks. Requesting requires a user gesture and belongs to the
 * popup's explicit grant button (step 9). TRD §9: never broad host access at install.
 */
async function hasHostPermission(url) {
  try {
    const u = new URL(String(url));
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    return await chrome.permissions.contains({ origins: [u.origin + '/*'] });
  } catch {
    return false;
  }
}

/* ================================================================== *
 * Debug handle — see step 2's acceptance check.
 * Worker global scope is extension-private; no page or content script reaches it.
 * ================================================================== */

globalThis.shelfDb = db;
globalThis.shelfSave = saveClip;

/**
 * Install on every worker spawn.
 *
 * onInstalled fires once per install or update; onStartup once per browser launch.
 * Neither fires when MV3 tears the worker down for idling and respawns it on the next
 * event — and if the menu was ever lost, nothing would put it back until the browser
 * restarted. Context menus are cheap to re-assert, and the universal fallback save path
 * (§9.1) is the last thing that should depend on a lifecycle event firing.
 */
ensureContextMenu();
syncContentScripts();

console.debug('[shelf] worker boot', new Date().toISOString());
