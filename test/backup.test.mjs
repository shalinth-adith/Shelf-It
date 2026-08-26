/**
 * Backup and restore — TRD §13, and §16 check 11 (reimport into a fresh profile returns
 * every clip).
 *
 * Only the pure half is tested here; the File System Access half needs a browser and a
 * user gesture. That split is why backup.js keeps them apart.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BACKUP_VERSION, BACKUP_FILENAME, BACKUP_HTML_FILENAME, buildBackupJson, parseBackupJson,
  looksLikeAFilename,
} from '../shelf/src/backup.js';
import { buildExportHtml } from '../shelf/src/export.js';
import { readFileSync } from 'node:fs';

const clip = (over = {}) => ({
  id: 'id-1',
  text: 'A collection is not a hoard.',
  note: 'why it mattered',
  color: 'yellow',
  url: 'https://aeon.co/essays/x',
  canonicalUrl: 'https://aeon.co/essays/x',
  urlHash: 'abcd'.repeat(8),
  normalizeVersion: 1,
  domain: 'aeon.co',
  title: 'What we owe',
  context: { prefix: 'before', suffix: 'after' },
  seconds: null,
  savedAt: 1_787_000_000_000,
  isPublic: false,
  ...over,
});

/* ---------------------------------------------------------------- round trip */

test('a backup restores every clip byte for byte', () => {
  // TRD §16 check 11. A backup that loses a field is worse than no backup, because the
  // loss is only discovered at the moment it matters.
  const clips = [clip(), clip({ id: 'id-2', savedAt: 1_787_000_100_000 })];
  const parsed = parseBackupJson(buildBackupJson(clips));
  assert.equal(parsed.ok, true);
  assert.deepEqual(
    [...parsed.clips].sort((a, b) => a.id < b.id ? -1 : 1),
    [...clips].sort((a, b) => a.id < b.id ? -1 : 1)
  );
});

test('a backup keeps the fields an export deliberately drops', () => {
  // The distinction between the two files: an export goes to other people and withholds
  // context/urlHash/isPublic; a backup is the user's own archive and must be complete.
  const parsed = parseBackupJson(buildBackupJson([clip()]));
  const record = parsed.clips[0];
  assert.deepEqual(record.context, { prefix: 'before', suffix: 'after' });
  assert.equal(record.urlHash, 'abcd'.repeat(8));
  assert.equal(typeof record.isPublic, 'boolean');
  assert.equal(record.canonicalUrl, 'https://aeon.co/essays/x');
});

/* ---------------------------------------------------------------- determinism */

test('identical libraries produce identical files', () => {
  // The backup target is usually a Dropbox or iCloud folder — PRD §9 sells that as the
  // sync story. A file that differs every write would sync every 12 hours forever.
  const clips = [clip(), clip({ id: 'id-2', savedAt: 5 })];
  assert.equal(buildBackupJson(clips), buildBackupJson([...clips].reverse()));
});

test('the backup file contains no timestamp of its own', () => {
  assert.doesNotMatch(buildBackupJson([clip()]), /"(exportedAt|generatedAt|writtenAt)"/);
});

/* ---------------------------------------------------------------- bad input */

test('parse never throws, and says which problem it is', () => {
  const cases = [
    ['not json at all',                       /valid JSON/],
    ['{"format":"something-else"}',           /not a Shelf backup/],
    ['{"format":"shelf-backup"}',             /no clips/],
    ['[]',                                    /not a Shelf backup/],
    ['null',                                  /not a Shelf backup/],
  ];
  for (const [input, expected] of cases) {
    const result = parseBackupJson(input);
    assert.equal(result.ok, false, `expected failure for ${input}`);
    assert.match(result.error, expected);
  }
});

test('a newer backup version is refused, not silently half-read', () => {
  const future = JSON.stringify({ format: 'shelf-backup', version: BACKUP_VERSION + 1, clips: [] });
  const result = parseBackupJson(future);
  assert.equal(result.ok, false);
  assert.match(result.error, /newer version/);
});

test('one corrupt record does not lose the rest of the library', () => {
  // A 1,500-clip backup with a single bad row must still return 1,499 clips. Failing the
  // whole restore would turn a small corruption into total loss.
  const file = JSON.stringify({
    format: 'shelf-backup',
    version: BACKUP_VERSION,
    clips: [clip({ id: 'good-1' }), { id: 42 }, null, { savedAt: 'nope' }, clip({ id: 'good-2' })],
  });
  const result = parseBackupJson(file);
  assert.equal(result.ok, true);
  assert.deepEqual(result.clips.map((c) => c.id), ['good-1', 'good-2']);
});

test('an empty library backs up and restores cleanly', () => {
  const result = parseBackupJson(buildBackupJson([]));
  assert.equal(result.ok, true);
  assert.deepEqual(result.clips, []);
});

