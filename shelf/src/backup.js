/**
 * Shelf It — backup and restore. TRD §13.
 *
 * The pure half (serialise, parse, validate) is separated from the File System Access
 * half deliberately: the pure functions are tested in Node, and the browser half is
 * thin enough to read in one sitting.
 *
 * WHY THIS LIVES ON THE SHELF PAGE AND NOT IN THE WORKER
 *
 * Directory handles lose permission across browser restarts. Regaining it means
 * requestPermission(), which requires a user gesture — and a service worker can never
 * obtain one. A worker-driven backup would therefore work until the first restart and
 * then silently stop, which is the worst possible failure for a backup: it looks fine
 * and it is not running. So it runs when the shelf is opened, where a gesture exists.
 */

/** Bump if the file shape changes in a way a reader must branch on. */
export const BACKUP_VERSION = 1;
/**
 * TWO files, and the pair is the point (PRD principle 1: "plain JSON and readable HTML").
 *
 *   .json  machine-readable. Restores the library exactly, including the fields an
 *          export withholds. Useless to a person with a text editor.
 *   .html  human-readable. Opens in any browser, forever, with no Shelf It and no server.
 *
 * The JSON alone covers "I lost my laptop". It does not cover "Shelf It is gone" — and that
 * is the scenario this product was built in response to, since Pocket's users were left
 * holding exports of a service that no longer existed. A backup you cannot read without
 * the dead application is not an archive, it is a hostage.
 */
export const BACKUP_FILENAME = 'shelf-backup.json';
export const BACKUP_HTML_FILENAME = 'shelf-backup.html';

/** Back up if the last one is older than this. TRD §13. */
export const BACKUP_INTERVAL_MS = 12 * 60 * 60 * 1000;

/** How long someone may go with no backup at all before the warning escalates. PRD §12. */
export const NAG_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

/** Whether this browser can write to a folder at all. Safari is expected to say no. */
export function supportsDirectoryBackup() {
  return typeof globalThis.showDirectoryPicker === 'function';
}

/* ================================================================== *
 * Serialisation — pure
 * ================================================================== */

/**
 * A backup, unlike an export, is FULL FIDELITY. Every field is kept, including the ones
 * export.js deliberately withholds — context, urlHash, isPublic. The distinction is who
 * the file is for: an export is published to other people, a backup is the user's own
 * archive and must restore the library exactly.
 *
 * Deterministic for the same reason the export is, and one more: this file is meant to
 * live in a Dropbox or iCloud folder (PRD §9 sells that as the sync story). Rewriting
 * identical content with a fresh timestamp inside would trigger a sync every 12 hours
 * forever. The write is also skipped entirely when the bytes have not changed — see
 * writeBackup().
 *
 * @param {object[]} clips
 * @returns {string}
 */
export function buildBackupJson(clips) {
  const sorted = [...clips].sort((a, b) => (b.savedAt - a.savedAt) || (a.id < b.id ? -1 : 1));
  return JSON.stringify({ format: 'shelf-backup', version: BACKUP_VERSION, clips: sorted }, null, 2);
}

/**
 * Parse a backup file. Never throws on bad input — returns a reason instead, because the
 * caller is a person who just picked the wrong file and deserves to be told which.
 *
 * @param {string} text
 * @returns {{ok: true, clips: object[]} | {ok: false, error: string}}
 */
export function parseBackupJson(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return { ok: false, error: 'That file is not valid JSON.' };
  }
  if (!data || typeof data !== 'object') return { ok: false, error: 'That file is not a Shelf It backup.' };
  if (data.format !== 'shelf-backup') return { ok: false, error: 'That file is not a Shelf It backup.' };
  if (!Array.isArray(data.clips)) return { ok: false, error: 'That backup has no clips in it.' };
  if (data.version > BACKUP_VERSION) {
    return { ok: false, error: `That backup was written by a newer version of Shelf It (v${data.version}).` };
  }

  // Drop anything unusable rather than failing the whole restore. A backup with one bad
  // record should still return the other 1,499 clips.
  const clips = data.clips.filter((c) => c && typeof c.id === 'string' && typeof c.savedAt === 'number');
  return { ok: true, clips };
}

/* ================================================================== *
 * File System Access
 * ================================================================== */

/**
 * Does this folder name look like someone meant to name a file?
 *
 * "Choose a backup folder" plus a picker offering New Folder is a natural way to end up
 * with a directory called shelf-backup.json containing a shelf-backup.json. Nothing
 * breaks — but the result is confusing enough that the user will not trust it, and a
 * backup you do not trust is not doing its job.
 *
 * @param {string} name
 */
export function looksLikeAFilename(name) {
  return /\.(json|html|htm|txt|md|zip)$/i.test(String(name || ''));
}

/**
 * Ask for a folder. Must be called from a user gesture.
 * @returns {Promise<FileSystemDirectoryHandle|null>} null if the picker was dismissed
 */
export async function pickBackupDirectory() {
  try {
    return await globalThis.showDirectoryPicker({ id: 'shelf-backup', mode: 'readwrite' });
  } catch (err) {
    if (err?.name === 'AbortError') return null;   // dismissed; not an error
    throw err;
  }
}

/**
 * Do we still hold write access to this handle?
 *
 * queryPermission never prompts, so it is safe anywhere. requestPermission prompts and
 * therefore needs a gesture — which is why `interactive` is opt-in and the automatic
 * path never sets it.
 *
 * @param {FileSystemDirectoryHandle} handle
 * @param {boolean} interactive may we prompt?
 */
export async function hasWriteAccess(handle, interactive = false) {
  if (!handle?.queryPermission) return false;
  const opts = { mode: 'readwrite' };
  if (await handle.queryPermission(opts) === 'granted') return true;
  if (!interactive) return false;
  return await handle.requestPermission(opts) === 'granted';
}

/**
 * Write one file, skipping when the bytes are unchanged.
 *
 * The skip matters because the target is usually a synced folder. Writing identical
 * content every 12 hours would wake Dropbox, re-upload, and fill the version history to
 * say nothing new. It is also why neither file carries a timestamp inside it.
 *
 * @returns {Promise<boolean>} whether anything was actually written
 */
async function writeFile(handle, name, content) {
  const file = await handle.getFileHandle(name, { create: true });

  try {
    const existing = await (await file.getFile()).text();
    if (existing === content) return false;
  } catch {
    /* no existing file, or unreadable — fall through and write */
  }

  const stream = await file.createWritable();
  await stream.write(content);
  await stream.close();
  return true;
}

/**
 * Write the backup pair.
 *
 * @param {FileSystemDirectoryHandle} handle
 * @param {string} json  from buildBackupJson
 * @param {string} html  from buildExportHtml over the WHOLE library
 * @returns {Promise<{written: string[]}>} which files actually changed
 */
export async function writeBackup(handle, json, html) {
  const written = [];
  if (await writeFile(handle, BACKUP_FILENAME, json)) written.push(BACKUP_FILENAME);
  if (html && await writeFile(handle, BACKUP_HTML_FILENAME, html)) written.push(BACKUP_HTML_FILENAME);
  return { written };
}

/** Fallback for browsers with no directory access, and always available besides. */
export function downloadJson(json, filename = BACKUP_FILENAME) {
  const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
