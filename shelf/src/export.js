/**
 * Shelf It — static HTML export. TRD §12, PRD §8.4.
 *
 * Pure: clips in, HTML string out. No DOM, no I/O, no clock — which is what makes the
 * determinism test in test/export.test.mjs meaningful, and what lets the whole thing run
 * in Node.
 *
 * The output is one self-contained file. Inline style, inline JSON payload, inline filter
 * script, zero external requests. It opens from file://, from a USB stick, from GitHub
 * Pages, and from an email attachment, in ten years, with no server anywhere.
 */

import { escapeHtml } from './util.js';

/**
 * Fields that leave the machine. Everything absent from this list is deliberately
 * withheld, and one omission matters more than the rest:
 *
 *   context — 32 characters of page text either side of the selection (TRD §6). The user
 *   never chose to save that text; it was captured silently as a hedge for a feature that
 *   does not exist yet. Publishing it would mean publishing words they did not select,
 *   from pages they were reading. It stays local, always.
 *
 * Also withheld: canonicalUrl, urlHash and normalizeVersion (internal plumbing), isPublic
 * (the flag that put the clip here), and color.
 *
 * Order is fixed, and that is load-bearing — see the determinism note below.
 */
const PUBLIC_FIELDS = ['id', 'savedAt', 'domain', 'title', 'url', 'text', 'note'];

/**
 * Project a clip down to the fields that ship, with keys in a stable order.
 *
 * JSON.stringify serialises in insertion order, so building the object the same way every
 * time is what makes byte-identical output possible. Passing the stored clip straight
 * through would key the output on whatever order IndexedDB happened to return.
 */
function publicShape(clip) {
  const out = {};
  for (const key of PUBLIC_FIELDS) {
    const value = clip[key];
    out[key] = value === undefined || value === null ? (key === 'savedAt' ? 0 : '') : value;
  }
  return out;
}

/**
 * Inline a JSON payload inside a <script> tag safely.
 *
 * TRD §12 names the hazard: a clip containing the literal characters `</script>` would
 * otherwise close the tag it is sitting in, and everything after it becomes markup. The
 * passage text comes off arbitrary web pages, so this is a matter of when, not if — a
 * clip taken from any article about writing HTML will do it.
 *
 * Escaping `<` covers `</script>`, `<!--`, and `<![CDATA[` in one move. The result is
 * still valid JSON: < is just a `<`.
 */
function inlineJson(value) {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}

/** Domain -> count, sorted by count then name. Used by the confirmation and the header. */
export function domainTally(clips) {
  const counts = new Map();
  for (const clip of clips) {
    const key = clip.domain || 'local';
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => (b[1] - a[1]) || (a[0] < b[0] ? -1 : 1));
}

const STYLE = `
:root{--paper:#FBFAF7;--sheet:#fff;--ink:#1B1A17;--ink-2:#4A4841;--muted:#8A867B;
--rule:#E6E2D8;--rule-soft:#EFEBE2;--accent:#A8462A;--accent-soft:#F6EAE4}
@media (prefers-color-scheme:dark){:root{--paper:#131615;--sheet:#191D1C;--ink:#ECE9E1;
--ink-2:#C3C0B7;--muted:#8B928E;--rule:#282D2B;--rule-soft:#222725;--accent:#E39272;
--accent-soft:#2C1F1A}}
*{box-sizing:border-box}
body{margin:0;background:var(--paper);color:var(--ink);
/* The bundled woff2 cannot travel inside a single self-contained file without
   base64-inflating it, so the export names the family and lets the system sans take
   over. It renders identically in shape and rhythm, just not in the exact face. */
font-family:"Public Sans",system-ui,-apple-system,"Segoe UI",sans-serif;-webkit-font-smoothing:antialiased}
.wrap{max-width:820px;margin:0 auto;padding:0 28px}
header{border-bottom:1px solid var(--rule);padding:44px 0 0}
h1{font-size:29px;font-weight:600;margin:0 0 6px;letter-spacing:-.02em}
.sub{margin:0 0 22px;font-size:14px;color:var(--muted)}
.search{display:flex;align-items:center;gap:9px;border-bottom:1px solid var(--rule);padding:6px 2px;margin-bottom:18px}
.search input{flex:1;background:none;border:0;outline:0;font:inherit;font-size:15px;color:var(--ink)}
main{padding:30px 0 90px}
.day{font-size:14px;font-weight:600;color:var(--muted);
margin:34px 0 4px;padding-bottom:8px;border-bottom:1px solid var(--rule-soft)}
.day:first-child{margin-top:0}
article{padding:20px 0 22px;border-bottom:1px solid var(--rule-soft)}
.meta{font-size:12.5px;color:var(--muted);padding-bottom:7px}
.meta b{color:var(--ink-2);font-weight:400}
.lead{font-size:17px;line-height:1.45;font-weight:600;
color:var(--ink);text-decoration:none;display:block;letter-spacing:-.01em}
.lead:hover{color:var(--accent)}
.lead.q{padding-left:14px;border-left:2px solid var(--accent-soft)}
.title2{display:block;margin-top:9px;font-size:13.5px;color:var(--ink-2);text-decoration:none}
.title2:hover{color:var(--accent)}
.note{margin-top:11px;font-size:13.5px;line-height:1.55;color:var(--ink-2)}
.note i{font-style:normal;font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:var(--accent);margin-right:8px}
footer{padding:34px 0 60px;font-size:12.5px;color:var(--muted);line-height:1.7;border-top:1px solid var(--rule)}
.none{padding:50px 0;color:var(--muted);font-size:14px}`.trim();