test('the file is human-readable', () => {
  // Principle 1 — your data outlives the product. Someone opening this in a text editor
  // ten years from now should be able to read it without tooling.
  const json = buildBackupJson([clip()]);
  assert.match(json, /\n  "clips": \[/, 'expected indentation');
  assert.ok(json.includes('A collection is not a hoard.'), 'text should be plainly visible');
});

/* ---------------------------------------------------------------- the pair */

test('the backup pair covers both failure modes', () => {
  // PRD principle 1: "plain JSON and readable HTML ... if this is abandoned tomorrow,
  // nothing is lost." The JSON alone only covers losing the machine. It does not cover
  // losing Shelf — which is exactly what happened to Pocket's users, and the reason this
  // product exists.
  assert.notEqual(BACKUP_FILENAME, BACKUP_HTML_FILENAME);
  assert.match(BACKUP_FILENAME, /\.json$/);
  assert.match(BACKUP_HTML_FILENAME, /\.html$/);
});

test('the readable copy is legible with no Shelf and no server', () => {
  const clips = [clip({ text: 'A collection is not a hoard.', note: 'stewardship' })];
  const html = buildExportHtml(clips, { title: 'Shelf — full archive' });

  // The passage, its note, its source and its date must all be visible as plain text or
  // reconstructible from the payload — not locked behind an app that may not exist.
  assert.ok(html.includes('A collection is not a hoard.'));
  assert.ok(html.includes('stewardship'));
  assert.ok(html.includes('aeon.co'));
  assert.match(html, /^<!doctype html>/);
  // and it must not need anything from the network to render
  assert.doesNotMatch(html, /\bfetch\s*\(|<link[^>]+href="https?:/);
});

test('the readable copy carries the whole library, not just marked clips', () => {
  // The share export defaults to isPublic only. The archive copy must not — a backup
  // that silently omits unmarked clips is worse than no backup.
  const clips = [clip({ id: 'a', isPublic: false }), clip({ id: 'b', isPublic: true })];
  const html = buildExportHtml(clips, { title: 'Shelf — full archive' });
  assert.match(html, /2 passages/);
});

test('a folder named like a file is recognised', () => {
  // "Choose a backup folder" plus a picker offering New Folder is a natural way to end
  // up with a directory called shelf-backup.json holding a shelf-backup.json. Nothing
  // breaks, but the result is confusing enough that the user stops trusting it — and a
  // backup you do not trust is not doing its job.
  for (const n of ['shelf-backup.json', 'notes.HTML', 'archive.zip', 'x.txt']) {
    assert.equal(looksLikeAFilename(n), true, n);
  }
  for (const n of ['Documents', 'Shelf backups', 'my.clips.folder', '', null]) {
    assert.equal(looksLikeAFilename(n), false, String(n));
  }
});

/* ------------------------------------------------------------------ *
 * One export
 * ------------------------------------------------------------------ */

test('exactly one control in the shelf page produces an export', () => {
  // The regression this guards against is additive and therefore easy: someone adds a
  // convenient "download everything" link, and now the user has to understand the
  // JSON/HTML distinction before they can get their own words out. It happened once
  // already — `Download readable copy` was `Export…` → everything under another name.
  //
  // Backup controls are exempt by design: a backup is not an export (D4). They are
  // identified by their `backup-` id prefix, which is also what groups them in the UI.
  // The export dialog's own confirm button is part of that one flow, not a rival entry
  // point, so the dialog is removed before counting.
  const html = readFileSync('shelf/src/shelf.html', 'utf8')
    .replace(/<dialog id="exportdlg">[\s\S]*?<\/dialog>/, '');
  const buttons = [...html.matchAll(/<button[^>]*id="([^"]+)"[^>]*>([^<]*)</g)]
    .map(([, id, label]) => ({ id, label: label.trim() }));

  const exporters = buttons.filter(
    (b) => /export|download/i.test(b.id + ' ' + b.label) && !b.id.startsWith('backup-')
  );
  assert.deepEqual(exporters.map((b) => b.id), ['export'],
    'the header Export… button must be the only export in the page');
});

test('the backup group never offers a second readable download', () => {
  // The readable HTML copy still exists — writeBackup() puts it in the backup folder
  // beside the JSON, which is the "Shelf no longer exists" case. What must not come back
  // is a BUTTON for it, duplicating the export.
  const html = readFileSync('shelf/src/shelf.html', 'utf8');
  assert.doesNotMatch(html, /id="backup-read"/,
    'a second HTML download has reappeared in the footer');
  assert.match(html, /id="backup-download"[^>]*>Download backup file</,
    'the JSON download must read as a backup, not an export');
});

test('the readable copy still travels with the folder backup', () => {
  // Deleting the button must not have deleted the file. This is the half of PRD
  // principle 1 that survives Shelf itself disappearing.
  const shelf = readFileSync('shelf/src/shelf.js', 'utf8');
  assert.match(shelf, /writeBackup\(handle, buildBackupJson\(state\.clips\), html\)/,
    'runBackup must still write the JSON and the HTML as a pair');
});
