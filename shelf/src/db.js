/**
 * Shelf It — IndexedDB wrapper.
 *
 * The only module that talks to IndexedDB. Imported by the service worker (which owns
 * every write) and by the shelf page (which reads directly). content.js never imports
 * this — it is a classic script and goes through the message protocol instead. (TRD §4)
 *
 * Schema is TRD §5. Connection lifetime is TRD §10: MV3 terminates the worker after ~30s
 * idle, so the cached handle can go stale between calls. See openDb() and withDb().
 */

export const DB_NAME = 'shelf';
export const DB_VERSION = 1;

const CLIPS = 'clips';
const META = 'meta';

const log = (...args) => console.debug('[shelf:db]', ...args);

/* ------------------------------------------------------------------ *
 * Connection
 * ------------------------------------------------------------------ */

/**
 * Cached open-connection promise. Nulled whenever the handle stops being usable, so the
 * next caller reopens rather than throwing on a dead handle.
 * @type {Promise<IDBDatabase> | null}
 */
let dbPromise = null;

/** Drop the cached connection. Next openDb() reopens. */
function invalidate(why) {
  if (dbPromise) log('connection invalidated:', why);
  dbPromise = null;
}

/**
 * Open (or reuse) the database.
 *
 * TRD §10 — the handle must be released on two events or a later transaction throws:
 *   onclose         the browser closed it out from under us (eviction, worker teardown)
 *   onversionchange another context is upgrading; we must close or we block it
 *
 * @returns {Promise<IDBDatabase>}
 */
export function openDb() {
  if (dbPromise) return dbPromise;

  log('opening', DB_NAME, 'v' + DB_VERSION);
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = (event) => {
      log('upgrade', event.oldVersion, '->', event.newVersion);
      migrate(req.result, event.oldVersion);
    };

    req.onsuccess = () => {
      const db = req.result;
      db.onclose = () => invalidate('onclose');
      db.onversionchange = () => {
        invalidate('onversionchange');
        db.close();
      };
      log('open ok');
      resolve(db);
    };

    req.onerror = () => {
      invalidate('open failed');
      reject(req.error);
    };

    // Another tab holds an older version open and is blocking the upgrade. Surfaces as a
    // hang otherwise, which is far harder to diagnose than a log line.
    req.onblocked = () => log('open BLOCKED — another context holds an older version open');
  });

  return dbPromise;
}

/** Close the cached connection. For diagnostics and tests; normal code never needs it. */
export async function closeDb() {
  if (!dbPromise) return;
  const db = await dbPromise.catch(() => null);
  invalidate('closeDb()');
  db?.close();
}

/**
 * Schema migrations, keyed on the version being upgraded FROM.
 *
 * Each version gets its own `if (oldVersion < n)` block and they run in order, so a
 * profile at v1 upgrading to v3 replays 2 and 3. Never edit a shipped block — add a new
 * one. Bumping DB_VERSION without a matching block is a silent no-op.
 *
 * @param {IDBDatabase} db
 * @param {number} oldVersion 0 on first install
 */
function migrate(db, oldVersion) {
  if (oldVersion < 1) {
    // TRD §5.1 — one record per saved passage.
    const clips = db.createObjectStore(CLIPS, { keyPath: 'id' });
    clips.createIndex('savedAt', 'savedAt');   // day grouping, reverse-chronological order
    clips.createIndex('urlHash', 'urlHash');   // "how many clips from this page"

    // TRD §5.2 — { key, value }. Holds installedAt, backupDir (a structured-cloneable
    // FileSystemDirectoryHandle), lastBackupAt.
    db.createObjectStore(META, { keyPath: 'key' });

    log('created stores:', CLIPS, META);
  }
}

/* ------------------------------------------------------------------ *
 * Transaction plumbing
 * ------------------------------------------------------------------ */

/** Promisify one IDBRequest. */
function request(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** Resolve when the transaction commits — i.e. when the write is actually durable. */
function committed(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new DOMException('Transaction aborted', 'AbortError'));
  });
}

/**
 * Run `work` inside a transaction, retrying once on a stale handle.
 *
 * The retry is the TRD §10 mitigation. If the worker was torn down and respawned, the
 * cached IDBDatabase can be dead without onclose having fired; db.transaction() then
 * throws InvalidStateError synchronously. Reopening and retrying once turns that into a
 * non-event. A second failure is real and propagates.
 *
 * @param {string|string[]} stores
 * @param {IDBTransactionMode} mode
 * @param {(tx: IDBTransaction) => Promise<any>} work
 */