/**
 * The filter script that ships inside the file.
 *
 * Deliberately small and dependency-free. It builds DOM nodes rather than assigning
 * innerHTML for the same reason the shelf page does: every string in the payload came off
 * a web page, and there is no escaping step to forget if you never concatenate markup.
 */
const SCRIPT = `
(function(){
var DATA=JSON.parse(document.getElementById('shelf-data').textContent);
var DAYS=['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
var MONTHS=['January','February','March','April','May','June','July','August','September','October','November','December'];
function day(ts){var d=new Date(ts);return DAYS[d.getDay()]+', '+d.getDate()+' '+MONTHS[d.getMonth()]+' '+d.getFullYear()}
function key(ts){var d=new Date(ts);return d.getFullYear()+'-'+(d.getMonth()+1)+'-'+d.getDate()}
function time(ts){var d=new Date(ts),h=d.getHours(),m=String(d.getMinutes()).padStart(2,'0');
return (h%12||12)+':'+m+' '+(h>=12?'PM':'AM')}
function el(t,c,x){var n=document.createElement(t);if(c)n.className=c;if(x!==undefined)n.textContent=x;return n}
function render(q){
var main=document.getElementById('list');main.replaceChildren();
var terms=q.toLowerCase().split(/\\s+/).filter(Boolean);
var list=DATA.filter(function(c){
if(!terms.length)return true;
var hay=(c.text+' '+c.note+' '+c.title+' '+c.domain).toLowerCase();
return terms.every(function(t){return hay.indexOf(t)>-1});});
var doms={};list.forEach(function(c){doms[c.domain||'local']=1});
var nd=Object.keys(doms).length;
document.getElementById('count').textContent=
list.length+(list.length===1?' passage':' passages')+' from '+nd+(nd===1?' site':' sites');
if(!list.length){main.append(el('p','none','Nothing matches that search.'));return}
var seen='';
list.forEach(function(c){
var k=key(c.savedAt);
if(k!==seen){seen=k;main.append(el('div','day',day(c.savedAt)))}
var a=el('article');
var m=el('div','meta');var b=el('b',null,c.domain);m.append(b,document.createTextNode(' · '+time(c.savedAt)));
a.append(m);
var lead=el('a',c.text?'lead q':'lead',c.text||c.title||c.domain);
lead.href=c.url;lead.target='_blank';lead.rel='noreferrer';a.append(lead);
if(c.text&&c.title){var t2=el('a','title2',c.title);t2.href=c.url;t2.target='_blank';t2.rel='noreferrer';a.append(t2)}
if(c.note){var n=el('div','note');n.append(el('i',null,'Note'),document.createTextNode(c.note));a.append(n)}
main.append(a);});}
var box=document.getElementById('q');
box.addEventListener('input',function(){render(box.value)});
document.addEventListener('keydown',function(e){
if(e.key==='/'&&document.activeElement!==box){e.preventDefault();box.focus()}});
render('');
})();`.trim();

/**
 * Build the export.
 *
 * DETERMINISM (TRD §12). Identical input must produce byte-identical output, so that
 * committing an export to a Pages repo yields a clean diff instead of a whole-file
 * change every time. Three things guarantee it:
 *   - clips are sorted here, so input order cannot leak into the output
 *   - keys are emitted in a fixed order by publicShape()
 *   - nothing reads the clock. There is no generatedAt; git and the filesystem already
 *     know when the file was written, and a timestamp would defeat the entire property.
 *
 * @param {object[]} clips
 * @param {{title?: string, footerNote?: string}} [options]
 * @returns {string}
 */
export function buildExportHtml(clips, options = {}) {
  const title = options.title || 'Shelf It';
  const sorted = [...clips].sort((a, b) => (b.savedAt - a.savedAt) || (a.id < b.id ? -1 : 1));
  const payload = sorted.map(publicShape);
  const sites = domainTally(sorted).length;

  // The filter script rewrites this same element on every keystroke, so the two must
  // produce the same phrasing — otherwise the header silently changes shape the instant
  // the page renders, which is exactly what it did: "4 passages from 4 sites" became
  // "4 passages" before anyone could read it.
  const subtitle = `${sorted.length} ${sorted.length === 1 ? 'passage' : 'passages'}`
    + ` from ${sites} ${sites === 1 ? 'site' : 'sites'}`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'">
<title>${escapeHtml(title)}</title>
<style>${STYLE}</style>
</head>
<body>
<header class="wrap">
<h1>${escapeHtml(title)}</h1>
<p class="sub"><span id="count">${escapeHtml(subtitle)}</span> · kept offline</p>
<div class="search"><span aria-hidden="true">&#8981;</span><input id="q" type="search" placeholder="Search these passages" aria-label="Search"></div>
</header>
<main class="wrap" id="list"></main>
<footer class="wrap">
This file is self-contained. It makes no network requests, loads nothing remotely, and
works offline from disk. Exported from Shelf It, a local-first clipper.${options.footerNote ? '<br>' + escapeHtml(options.footerNote) : ''}
</footer>
<script type="application/json" id="shelf-data">${inlineJson(payload)}</script>
<script>${SCRIPT}</script>
</body>
</html>
`;
}
