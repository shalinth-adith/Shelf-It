/**
 * Shelf It — the library page.
 *
 * Reads IndexedDB directly (TRD §4); only writes that create clips go through the
 * worker. Note edits and deletes are written from here, because they originate here and
 * a round trip would buy nothing.
 *
 * Rendering is plain DOM construction, never innerHTML. Every string on this page came
 * off a web page — passage text, titles, domains — and building nodes means there is no
 * escaping step to forget. It also happens to be what makes search highlighting simple.
 */

import * as db from './db.js';
import { buildExportHtml, domainTally } from './export.js';
import {
  BACKUP_INTERVAL_MS,
  NAG_AFTER_MS,
  BACKUP_FILENAME,
  BACKUP_HTML_FILENAME,
  buildBackupJson,
  parseBackupJson,
  supportsDirectoryBackup,
  pickBackupDirectory,
  hasWriteAccess,
  writeBackup,
  downloadJson,
  looksLikeAFilename,
} from './backup.js';
import {
  dayKey,
  dayHeading,
  clockTime,
  relativeTime,
  relativePhrase,
  fullTimestamp,
  domainInitial,
  collapseWhitespace,
  toMarkdown,
} from './util.js';

const log = (...a) => console.debug('[shelf:page]', ...a);

/**
 * How long a deleted clip can be restored. D6.
 *
 * 20 seconds, not the 8 it started at. The record is removed from IndexedDB immediately
 * and held only in memory, so when this expires the clip is gone for good — and eight
 * seconds is not enough to click Remove, read the toast, decide, and reach for a
 * keyboard shortcut. An undo window that closes while you are still deciding is not an
 * undo, and this product's entire promise is not losing passages.
 */
const UNDO_MS = 20000;

/** TRD §5.1's five fixed values, plus unset. PRD §14 settled on fixed rather than custom. */
const COLORS = ['none', 'yellow', 'green', 'blue', 'pink', 'purple'];

const state = {
  clips: [],
  query: '',
  sort: 'newest',
  selected: new Set(),
};

/** The pending undo, if any. Holds the record itself — the DB no longer has it. */
let pendingUndo = null;
let undoTimer = 0;

const $ = (id) => document.getElementById(id);

/* ================================================================== *
 * Filtering — TRD §11
 *
 * Linear scan, AND-matching lowercase tokens. No index. At ~500 bytes per clip (D2
 * keeps it there) 5,000 clips is a couple of megabytes in memory and filters well
 * inside the 20ms budget. MiniSearch only if measurement says otherwise.
 * ================================================================== */

function tokens(query) {
  return collapseWhitespace(query).toLowerCase().split(' ').filter(Boolean);
}

function haystack(clip) {
  return (clip.text + ' ' + clip.note + ' ' + clip.title + ' ' + clip.domain).toLowerCase();
}

function filtered() {
  const terms = tokens(state.query);
  const out = state.clips.filter((clip) => {
    if (terms.length) {
      const hay = haystack(clip);
      if (!terms.every((t) => hay.includes(t))) return false;
    }
    return true;
  });

  if (state.sort === 'oldest') {
    out.sort((a, b) => a.savedAt - b.savedAt);
  } else {
    out.sort((a, b) => b.savedAt - a.savedAt);
  }
  return out;
}

/* ================================================================== *
 * D3 — what leads the row
 *
 * A clip with a selected passage leads with the passage; a page-save leads with its
 * title. Reconciles PRD §8.2 ("a list of sentences, not a list of links") with a canvas
 * drawn title-first. Both render at the same size and weight, so the row's rhythm is
 * identical either way and the list never looks ragged.
 * ================================================================== */

function hasPassage(clip) {
  return Boolean(clip.text && clip.text.trim());
}

function leadText(clip) {
  return hasPassage(clip) ? clip.text : clip.title || clip.domain || clip.url;
}

/* ================================================================== *
 * Rendering
 * ================================================================== */

/**
 * Text with search terms wrapped in <mark>, as a fragment.
 *
 * Built from nodes rather than an escaped HTML string. The input is page-derived, and
 * the version of this that interpolates into innerHTML is a cross-site scripting hole
 * on a page that can read the entire library.
 */
