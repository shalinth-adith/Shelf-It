/**
 * The save bar's off switch.
 *
 * The bar is the one part of Shelf It that appears uninvited on someone else's page, so the
 * ability to turn it off is not a preference — it is the thing that keeps PRD principle 5
 * true. Every failure mode below is silent: the switch reads as off while the bar keeps
 * appearing, or the bar flashes on a site the user turned it off for, and nothing errors.
 *
 * Structural rather than behavioural, because content.js is a classic script that runs in
 * a page context with chrome.* present — there is nothing to import here. These assert the
 * shape that makes the feature work, which is what actually regresses.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { domainOf } from '../shelf/src/util.js';

const SRC = join('shelf', 'src');
const read = (name) => readFileSync(join(SRC, name), 'utf8');

const content = read('content.js');
const util = read('util.js');
const popupJs = read('popup.js');
const shelfJs = read('shelf.js');

/* ------------------------------------------------------------------ *
 * One site key, two files
 * ------------------------------------------------------------------ */

/**
 * The `www.`-stripping expression, with its variable renamed away so the two files can
 * use whatever local name suits them.
 */
function siteKeyExpression(source, file) {
  const m = source.match(/return (\w+)\.startsWith\('www\.'\) \? \1\.slice\(4\) : \1;/);
  assert.ok(m, `no site-key expression found in ${file}`);
  return m[0].replace(new RegExp('\\b' + m[1] + '\\b', 'g'), 'X');
}

test('content.js derives the site key exactly as util.domainOf does', () => {
  // content.js cannot import (it is a classic script in an isolated world), so this one
  // expression is duplicated on purpose. If the copies drift, a site switched off in the
  // popup is stored under one key and matched under another: the switch shows off, the
  // bar keeps appearing, and nothing anywhere reports a problem.
  assert.equal(
    siteKeyExpression(content, 'content.js'),
    siteKeyExpression(util, 'util.js'),
    'content.js and util.domainOf must strip the same prefix the same way'
  );
});

test('the popup writes the key it displays', () => {
  // The switch is labelled "Save bar on <host>". If the label and the stored key are
  // derived differently, the user turns off a site they were never shown.
  assert.match(popupJs, /siteKey = domainOf\(tab\.url\)/,
    'the popup must key the switch on domainOf, not a second hand-rolled strip');
  assert.doesNotMatch(popupJs, /hostname\.replace\(\/\^www\\\.\//,
    'a second hostname derivation has crept back into the popup');
});

test('domainOf answers the shapes the switch will actually be keyed on', () => {
  assert.equal(domainOf('https://www.youtube.com/watch?v=abc&t=484s'), 'youtube.com');
  assert.equal(domainOf('https://youtube.com/watch?v=abc'), 'youtube.com');
  assert.equal(domainOf('https://m.youtube.com/watch?v=abc'), 'm.youtube.com');
  assert.equal(domainOf('http://EXAMPLE.com/a'), 'example.com');
});

/* ------------------------------------------------------------------ *
 * The gate in content.js
 * ------------------------------------------------------------------ */

test('the bar is gated on both settings', () => {
  for (const key of ['barEnabled', 'barOffSites']) {
    assert.ok(content.includes(key), `content.js never reads ${key}`);
  }
  // The gate has to sit in evaluate(), before any measuring or DOM work. Anywhere later
  // and the bar is built and positioned before being hidden again.
  assert.match(content, /function evaluate\(\)\s*\{\s*if \(!barOn\) \{/,
    'evaluate() must return before qualifying a selection when the bar is off');
});

test('the gate starts closed, not open', () => {
  // A default of true means the bar appears for the few milliseconds between injection
  // and the first storage read — on precisely the site the user switched it off for.
  // That flash is the whole complaint the switch exists to answer.
  assert.match(content, /let barOn = null;/,
    'barOn must start null (unknown) so the bar cannot flash before the setting is read');
});

test('a flipped switch reaches tabs that are already open', () => {
  // Without a live listener the user turns the bar off, returns to the tab they were
  // reading, selects a word, and the bar appears anyway — which reads as a broken switch
  // rather than a stale one.
  assert.match(content, /chrome\.storage\.onChanged\.addListener/,
    'content.js must watch storage so open tabs update without a reload');
  assert.match(content, /if \(!barOn\) hide\(\);/,
    'turning the bar off must take it off screen immediately');
});

test('storage failure leaves the bar on', () => {
  // Erring closed here would mean an unreadable storage area silently removes the
  // product's main affordance, with no setting anywhere explaining it.
  assert.match(content, /lastError\)\s*\{\s*\/\/[^\n]*\n\s*barOn = true;/,
    'an unreadable storage area must fall back to the bar being on');
});

/* ------------------------------------------------------------------ *
 * Off is never a dead end — TRD §9.1
 * ------------------------------------------------------------------ */

test('both switches say what still works when the bar is off', () => {
  // Right-click → Save selection to Shelf It needs no content script and no host permission,
  // so switching the bar off costs the user nothing but the button. Copy that omits this
  // turns a preference into "I have disabled the extension".
  assert.match(popupJs, /Right-click/, 'the popup switch must name the fallback');
  assert.match(shelfJs, /Right-click/, 'the shelf switch must name the fallback');
});

test('a per-site switch can be undone from somewhere other than that site', () => {
  // A site turned off in the popup is invisible everywhere except that site. Without a
  // list and a reset on the shelf page, "the bar stopped appearing on one blog" has no
  // answer anywhere in the product.
  assert.match(shelfJs, /function clearBarOffSites/, 'the shelf must offer a reset');
  assert.match(shelfJs, /\$\('bar-sites'\)\.textContent/, 'the shelf must list the off sites');
});

test('the master switch and the per-site exceptions stay separate settings', () => {
  // Clearing the exception list must not switch the master back on, and vice versa.
  // Folding them together surprises whoever turned the master off deliberately.
  const clear = shelfJs.slice(shelfJs.indexOf('function clearBarOffSites'));
  const body = clear.slice(0, clear.indexOf('\n}'));
  assert.doesNotMatch(body, /barEnabled/, 'clearing exceptions must not touch the master');
});

test('the popup switch defers to the master', () => {
  // With the master off the bar cannot appear anywhere, so a per-site switch that still
  // flips would promise something that never happens.
  assert.match(popupJs, /if \(!barEnabled\) return;/,
    'toggleBarSite must be inert while the master is off');
});
