/**
 * Shelf It — pure helpers. No DOM, no chrome.*, no I/O.
 *
 * Everything here is a pure function of its arguments, which is what makes the fixture
 * table in test/util.test.mjs meaningful. Keep it that way — the moment a helper reads
 * the clock or the document, its test stops proving anything.
 */

/* ================================================================== *
 * URL normalization — TRD §5.4
 *
 * LOAD-BEARING. canonicalUrl feeds urlHash, and urlHash is how "3 clips from this page"
 * is answered. Change a rule and every stored hash stops matching, silently: old clips
 * simply stop grouping with new ones. Nothing throws, nothing looks broken, the feature
 * just quietly rots.
 *
 * Hence NORMALIZE_VERSION. It is stored on nothing yet; step 4 writes it alongside each
 * clip so a future rule change can find the records that need rehashing.
 * ================================================================== */

/** Bump on ANY change to normalizeUrl's behaviour. Never reuse a number. */
export const NORMALIZE_VERSION = 1;

/** Any param starting with one of these is tracking noise. */
const TRACKING_PREFIXES = ['utm_', 'hsa_', 'pk_', 'piwik_', 'matomo_'];

/**
 * Exact-match tracking params.
 *
 * Deliberately NOT included: bare `ref`. It is tracking on some sites and a real
 * identifier on others, and wrongly dropping it changes what page the URL points at.
 * TRD §5.4 names `ref_src` specifically, not `ref`. When in doubt, keep the param —
 * a redundant param costs a duplicate group, a dropped one costs a wrong destination.
 */
const TRACKING_PARAMS = new Set([
  'fbclid', 'gclid', 'gclsrc', 'dclid', 'msclkid', 'yclid', 'twclid', 'ttclid',
  'igshid', 'igsh', 'ref_src', 'ref_url', 'mc_cid', 'mc_eid', 'li_fat_id',
  's_kwcid', 'vero_id', 'vero_conv', 'oly_anon_id', 'oly_enc_id',
  '_ga', '_gl', '__s', 'mkt_tok', 'trk', 'trkCampaign', 'sc_cid',
  'si',            // share id — YouTube, Spotify
  'feature',       // YouTube referrer breadcrumb
  'spm', 'scm',    // Alibaba-family tracking
]);

/**
 * Params that encode a POSITION inside media rather than page identity, keyed by host
 * suffix. Stripped from canonicalUrl only.
 *
 * TRD §7.2 keeps the timestamp on the stored `url` so clicking a clip returns to the
 * moment. But two clips from the same video at 0:08 and 4:20 are the same PAGE, so the
 * canonical form must drop the position or urlHash splits them and the page count lies.
 */
const MEDIA_POSITION_PARAMS = [
  { host: 'youtube.com', params: ['t', 'start', 'end', 'time_continue'] },
  { host: 'youtu.be', params: ['t', 'start', 'end'] },
  { host: 'vimeo.com', params: ['t'] },
  { host: 'twitch.tv', params: ['t'] },
];

/**
 * Hosts where the fragment routes the app — i.e. changing it shows different content.
 * Everywhere else the fragment is a scroll anchor and gets dropped, because
 * page#section-2 and page#section-9 are the same page.
 *
 * Add to this list rather than weakening the default. Being wrong here in the permissive
 * direction only costs a duplicate group; being wrong in the strict direction loses the
 * user's actual destination.
 */
const HASH_ROUTED_HOSTS = new Set([
  'docs.google.com',
  'drive.google.com',
  'mail.google.com',
  'groups.google.com',
  'web.telegram.org',
  'messages.google.com',
]);

/** Schemes we can meaningfully normalize. Everything else is returned untouched. */
const NORMALIZABLE_SCHEMES = new Set(['http:', 'https:']);

/**
 * Canonical form of a URL, for hashing and de-duplication.
 *
 * Total function — never throws. Anything unparseable, or on a scheme we don't handle
 * (file:, chrome:, about:, mailto:), comes back trimmed but otherwise untouched. A
 * clipping tool that throws on a weird address loses the clip.
 *
 * @param {string} input
 * @returns {string}
 */