function marked(text, terms) {
  const frag = document.createDocumentFragment();
  if (!terms.length) {
    frag.append(document.createTextNode(text));
    return frag;
  }

  const lower = text.toLowerCase();
  // Collect every match span, then merge overlaps so two terms hitting the same
  // characters produce one mark rather than nested ones.
  const spans = [];
  for (const term of terms) {
    let i = lower.indexOf(term);
    while (i !== -1) {
      spans.push([i, i + term.length]);
      i = lower.indexOf(term, i + term.length);
    }
  }
  if (!spans.length) {
    frag.append(document.createTextNode(text));
    return frag;
  }
  spans.sort((a, b) => a[0] - b[0]);
  const merged = [spans[0]];
  for (const [s, e] of spans.slice(1)) {
    const last = merged[merged.length - 1];
    if (s <= last[1]) last[1] = Math.max(last[1], e);
    else merged.push([s, e]);
  }

  let cursor = 0;
  for (const [s, e] of merged) {
    if (s > cursor) frag.append(document.createTextNode(text.slice(cursor, s)));
    const m = document.createElement('mark');
    m.textContent = text.slice(s, e);
    frag.append(m);
    cursor = e;
  }
  if (cursor < text.length) frag.append(document.createTextNode(text.slice(cursor)));
  return frag;
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** Relative under a day, clock time beyond — the day heading already carries the date. */
function timeLabel(savedAt, now) {
  return now - savedAt < 86400000 ? relativeTime(savedAt, now) : clockTime(savedAt);
}

function renderClip(clip, terms, now) {
  const row = el('article', 'clip');
  row.dataset.id = clip.id;
  row.dataset.selected = state.selected.has(clip.id) ? 'true' : 'false';
  row.dataset.public = clip.isPublic ? 'true' : 'false';
  row.dataset.color = clip.color || '';

  // -- select
  const check = el('button', 'check', state.selected.has(clip.id) ? '✓' : '');
  check.type = 'button';
  check.title = 'Select';
  check.setAttribute('aria-pressed', String(state.selected.has(clip.id)));
  check.addEventListener('click', () => toggleSelect(clip.id));
  row.append(check);

  // -- body
  const body = el('div', 'body');

  const meta = el('div', 'meta');
  meta.append(el('span', 'avatar', domainInitial(clip.domain)));
  const dom = el('span', 'dom');
  dom.append(marked(clip.domain || 'local', terms));
  meta.append(dom, el('span', null, '·'));
  const time = el('span', null, timeLabel(clip.savedAt, now));
  time.title = fullTimestamp(clip.savedAt); // "when did I read this" always answerable
  meta.append(time);
  body.append(meta);

  // -- the lead (D3)
  const lead = el('a', hasPassage(clip) ? 'lead passage' : 'lead');
  lead.href = clip.url;
  lead.target = '_blank';
  lead.rel = 'noreferrer'; // no referrer leaves this machine
  lead.append(marked(leadText(clip), terms));
  body.append(lead);

  // When the passage leads, the title still has to be reachable — demoted, not dropped.
  if (hasPassage(clip) && clip.title) {
    const sub = el('a', 'subtitle');
    sub.href = clip.url;
    sub.target = '_blank';
    sub.rel = 'noreferrer';
    sub.append(marked(clip.title, terms));
    body.append(sub);
  }

  // -- note
  if (clip.note) {
    const note = el('div', 'note');
    note.append(el('span', 'note-label', 'Note'));
    const text = el('span', 'note-text');
    text.append(marked(clip.note, terms));
    text.title = 'Click to edit';
    text.addEventListener('click', () => editNote(row, clip));
    note.append(text);
    body.append(note);
  }

  // -- actions
  const actions = el('div', 'actions');
  const noteBtn = el('button', null, clip.note ? 'Edit note' : 'Add a note');
  noteBtn.type = 'button';
  noteBtn.addEventListener('click', () => editNote(row, clip));
  const share = el('button', null, clip.isPublic ? '✓ Shared' : 'Mark to share');
  share.type = 'button';
  share.dataset.on = String(Boolean(clip.isPublic));
  share.title = 'Include this clip when exporting a web page';
  share.addEventListener('click', () => toggleShare(clip));

  const copy = el('button', null, 'Copy');
  copy.type = 'button';
  copy.title = 'Copy the passage and its citation as Markdown';
  copy.addEventListener('click', () => copyMarkdown(clip, copy));

  const colourBtn = el('button', null, 'Colour');
  colourBtn.type = 'button';
  colourBtn.title = 'Colour-code this clip';
  colourBtn.addEventListener('click', () => toggleSwatches(actions, clip));

  const del = el('button', null, 'Remove');
  del.type = 'button';
  del.addEventListener('click', () => removeClips([clip.id]));
  actions.append(noteBtn, copy, colourBtn, share, del);
  body.append(actions);

  row.append(body);

  // -- letter avatar card (D2: never an image, never a fetched favicon)
  row.append(el('div', 'card', domainInitial(clip.domain)));
  return row;
}

/**
 * Inline note editor. Saves on blur and on Cmd/Ctrl+Enter, cancels on Escape.
 *
 * Blur-to-save rather than an explicit button: PRD principle 2 says saving costs
 * nothing, and a note the user typed and clicked away from is a note they meant to keep.
 */
function editNote(row, clip) {
  if (row.querySelector('.note-edit')) return;

  const area = el('textarea', 'note-edit');
  area.value = clip.note || '';
  area.placeholder = 'Why this mattered';

  const anchor = row.querySelector('.note') || row.querySelector('.actions');
  anchor.replaceWith(area);
  area.focus();
  area.setSelectionRange(area.value.length, area.value.length);

  let done = false;
  const commit = async (save) => {
    if (done) return;
    done = true;
    if (save) {
      const next = collapseWhitespace(area.value);
      if (next !== clip.note) {
        clip.note = next;
        await db.putClip(clip);
        log('note saved', clip.id);
      }
    }
    render();
  };

  area.addEventListener('blur', () => commit(true));
  area.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      commit(false);
    }
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      commit(true);
    }
  });
}