async function withDb(stores, mode, work) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const db = await openDb();
    let tx;
    try {
      tx = db.transaction(stores, mode);
    } catch (err) {
      // InvalidStateError: the connection is closing or closed.
      if (attempt === 0 && err?.name === 'InvalidStateError') {
        invalidate('stale handle — retrying');
        continue;
      }
      throw err;
    }

    const result = work(tx);
    await committed(tx);
    return result;
  }
}

/* ------------------------------------------------------------------ *
 * clips
 * ------------------------------------------------------------------ */

/**
 * Insert a clip. Rejects with ConstraintError if the id already exists — add, not put,
 * because a duplicate id means a bug upstream, not an update.
 *
 * Shape is TRD §5.1. This layer stores what it is given; field defaults and urlHash
 * derivation belong to the worker at step 4, once util.js exists.
 *
 * @param {object} clip must carry a string `id`
 * @returns {Promise<string>} the id
 */
export function addClip(clip) {
  log('addClip', clip?.id);
  return withDb(CLIPS, 'readwrite', (tx) => request(tx.objectStore(CLIPS).add(clip)));
}

/**
 * @param {string} id
 * @returns {Promise<object|undefined>} undefined if absent
 */
export async function getClip(id) {
  const clip = await withDb(CLIPS, 'readonly', (tx) => request(tx.objectStore(CLIPS).get(id)));
  log('getClip', id, clip ? 'hit' : 'miss');
  return clip;
}

/**
 * Total number of clips.
 * @returns {Promise<number>}
 */
export async function countClips() {
  const n = await withDb(CLIPS, 'readonly', (tx) => request(tx.objectStore(CLIPS).count()));
  log('countClips', n);
  return n;
}

/**
 * How many clips share a canonical page. Answers "3 saves from this page" in the popup.
 * Counts through the urlHash index rather than scanning, so it stays O(log n).
 *
 * @param {string} hash
 * @returns {Promise<number>}
 */
export async function countByUrlHash(hash) {
  if (!hash) return 0;
  const n = await withDb(CLIPS, 'readonly', (tx) =>
    request(tx.objectStore(CLIPS).index('urlHash').count(IDBKeyRange.only(hash))));
  log('countByUrlHash', hash.slice(0, 8), n);
  return n;
}

/**
 * Every clip, newest first.
 *
 * Reads through the savedAt index in reverse rather than getAll()+sort, so the store
 * does the ordering. At ~500 bytes per clip (D2 keeps it there) the whole library is a
 * couple of megabytes at 5,000 clips, which is what TRD §11 relies on when it says
 * search can be a linear scan over an in-memory array.
 *
 * @returns {Promise<object[]>}
 */
export async function getAllClips() {
  const out = await withDb(CLIPS, 'readonly', (tx) => new Promise((resolve, reject) => {
    const clips = [];
    const req = tx.objectStore(CLIPS).index('savedAt').openCursor(null, 'prev');
    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor) return resolve(clips);
      clips.push(cursor.value);
      cursor.continue();
    };
    req.onerror = () => reject(req.error);
  }));
  log('getAllClips', out.length);
  return out;
}

/**
 * Overwrite a clip. Used for note edits and for restoring an undone delete.
 *
 * put, not add — unlike addClip this one is meant to replace.
 * @param {object} clip
 */
export function putClip(clip) {
  log('putClip', clip?.id);
  return withDb(CLIPS, 'readwrite', (tx) => request(tx.objectStore(CLIPS).put(clip)));
}

/**
 * @param {string} id
 */
export function deleteClip(id) {
  log('deleteClip', id);
  return withDb(CLIPS, 'readwrite', (tx) => request(tx.objectStore(CLIPS).delete(id)));
}

/* ------------------------------------------------------------------ *
 * meta
 * ------------------------------------------------------------------ */

/**
 * @param {string} key
 * @returns {Promise<any>} the stored value, or undefined
 */
export async function getMeta(key) {
  const row = await withDb(META, 'readonly', (tx) => request(tx.objectStore(META).get(key)));
  log('getMeta', key, row === undefined ? 'miss' : 'hit');
  return row?.value;
}

/**
 * Upsert a meta value. Values must be structured-cloneable — this is how the backup
 * directory handle is persisted (TRD §5.2, §13).
 *
 * @param {string} key
 * @param {any} value
 */
export function setMeta(key, value) {
  log('setMeta', key);
  return withDb(META, 'readwrite', (tx) => request(tx.objectStore(META).put({ key, value })));
}