export function normalizeUrl(input) {
  if (typeof input !== 'string') return '';
  const trimmed = input.trim();
  if (!trimmed) return '';

  let u;
  try {
    u = new URL(trimmed);
  } catch {
    return trimmed;
  }

  // Scheme and host are lowercased by the URL parser already; default ports dropped too.
  if (!NORMALIZABLE_SCHEMES.has(u.protocol)) return trimmed;

  // www. is never meaningful. Other subdomains are.
  let host = u.hostname;
  if (host.startsWith('www.')) host = host.slice(4);

  // The port is part of the origin — example.com:8443 is not example.com. Kept separate
  // from `host` because the allowlists below match on hostname, port or no port. The URL
  // parser has already dropped the default ports, so u.port is '' for :80 and :443.
  const authority = host + (u.port ? ':' + u.port : '');

  // Drop tracking params, then any media-position params for this host.
  const positional = new Set();
  for (const entry of MEDIA_POSITION_PARAMS) {
    if (host === entry.host || host.endsWith('.' + entry.host)) {
      for (const p of entry.params) positional.add(p);
    }
  }

  const kept = [];
  for (const [key, value] of u.searchParams) {
    const lower = key.toLowerCase();
    if (TRACKING_PARAMS.has(lower)) continue;
    if (TRACKING_PREFIXES.some((p) => lower.startsWith(p))) continue;
    if (positional.has(lower)) continue;
    kept.push([key, value]);
  }

  // Sort for stability: same params in any order produce the same canonical string.
  kept.sort((a, b) => (a[0] === b[0] ? compare(a[1], b[1]) : compare(a[0], b[0])));
  const query = kept.map(([k, v]) => encode(k) + '=' + encode(v)).join('&');

  // Trailing slash carries no meaning; "/" for the root path least of all.
  let path = u.pathname;
  if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);
  if (path === '/') path = '';

  // Fragment: kept only where it routes the app. Text fragments (#:~:text=) are always
  // dropped — Chrome mints a fresh one per selection, so keeping them would give every
  // clip from a page its own hash.
  let fragment = '';
  if (u.hash && HASH_ROUTED_HOSTS.has(host) && !u.hash.startsWith('#:~:')) {
    fragment = u.hash;
  }

  return u.protocol + '//' + authority + path + (query ? '?' + query : '') + fragment;
}

/** Stable string compare that doesn't depend on locale. localeCompare would. */
function compare(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** encodeURIComponent, but leaving the sub-delims that browsers leave alone in queries. */
function encode(s) {
  return encodeURIComponent(s).replace(/%20/g, '+');
}

/**
 * urlHash — first 32 hex chars of SHA-256 over the canonical URL. (TRD §5.1)
 *
 * 128 bits. Collision odds stay negligible far beyond any realistic library, and the
 * short form keeps the record small.
 *
 * @param {string} canonicalUrl
 * @returns {Promise<string>}
 */
export async function urlHash(canonicalUrl) {
  const bytes = new TextEncoder().encode(canonicalUrl);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const hex = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0'));
  return hex.join('').slice(0, 32);
}

/**
 * Display domain — host without www., or '' if there isn't one.
 * @param {string} input
 * @returns {string}
 */
export function domainOf(input) {
  try {
    const host = new URL(String(input).trim()).hostname;
    return host.startsWith('www.') ? host.slice(4) : host;
  } catch {
    return '';
  }
}

/**
 * The letter shown in the avatar card. (D2 — no favicons, no images.)
 * @param {string} domain
 * @returns {string}
 */
export function domainInitial(domain) {
  const c = String(domain || '').trim().charAt(0);
  return c ? c.toLowerCase() : '·';
}

/* ================================================================== *
 * Text
 * ================================================================== */

/**
 * Collapse runs of whitespace to single spaces and trim. Applied to every captured
 * passage (TRD §5.1) so a selection spanning line breaks stores as one clean sentence.
 * @param {string} s
 * @returns {string}
 */
export function collapseWhitespace(s) {
  return String(s ?? '').replace(/\s+/g, ' ').trim();
}

/**
 * Escape for interpolation into HTML. (TRD §14, §12)
 *
 * Covers the forward slash too, so the string "</script>" cannot terminate a script tag
 * it is inlined into — the specific break-out that TRD §12 calls out for the export
 * payload.
 * @param {string} s
 * @returns {string}
 */
export function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * A clip as Markdown, with its citation. PRD U13.
 *
 * Shaped for pasting into notes, an essay draft, or a commit message — which means the
 * passage has to come first and the citation has to be one line under it. A YAML block
 * or a table would be tidier and would not survive contact with any of those places.
 *
 * Blockquote for a passage, plain text for a page-save: quoting a title you did not
 * select would misrepresent what was saved.
 *
 * @param {object} clip
 * @returns {string}
 */
export function toMarkdown(clip) {
  const lines = [];
  // Horizontal whitespace collapsed, line breaks kept. Clips saved by Shelf It are already
  // fully collapsed by buildClip, so this only matters for a restored backup — and
  // parseBackupJson accepts any well-formed JSON, including hand-edited files. Flattening
  // here would be harmless; NOT prefixing every line would leave half the passage
  // rendering as body text outside the quote.
  const text = String(clip?.text ?? '').replace(/[^\S\n]+/g, ' ')
    .split('\n').map((l) => l.trim()).join('\n').trim();
  const title = collapseWhitespace(clip?.title ?? '');
  const note = collapseWhitespace(clip?.note ?? '');
  const url = String(clip?.url ?? '').trim();
  const domain = clip?.domain || domainOf(url);

  if (text) {
    // Every line prefixed, so a multi-line passage stays one quote rather than breaking
    // out of it halfway.
    lines.push(text.split('\n').map((l) => '> ' + l).join('\n'), '');
  }

  // Escape the link text, or a title containing ] or ) silently breaks the link.
  const label = title || domain || url;
  const safeLabel = label.replace(/([\[\]])/g, '\\$1');
  const cite = url ? `— [${safeLabel}](${url})` : `— ${safeLabel}`;
  const when = Number.isFinite(clip?.savedAt) ? dayHeading(clip.savedAt).date : '';
  lines.push(when ? `${cite}, ${when}` : cite);

  if (note) lines.push('', `*${note}*`);

  return lines.join('\n').trim() + '\n';
}

/* ================================================================== *
 * Time — PRD §8.2
 *
 * "When did I read this" must always be answerable. Every function here takes `now`
 * explicitly so it stays pure and testable; callers pass Date.now().
 * ================================================================== */

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
                'July', 'August', 'September', 'October', 'November', 'December'];