function render() {
  const t0 = performance.now();
  const list = filtered();
  const terms = tokens(state.query);
  const now = Date.now();

  const groups = $('groups');
  groups.replaceChildren();

  // Always chronological now. The canvas dropped title sort, and with it the one case
  // that abandoned day grouping.
  const buckets = new Map();
  for (const clip of list) {
    const key = dayKey(clip.savedAt);
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(clip);
  }

  const frag = document.createDocumentFragment();
  for (const [key, clips] of buckets) {
    const section = el('section', 'group');
    const col = el('div', 'daycol');

    const { weekday, date } = dayHeading(clips[0].savedAt);
    col.append(el('div', 'weekday', weekday), el('div', 'date', date));
    col.append(
      el('div', 'daycount', `${clips.length} ${clips.length === 1 ? 'save' : 'saves'}`)
    );

    const items = el('div', 'items');
    for (const clip of clips) items.append(renderClip(clip, terms, now));

    section.append(col, items);
    frag.append(section);
  }
  groups.append(frag);

  // -- summary and states
  const sites = new Set(state.clips.map((c) => c.domain).filter(Boolean)).size;
  const shown = list.length;
  $('summary').textContent =
    state.clips.length === 0
      ? 'Nothing saved yet'
      : `${shown} ${shown === 1 ? 'save' : 'saves'} · ${sites} ${sites === 1 ? 'site' : 'sites'} · kept in this browser`;

  const filtering = Boolean(state.query);
  $('empty').hidden = shown !== 0;
  if (shown === 0) {
    $('empty-title').textContent = filtering ? 'Nothing matches' : 'Nothing here yet';
    $('empty-body').textContent = filtering
      ? 'Nothing matches that search. Clear it to see everything.'
      : 'Select text on any page and save it. It will appear here.';
  }

  const n = state.selected.size;
  $('selbar').hidden = n === 0;
  $('selcount').textContent = `${n} selected`;

  log(`rendered ${shown} clips in ${(performance.now() - t0).toFixed(1)}ms`);
}

/* ================================================================== *
 * Mutations
 * ================================================================== */

function toggleSelect(id) {
  if (state.selected.has(id)) state.selected.delete(id);
  else state.selected.add(id);
  render();
}

/**
 * Delete, reversibly. D6 and TRD §16 check 7.
 *
 * The records are held in memory while the undo is live, because the store no longer
 * has them. Deleting from the DB immediately (rather than deferring until the toast
 * expires) means a crash or a closed tab mid-undo leaves the library in the state the
 * user asked for, not a half-state.
 */
