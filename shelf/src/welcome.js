/**
 * Shelf — first run. PRD §9.
 *
 * Four screens, and only one of them is load-bearing.
 *
 * PRD §9 calls screen 2 "the most important screen" and requires that it is "not
 * skippable without either configuring a backup or explicitly dismissing a 'you have no
 * backup' warning." Both of the two things most likely to cause angry churn are
 * expectation failures, and this screen is where the expectation gets set.
 *
 * So "Not now" does not advance. It reveals a confirmation with a checkbox that must be
 * ticked before the continue button enables. That is deliberately more work than
 * clicking Next — a warning you can dismiss with the same gesture as agreement is not a
 * warning.
 */

import * as db from './db.js';
import { buildBackupJson } from './backup.js';
import { buildExportHtml } from './export.js';
import {
  supportsDirectoryBackup, pickBackupDirectory, writeBackup,
  BACKUP_FILENAME, BACKUP_HTML_FILENAME,
} from './backup.js';
import { normalizeUrl, urlHash, NORMALIZE_VERSION } from './util.js';

const log = (...a) => console.debug('[shelf:welcome]', ...a);
const $ = (id) => document.getElementById(id);
const SCREENS = 4;

let screen = 1;

function paintDots() {
  const dots = $('dots');
  dots.replaceChildren();
  for (let i = 1; i <= SCREENS; i++) {
    const dot = document.createElement('i');
    dot.dataset.on = String(i <= screen);
    dots.append(dot);
  }
}

function go(n) {
  screen = n;
  for (const s of document.querySelectorAll('section')) {
    s.hidden = Number(s.dataset.screen) !== n;
  }
  paintDots();
  window.scrollTo({ top: 0 });
  if (n === SCREENS) saveFirstClip();
}

/* ---------------------------------------------------------------- screen 2 */

async function chooseFolder() {
  if (!supportsDirectoryBackup()) {
    // Expected on Safari. Say so rather than leaving a button that cannot work.
    $('backup-status').textContent =
      'This browser cannot write to a folder. Use "Download backup file" on the shelf instead, and keep it somewhere safe.';
    revealConfirm();
    return;
  }
  try {
    const handle = await pickBackupDirectory();
    if (!handle) return;                     // dismissed the picker
    await db.setMeta('backupDir', handle);

    const clips = await db.getAllClips();
    await writeBackup(handle, buildBackupJson(clips),
      buildExportHtml(clips, { title: 'Shelf — full archive' }));
    await db.setMeta('lastBackupAt', Date.now());

    $('backup-status').textContent =
      `Backing up to "${handle.name}" — ${BACKUP_FILENAME} to restore, ${BACKUP_HTML_FILENAME} to read.`;
    $('confirm').hidden = true;              // the requirement is satisfied
    log('backup configured');
    setTimeout(() => go(3), 700);
  } catch (err) {
    console.error('[shelf:welcome] backup setup failed', err);
    $('backup-status').textContent = 'Could not set that folder up. Try another one.';
  }
}

function revealConfirm() {
  $('confirm').hidden = false;
  $('accept').focus();
}

/* ---------------------------------------------------------------- screen 4 */

/**
 * Save this page as the first clip, so the shelf is not empty on arrival (PRD §9.4).
 *
 * Written directly rather than through the worker: the worker's buildClip reads the
 * active tab, and this is an extension page with no tab of its own. Everything else about
 * the record matches what buildClip produces, including normalizeVersion.
 */
async function saveFirstClip() {
  const done = await db.getMeta('firstClipSaved');
  if (done) return;

  // This page, per PRD §9.4 — and it must be this page rather than anything remote.
  // A first clip pointing at a URL on the internet would be a link this product cannot
  // guarantee still resolves, in a product whose entire promise is that nothing depends
  // on something else staying alive. Clicking it reopens onboarding, which is also the
  // only way back to these screens.
  const url = chrome.runtime.getURL('src/welcome.html');
  const canonicalUrl = normalizeUrl(url);
  await db.addClip({
    id: crypto.randomUUID(),
    text: 'Keep every passage worth keeping — on your own machine.',
    note: 'Your first clip. Remove it whenever you like.',
    color: 'yellow',
    url,
    canonicalUrl,
    urlHash: await urlHash(canonicalUrl),
    normalizeVersion: NORMALIZE_VERSION,
    domain: 'shelf',
    title: 'Welcome to Shelf',
    context: { prefix: '', suffix: '' },
    seconds: null,
    savedAt: Date.now(),
    isPublic: false,
  });
  await db.setMeta('firstClipSaved', true);
  $('first-clip').textContent = 'Your shelf already has one clip in it.';
  log('first clip written');
}

/* ---------------------------------------------------------------- wiring */

async function init() {
  try {
    const { theme } = await chrome.storage.local.get('theme');
    document.documentElement.dataset.theme = theme
      || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  } catch { /* light is fine */ }

  // Show the shortcuts the user actually has, not the ones we suggested — Chrome drops
  // a suggested key that collides with something else, and printing the wrong one
  // teaches a shortcut that does nothing.
  try {
    for (const cmd of await chrome.commands.getAll()) {
      if (cmd.name === 'open-shelf' && cmd.shortcut) $('k-shelf').textContent = cmd.shortcut;
      if (cmd.name === 'save-page' && cmd.shortcut) $('k-save').textContent = cmd.shortcut;
    }
  } catch { /* keep the suggested defaults */ }

  paintDots();
}

for (const btn of document.querySelectorAll('[data-next]')) {
  btn.addEventListener('click', () => go(screen + 1));
}
$('pick').addEventListener('click', chooseFolder);
$('skip-backup').addEventListener('click', revealConfirm);
$('accept').addEventListener('change', (e) => { $('confirm-next').disabled = !e.target.checked; });
$('confirm-next').addEventListener('click', async () => {
  // Recorded, so the shelf's escalating warning knows this was a considered choice
  // rather than a screen never reached.
  await db.setMeta('backupDeclinedAt', Date.now());
  go(3);
});
$('done').addEventListener('click', () => {
  location.href = chrome.runtime.getURL('src/shelf.html');
});

init();