/** Local-day key, 'YYYY-MM-DD'. The grouping key for the shelf's day sections. */
export function dayKey(ts) {
  const d = new Date(ts);
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
}

/** Day heading for the left column: { weekday: 'Thursday', date: '20 August 2026' }. */
export function dayHeading(ts) {
  const d = new Date(ts);
  return {
    weekday: DAYS[d.getDay()],
    date: d.getDate() + ' ' + MONTHS[d.getMonth()] + ' ' + d.getFullYear(),
  };
}

/** Clock time, '9:12 AM'. Shown on the row, where the day heading supplies the date. */
export function clockTime(ts) {
  const d = new Date(ts);
  let h = d.getHours();
  const ampm = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  return h + ':' + pad(d.getMinutes()) + ' ' + ampm;
}

/**
 * Relative age under 24h, absolute date beyond. PRD §8.2's ladder.
 * @param {number} ts epoch ms
 * @param {number} now epoch ms
 */
export function relativeTime(ts, now) {
  const secs = Math.floor((now - ts) / 1000);
  if (secs < 0) return 'just now';           // clock skew; never show a future age
  if (secs < 45) return 'just now';
  if (secs < 3600) return Math.floor(secs / 60) + 'm';
  if (secs < 86400) return Math.floor(secs / 3600) + 'h';
  const d = new Date(ts);
  const sameYear = d.getFullYear() === new Date(now).getFullYear();
  const short = d.getDate() + ' ' + MONTHS[d.getMonth()].slice(0, 3);
  return sameYear ? short : short + ' ' + d.getFullYear();
}

/**
 * relativeTime as a phrase that can sit in a sentence.
 *
 * relativeTime returns three different shapes — "just now", "2h", "19 Aug" — and only
 * the middle one takes " ago". Appending it unconditionally produces "just now ago" and
 * "19 Aug ago", which is how the backup footer read until someone looked at it.
 *
 * @param {number} ts epoch ms
 * @param {number} now epoch ms
 * @returns {string} e.g. "just now", "2h ago", "on 19 Aug"
 */
export function relativePhrase(ts, now) {
  const rel = relativeTime(ts, now);
  if (rel === 'just now') return rel;
  return /^\d+[mh]$/.test(rel) ? rel + ' ago' : 'on ' + rel;
}

/** Full timestamp for the title attribute — the always-answerable form. */
export function fullTimestamp(ts) {
  const d = new Date(ts);
  const { weekday, date } = dayHeading(ts);
  return weekday + ', ' + date + ' at ' + clockTime(ts) + ':' + pad(d.getSeconds()).slice(0, 2);
}

function pad(n) {
  return String(n).padStart(2, '0');
}