async function removeClips(ids) {
  const removed = state.clips.filter((c) => ids.includes(c.id));
  if (!removed.length) return;

  state.clips = state.clips.filter((c) => !ids.includes(c.id));
  for (const id of ids) state.selected.delete(id);
  await Promise.all(ids.map((id) => db.deleteClip(id)));
  render();

  pendingUndo = removed;
  // Naming the shortcut is the only way anyone learns it exists — there is nowhere else
  // in the product it could be discovered.
  $('undo-text').textContent =
    removed.length === 1 ? 'Clip removed' : `${removed.length} clips removed`;
  $('undo').hidden = false;

  clearTimeout(undoTimer);
  undoTimer = setTimeout(dismissUndo, UNDO_MS);
}

async function undo() {
  if (!pendingUndo) return;
  const restore = pendingUndo;
  dismissUndo();
  await Promise.all(restore.map((clip) => db.putClip(clip)));
  state.clips = state.clips.concat(restore);
  log('restored', restore.length);
  render();
}

function dismissUndo() {
  clearTimeout(undoTimer);
  pendingUndo = null;
  $('undo').hidden = true;
}

/**
 * Flip a clip's share flag. PRD §8.4 — "mark clips to share individually, then export."
 *
 * Persisted rather than transient, so a shareable set can be built up over days. It is
 * also why isPublic defaults to false on every save: inclusion in an export is opt-in,
 * one clip at a time, and there is no gesture anywhere that marks everything at once.
 */
/**
 * Mark every selected clip for sharing.
 *
 * The circles and the per-row "Mark to share" link are two different selection ideas —
 * one transient and for deleting, one persistent and for exporting — and someone who
 * wants to share ten clips will reach for the circles first. This connects them without
 * making selection *be* the export scope, which would make the scope vanish on reload.
 *
 * Marks rather than toggles: a mixed selection should end up all-marked, which is what
 * "mark these" means. Unmarking is per row, where the consequence is visible.
 */
async function markSelected() {
  const ids = [...state.selected];
  const clips = state.clips.filter((c) => ids.includes(c.id) && !c.isPublic);
  for (const clip of clips) {
    clip.isPublic = true;
    await db.putClip(clip);
  }
  log('marked', clips.length, 'of', ids.length, 'selected');
  state.selected.clear();
  render();
}

async function toggleShare(clip) {
  clip.isPublic = !clip.isPublic;
  await db.putClip(clip);
  log('share', clip.id, clip.isPublic);
  render();
}

/**
 * Reveal the swatch row inline. PRD U9.
 *
 * Hidden until asked for. Five permanent swatches on every row would be five pieces of
 * chrome per clip on a page whose whole argument is that the passage is the content —
 * and the design was just simplified by removing two header controls, not by adding
 * thirty more per screen.
 */
function toggleSwatches(actions, clip) {
  const open = actions.querySelector('.swatches');
  if (open) {
    open.remove();
    return;
  }

  const row = el('div', 'swatches');
  for (const colour of COLORS) {
    const value = colour === 'none' ? '' : colour;
    const swatch = el('button', 'swatch');
    swatch.type = 'button';
    swatch.dataset.color = colour;
    swatch.title = colour === 'none' ? 'No colour' : colour;
    swatch.setAttribute('aria-label', colour === 'none' ? 'No colour' : colour);
    swatch.setAttribute('aria-pressed', String((clip.color || '') === value));
    swatch.addEventListener('click', () => setColour(clip, value));
    row.append(swatch);
  }
  actions.append(row);
}

async function setColour(clip, colour) {
  clip.color = colour;
  await db.putClip(clip);
  log('colour', clip.id, colour || 'none');
  render();
}

/**
 * Copy a clip as Markdown. PRD U13.
 *
 * Confirms in the button itself rather than the undo toast — a copy is not undoable and
 * borrowing that toast would teach the wrong thing about what it means.
 */
async function copyMarkdown(clip, button) {
  const label = button.textContent;
  try {
    await navigator.clipboard.writeText(toMarkdown(clip));
    button.textContent = 'Copied';
  } catch (err) {
    // Clipboard access can be refused; saying so beats a button that appears to do
    // nothing.
    console.error('[shelf:page] copy failed', err);
    button.textContent = 'Copy failed';
  }
  setTimeout(() => {
    button.textContent = label;
  }, 1400);
}

/* ================================================================== *
 * Export — TRD §12, PRD §8.4
 *
 * PRD calls an accidentally published reading history the worst outcome available in
 * this product, and calls the confirmation a safety mechanism rather than a formality.
 * Three things enforce that here:
 *   - "Marked to share" is preselected, always. Full-corpus is never the default.
 *   - Choosing everything reveals a count and a per-site tally BEFORE the export runs,
 *     so the domains are visible at the moment of the decision.
 *   - Marked-with-nothing-marked disables the button instead of quietly exporting zero.
 * ================================================================== */

function openExport() {
  const dlg = $('exportdlg');
  const marked = state.clips.filter((c) => c.isPublic);
  const all = state.clips;

  const phrase = (n) => `${n} ${n === 1 ? 'passage' : 'passages'}`;
  const sitesOf = (list) => {
    const n = domainTally(list).length;
    return `${n} ${n === 1 ? 'site' : 'sites'}`;
  };

  $('scope-marked-detail').textContent = marked.length
    ? `${phrase(marked.length)} from ${sitesOf(marked)}`
    : 'Nothing marked yet — use "Mark to share" on a clip, ' +
      'or select several with the circles and mark them together';
  $('scope-all-detail').textContent = `${phrase(all.length)} from ${sitesOf(all)}`;

  dlg.querySelector('input[value="marked"]').checked = true;
  updateScope();
  dlg.showModal();
}

function currentScope() {
  return $('exportdlg').querySelector('input[name="scope"]:checked')?.value ?? 'marked';
}

function updateScope() {
  const scope = currentScope();
  const list = scope === 'all' ? state.clips : state.clips.filter((c) => c.isPublic);

  const warn = $('scope-warn');
  warn.hidden = scope !== 'all';
  if (scope === 'all') {
    // The tally is the point. A bare count says "142 clips"; the domains are what tell
    // someone they are about to publish where they have been reading.
    const tally = domainTally(list);
    const shown = tally
      .slice(0, 8)
      .map(([d, n]) => `${d} (${n})`)
      .join(', ');
    const rest = tally.length > 8 ? `, and ${tally.length - 8} more` : '';
    $('tally').textContent = tally.length
      ? `${list.length} passages from ${tally.length} sites: ${shown}${rest}.`
      : 'Nothing to export.';
  }
  // The label names the act at the moment of the act. "Export" reads the same whether
  // you are publishing two chosen passages or your entire reading history; "Export
  // everything" cannot be clicked without reading what it does. PRD §8.4 calls this a
  // safety mechanism, and a safety mechanism that reads identically in the safe and
  // unsafe case is not one.
  $('dlg-go').textContent = scope === 'all' ? 'Export everything' : 'Export marked';
  $('dlg-go').disabled = list.length === 0;
}

function runExport() {
  const scope = currentScope();
  const list = scope === 'all' ? state.clips : state.clips.filter((c) => c.isPublic);
  if (!list.length) return;

  const html = buildExportHtml(list, { title: 'Shelf It' });
  // A Blob URL, not a data: URL — a data: URL of a large library can exceed what the
  // browser will accept in an href, and fails by doing nothing.
  const blob = new Blob([html], { type: 'text/html' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = scope === 'all' ? 'shelf-everything.html' : 'shelf.html';
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
  log('exported', list.length, 'clips, scope', scope);
}

/* ================================================================== *
 * Backup — TRD §13, PRD §9 and §12
 * ================================================================== */

/**
 * Automatic backup on shelf open.
 *
 * Runs here rather than in the worker because a directory handle loses permission across
 * browser restarts, and regaining it needs a user gesture the worker can never have. A
 * worker-driven backup would work until the first restart and then stop silently — which
 * is the worst failure a backup can have, because it still looks configured.
 *
 * Never prompts. If the handle went stale, this is a no-op and the footer says so; the
 * user reconnects it with a click, which is a gesture.
 */
async function autoBackup() {
  const handle = await db.getMeta('backupDir');
  if (!handle) return;

  const last = (await db.getMeta('lastBackupAt')) ?? 0;
  if (Date.now() - last < BACKUP_INTERVAL_MS) return;

  if (!(await hasWriteAccess(handle, false))) {
    log('backup handle needs re-permission — waiting for a gesture');
    return;
  }
  await runBackup(handle, 'auto');
}

async function runBackup(handle, why) {
  try {
    // The pair, not just the JSON. PRD principle 1 — the JSON covers "I lost my laptop",
    // the HTML covers "Shelf It no longer exists", and only the second is the scenario this
    // product was built in response to.
    const html = buildExportHtml(state.clips, {
      title: 'Shelf It — full archive',
      footerNote:
        `A complete copy of the library, readable without Shelf It. ` +
        `${BACKUP_FILENAME} beside it restores everything back into the extension.`,
    });
    const { written } = await writeBackup(handle, buildBackupJson(state.clips), html);
    await db.setMeta('lastBackupAt', Date.now());
    log(`backup (${why}):`, written.length ? written.join(', ') : 'unchanged, skipped');
    await renderBackupStatus();
    return true;
  } catch (err) {
    console.error('[shelf:page] backup failed', err);
    $('backup-status').textContent = 'Backup failed: ' + (err?.message ?? err);
    return false;
  }
}

async function chooseBackupFolder() {
  if (!supportsDirectoryBackup()) {
    // TRD §13 — say so plainly rather than offering a control that cannot work.
    $('backup-status').textContent =
      'This browser cannot write to a folder. Use Download backup file and keep it somewhere safe.';
    return;
  }
  const handle = await pickBackupDirectory();
  if (!handle) return; // dismissed
  // Structured-cloneable, so it persists in IndexedDB across restarts (TRD §5.2).
  await db.setMeta('backupDir', handle);
  await runBackup(handle, 'first');
}

async function backupNow() {
  const handle = await db.getMeta('backupDir');
  if (!handle) return chooseBackupFolder();
  // This IS a gesture, so unlike autoBackup it may prompt to reconnect a stale handle.
  if (!(await hasWriteAccess(handle, true))) {
    $('backup-status').textContent = 'Backup folder access was declined.';
    return;
  }
  await runBackup(handle, 'manual');
}

async function restoreFromFile(file) {
  const result = parseBackupJson(await file.text());
  if (!result.ok) {
    $('backup-status').textContent = result.error;
    return;
  }

  // put, not add — restoring over an existing library merges by id rather than throwing
  // on the first clip that is already there. Restoring the same backup twice is a no-op,
  // which is the behaviour someone unsure whether it worked will rely on.
  let restored = 0;
  for (const clip of result.clips) {
    await db.putClip(clip);
    restored++;
  }
  state.clips = await db.getAllClips();
  log('restored', restored);
  $('backup-status').textContent =
    `Restored ${restored} ${restored === 1 ? 'clip' : 'clips'}.`;
  render();
}

/**
 * How to name the backup target.
 *
 * A directory handle's `name` is the folder. If a FILE handle ever ends up stored here
 * the message would name a file and read as though Shelf It were writing into it, so the
 * kind is checked rather than assumed — the footer is the only place a user would ever
 * notice the backup target is wrong.
 */
function where(handle) {
  if (!handle?.name) return 'the chosen folder';
  return handle.kind === 'directory' ? `the "${handle.name}" folder` : `"${handle.name}"`;
}

/** Nudge, not an error — the backup is working, it is just confusingly placed. */
function folderNameHint(handle) {
  return handle && looksLikeAFilename(handle.name)
    ? ` That folder is named like a file, so you now have ${handle.name}/${BACKUP_FILENAME}.` +
        ' Harmless, but "Change backup folder" will tidy it.'
    : '';
}

async function renderBackupStatus() {
  const handle = await db.getMeta('backupDir');
  const last = (await db.getMeta('lastBackupAt')) ?? 0;
  const installed = (await db.getMeta('installedAt')) ?? Date.now();
  const status = $('backup-status');

  $('backup-now').disabled = false;
  $('backup-choose').textContent = handle ? 'Change backup folder' : 'Choose backup folder';

  if (handle) {
    const live = await hasWriteAccess(handle, false);
    status.textContent = !live
      ? `Backup folder "${handle.name}" needs reconnecting — click Back up now.`
      : last
        ? `Backed up ${relativePhrase(last, Date.now())} to ${where(handle)} — ` +
          `${BACKUP_FILENAME} to restore, ${BACKUP_HTML_FILENAME} to read.` +
          folderNameHint(handle)
        : `Backup folder ${where(handle)} is set. Nothing written yet.`;
  } else if (!supportsDirectoryBackup()) {
    status.textContent =
      'This browser cannot write to a folder. Use Download backup file regularly instead.';
  } else {
    status.textContent =
      'No backup folder set — pick any folder and Shelf It writes two files into it. ' +
      'Lose this machine without one and the clips go with it.';
  }

  // The escalating warning. PRD §12 rates machine-loss-without-backup High, and the
  // mitigation is that this gets harder to ignore rather than appearing once and going
  // away. It disappears entirely once a folder is set — nagging someone who already did
  // the thing is how a warning gets trained out.
  const banner = $('nobackup');
  const overdue = Date.now() - installed > NAG_AFTER_MS;
  banner.hidden = Boolean(handle) || state.clips.length === 0;
  banner.dataset.level = overdue ? 'urgent' : 'calm';
  $('nobackup-title').textContent = overdue
    ? `${state.clips.length} clips, still no backup`
    : 'No backup yet';
  $('nobackup-body').textContent = overdue
    ? 'A week of saving with nothing outside this browser. Point Shelf It at a Dropbox or iCloud folder and it backs itself up — that also gets you sync between machines.'
    : 'Your clips live only in this browser. Point Shelf It at a folder and it keeps a copy for you.';
}

/* ================================================================== *
 * The save bar
 *
 * The master switch, plus the undo for the popup's per-site switches. Both settings live
 * in storage.local and are read by content.js directly, so a write here reaches every
 * open tab through storage.onChanged — no reload, no message to the worker.
 * ================================================================== */

let barEnabled = true;
let barOffSites = [];

async function initBarSwitch() {
  try {
    const stored = await chrome.storage.local.get(['barEnabled', 'barOffSites']);
    barEnabled = stored.barEnabled !== false;
    barOffSites = Array.isArray(stored.barOffSites) ? stored.barOffSites : [];
  } catch {
    /* both defaults are already correct */
  }
  renderBarSwitch();
}

/** "youtube.com", "youtube.com and 1 other", "youtube.com and 4 others". */
function siteList(sites) {
  const [first, ...rest] = sites;
  if (!rest.length) return first;
  return rest.length === 1 ? `${first} and 1 other` : `${first} and ${rest.length} others`;
}

function renderBarSwitch() {
  $('bar-master').setAttribute('aria-checked', String(barEnabled));
  $('bar-master-note').textContent = barEnabled
    ? 'Appears when you select text on a site you have allowed.'
    : 'Off everywhere. Right-click → Save selection to Shelf It still works.';

  // Hidden while the master is off: per-site exceptions to a thing that is off
  // everywhere are noise, and reading them as live settings would be wrong.
  const hasExceptions = barEnabled && barOffSites.length > 0;
  $('bar-sites-line').hidden = !hasExceptions;
  if (hasExceptions) $('bar-sites').textContent = `Off on ${siteList(barOffSites)}`;
}

/**
 * @param {object} patch  the storage keys to write
 * @param {function} apply  applies the same change to module state
 */
async function writeBarSetting(patch, apply) {
  const previous = { barEnabled, barOffSites };
  apply();
  renderBarSwitch();     // painted first; a switch that waits on storage feels broken
  try {
    await chrome.storage.local.set(patch);
    log('save bar', barEnabled ? 'on' : 'off', `— ${barOffSites.length} site(s) excepted`);
  } catch (err) {
    // Nothing persisted, so the control is now lying about the state. Put it back.
    log('save bar setting failed', err?.message);
    ({ barEnabled, barOffSites } = previous);
    renderBarSwitch();
  }
}

function toggleBarMaster() {
  const next = !barEnabled;
  writeBarSetting({ barEnabled: next }, () => { barEnabled = next; });
}

/**
 * Clears every per-site exception. Deliberately does NOT touch the master — the two are
 * separate settings and folding them together would surprise whoever turned the master
 * off on purpose.
 */
function clearBarOffSites() {
  writeBarSetting({ barOffSites: [] }, () => { barOffSites = []; });
}

/**
 * The popup writes the same two keys, and it can be used while this tab sits open behind
 * it. Without this the footer keeps claiming the bar is on everywhere after the user has
 * just switched it off on a site.
 */
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if ('barEnabled' in changes) barEnabled = changes.barEnabled.newValue !== false;
  if ('barOffSites' in changes) {
    const next = changes.barOffSites.newValue;
    barOffSites = Array.isArray(next) ? next : [];
  }
  if ('barEnabled' in changes || 'barOffSites' in changes) renderBarSwitch();
});

/* ================================================================== *
 * Theme
 * ================================================================== */

async function initTheme() {
  let theme = 'light';
  try {
    const stored = await chrome.storage.local.get('theme');
    theme =
      stored.theme ||
      (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  } catch {
    /* storage unavailable; light is a safe default */
  }
  applyTheme(theme);
}

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  $('theme').textContent = theme === 'dark' ? '☾' : '☀';
}

async function toggleTheme() {
  const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  applyTheme(next);
  // storage.local, not localStorage — the popup and onboarding read it too (TRD §5.3).
  try {
    await chrome.storage.local.set({ theme: next });
  } catch {
    /* non-fatal */
  }
}

/* ================================================================== *
 * Wiring
 * ================================================================== */

function bind() {
  $('q').addEventListener('input', (e) => {
    state.query = e.target.value;
    render();
  });
  for (const btn of document.querySelectorAll('.sort button')) {
    btn.addEventListener('click', () => {
      state.sort = btn.dataset.sort;
      for (const b of document.querySelectorAll('.sort button')) {
        b.setAttribute('aria-pressed', String(b === btn));
      }
      render();
    });
  }

  $('theme').addEventListener('click', toggleTheme);
  $('bar-master').addEventListener('click', toggleBarMaster);
  $('bar-sites-clear').addEventListener('click', clearBarOffSites);
  $('export').addEventListener('click', openExport);
  $('backup-choose').addEventListener('click', chooseBackupFolder);
  $('nobackup-setup').addEventListener('click', chooseBackupFolder);
  $('backup-now').addEventListener('click', backupNow);
  $('backup-download').addEventListener('click', () =>
    downloadJson(buildBackupJson(state.clips))
  );
  $('backup-restore').addEventListener('click', () => $('restore-input').click());
  $('restore-input').addEventListener('change', (e) => {
    const file = e.target.files?.[0];
    if (file) restoreFromFile(file);
    e.target.value = ''; // so picking the same file twice fires again
  });
  for (const radio of $('exportdlg').querySelectorAll('input[name="scope"]')) {
    radio.addEventListener('change', updateScope);
  }
  $('exportdlg').addEventListener('close', () => {
    if ($('exportdlg').returnValue === 'go') runExport();
  });
  $('undo-btn').addEventListener('click', undo);
  $('clearsel').addEventListener('click', () => {
    state.selected.clear();
    render();
  });
  $('marksel').addEventListener('click', markSelected);
  $('delsel').addEventListener('click', () => removeClips([...state.selected]));

  document.addEventListener('keydown', (e) => {
    // (e.key || '') — key is undefined for some synthetic and IME events, and calling a
    // string method on undefined throws from inside a keydown handler, which kills every
    // shortcut on the page for the rest of the session.
    const key = (e.key || '').toLowerCase();
    const typing = /^(INPUT|TEXTAREA)$/.test(document.activeElement?.tagName ?? '');

    if (key === '/' && !typing) {
      e.preventDefault();
      $('q').focus();
    }

    if (key === 'escape' && document.activeElement === $('q')) {
      state.query = '';
      $('q').value = '';
      $('q').blur();
      render();
    }

    // Case-insensitive: with Caps Lock on, e.key is 'Z' and a strict === 'z' silently
    // never matches, so the shortcut simply stops existing with nothing to explain why.
    // Shift+Cmd+Z is redo elsewhere, so it is excluded.
    if ((e.metaKey || e.ctrlKey) && !e.shiftKey && key === 'z') {
      // Logged unconditionally, so "the shortcut does not work" can be told apart from
      // "there was nothing to undo" without guessing.
      log('undo shortcut pressed —', pendingUndo ? 'restoring' : 'nothing pending');
      if (pendingUndo) {
        e.preventDefault();
        undo();
      }
    }
  });
}

async function main() {
  bind();
  await initTheme();
  await initBarSwitch();
  const t0 = performance.now();
  state.clips = await db.getAllClips();
  log(`loaded ${state.clips.length} clips in ${(performance.now() - t0).toFixed(1)}ms`);
  render();
  await renderBackupStatus();
  autoBackup(); // deliberately not awaited — never delay first paint for it
}

main();
