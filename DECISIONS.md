# Decisions

Project-wide architectural decisions. **Read this before PRD.md or TRD.md** — where they
disagree with each other or with the design canvas, this file is authoritative.

Original decisions are immutable. Changes go in a dated `### Amendment` block appended to
the decision, never by editing the original.

---

## 2026-08-20 — Design canvas reconciliation

`design/Shelf Library.dc.html` arrived after PRD v0.2 and TRD v0.2 were written and
conflicts with them in six places. Resolutions below. The canvas covers the **library page
and six popup states only**; the save bar, onboarding, and backup UI are undesigned and
resolved at their own build steps.

### D1 — Typography is self-hosted, never fetched

The canvas loads Lora and Karla from `fonts.googleapis.com`. That is a network request and
is forbidden (TRD §14, and an explicit project constraint).

**Decision:** ship Lora and Karla as Latin-subset `.woff2` files in `shelf/fonts/`,
declared with local `@font-face`. The design renders as drawn with zero network.

The font files are downloaded **once, by hand, at development time** and committed as
ordinary binary assets. This is not a build step and not a runtime dependency — it is the
same category of act as committing the icon PNGs. Verified feasible 2026-08-20.

Applies at step 6 (`theme.css`). Until then no font is referenced anywhere.

### D2 — No image thumbnails. The right-hand card is a letter avatar

The canvas draws a 132×88 card per row and a "Clear thumbnails" storage-pressure state,
implying captured page images. Nothing in PRD or TRD provides for this.

**Decision:** the card renders exactly what the mockup actually draws — a bordered card
containing a large Lora initial derived from the domain. No image is captured, stored, or
displayed. No `captureVisibleTab`, no new permission, no new object store.

**Why this is load-bearing:** ~500 bytes per clip is the premise under three separate TRD
conclusions — no pagination below ~2,000 clips (§11), loading every clip into memory to
search (§11), and the expectation that Safari's quota won't bite (§17). Screenshots run
20–40KB each, 50× that budget, and all three conclusions fail together. Consistent with
§14's existing refusal to fetch favicons for the same reason.

The storage-pressure popup state is kept, driven by `navigator.storage.estimate()`, but its
remedy is export, not clearing thumbnails.

### D3 — The passage leads when there is one

The canvas makes the title the row's largest element and the passage an optional italic
quote beneath it. PRD §8.2 requires the opposite: "the passage itself is the largest
element on the row… a list of sentences, not a list of links."

**Decision:** hierarchy is conditional on what was actually saved.

| Clip has | Leads the row (20px Lora) | Demoted to the meta line |
|---|---|---|
| A selected passage | the passage | title, domain, time |
| No passage (page save) | the title | domain, time |

Honours §8.2 for the primary flow — selection capture — while keeping the canvas exactly as
drawn for the page-save case it was designed around. Applies at step 6.

### D4 — Export JSON and export HTML are two different features

The canvas has one header button, "Export JSON", which downloads the whole library
unfiltered. TRD §12 specifies a self-contained **HTML** export, scoped to `isPublic` clips,
gated behind a count-and-domain-tally confirmation.

**Decision:** both exist, and they are not the same thing.

- **Back up** → JSON, whole library, no confirmation. This is §13's format and the canvas's
  button. It is a personal safety act with no sharing risk.
- **Share** → HTML, `isPublic` clips only, count-and-tally confirmation required
  (§12, PRD §8.4). Full-corpus HTML export is never the default.

The canvas's button is the backup path and keeps its label. The share flow is undesigned;
resolved at step 7.

**Why the confirmation survives:** PRD §8.4 calls an accidentally published reading history
the worst outcome available in this product. That safety mechanism attaches to the sharing
path specifically, so routing backup around it costs nothing.

#### Amendment — 2026-08-26 — one export, and the backup stops calling itself one

D4's split was right and stands: backup and share are different acts. What went wrong is
that the UI stopped expressing it. By the time the footer was finished there were **three**
buttons that produced a file, and two of them produced the same HTML:

| Control | Output |
|---|---|
| `Export…` (header) | HTML, marked or everything |
| `Download readable copy` (footer) | HTML, everything — i.e. `Export…` → everything |
| `Download JSON` (footer) | `shelf-backup.json`, the restorable format |

A user choosing between them was being asked to understand the JSON/HTML distinction
before they could get their own words out of the product.

**Decision:** exactly one export, and it is the header's `Export…` — HTML, keeping the
marked/everything scope and its tally confirmation. `Download readable copy` is deleted; it
was `Export…` → everything under another name.

The JSON stays, because it is not an export and never was:

- `Restore from file` reads it. Nothing else can produce its input.
- Safari cannot write to a folder (`supportsDirectoryBackup()` returns false there), and
  the app's own copy already tells those users to download it regularly. Removing it would
  leave Safari with no backup path at all, against PRD §12's highest-severity risk.

It is relabelled **Download backup file** and grouped under a `Backup` heading, so it reads
as the safety net rather than a second export. The readable HTML copy still exists where it
costs nothing — `writeBackup()` puts it in the backup folder beside the JSON, which is
PRD principle 1's "Shelf no longer exists" case.

**Rejected: dropping the marked/everything scope to simplify further.** The scope is not a
preference, it is the guard PRD §8.4 requires — always-everything publishes a whole reading
history by default, and always-marked produces confusing empty files. One export with one
question is still one export.

### D5 — The `color` field stays in the schema; no picker until it is designed

The canvas uses a single teal accent and has no colour-coding UI. PRD U9 and TRD §5.1 both
specify five clip colours.

**Decision:** keep `color` in the record with a default, so no migration is needed later.
Ship no colour UI in v1 — the canvas is the design of record and it has none. PRD U9 is P1,
not P0, so this costs no committed scope.

#### Amendment — 2026-08-20 — U9 built, in the canvas's language

Superseded on request. Keeping the field and shipping no way to set it meant the schema
carried a column nothing could write.

**Not highlighter colours.** Five saturated marker tones on a paper-and-ink page would
wreck it, which is presumably why the canvas omitted them. The five are ink-adjacent —
separable side by side, quiet enough to sit in a column, closer to a coloured pencil than
a highlighter. Defined in both themes; a colour present in one only would silently unset
itself in the other.

**Nothing new is drawn to carry them.** The colour flows into two elements that already
exist: the timeline dot, which is the element positioned to be scanned down the left edge,
and the rule beside a quoted passage.

**Colour is never the only signal.** A coded clip's dot is also larger. Roughly one reader
in twelve cannot separate these hues reliably, and a greyscale or printed page separates
none of them.

**Swatches are hidden until asked for.** Five permanent swatches per row would be five
pieces of chrome per clip on a page whose argument is that the passage is the content —
and the design was just simplified by *removing* two header controls, not by adding thirty
per screen.

**New clips are uncoloured.** `DEFAULT_COLOR` moved from `'yellow'` to `''`. A colour every
clip carries by default is not a code: the timeline becomes a column of identical dots and
"distinguish kinds of passage" distinguishes nothing. This extends TRD §5.1's union with
the empty string for "not coded" — the only schema change, and additive.

**No colour filter in the header**, deliberately. Search covers finding; colour covers
scanning. Adding five dots to a header two controls were just removed from would undo that
simplification.

### D6 — Delete is undoable

The canvas deletes immediately, from both the per-row "Remove" and the bulk action. TRD §16
check 7 requires "Delete → undo restores".

**Decision:** the check wins. Deletion shows an undo affordance and is reversible for the
duration of that affordance. Resolved concretely at step 6.

### Amendment — 2026-08-20 — accent is terracotta, not teal

Canvas revised. `--accent` moved `#1F5C5C` → `#A8462A` (light) and `#83BBB1` → `#E39272`
(dark); `--accent-soft` moved `#E7EFED` → `#F6EAE4` and `#1D2A28` → `#2C1F1A`. Every other
token is unchanged.

Two surfaces hardcode the accent and cannot pick it up from a stylesheet: the save bar
(closed shadow root) and the toolbar badge (a `chrome.action` call). Both updated.

The save button's hover shade is **derived, not from the canvas**: `#8E3A22`, darker than
the accent. The instinct is to lighten on hover, but paper-on-terracotta at `#C15634` is
4.33:1 — below WCAG AA — on the one control the entire feature depends on. Darker gives
7.24:1.

`test/design.test.mjs` now reads the accent out of the canvas and fails if shipped code
disagrees, or if any hex in the source is not traceable to a current token or a listed
derived shade. Palette drift is otherwise invisible: the design changes everywhere except
the two surfaces the user actually touches while saving.

### Amendment — 2026-08-20 — logo is mark 1a "Stack"

Chosen from the four in `design/Shelf Logo.dc.html`. Three rounded bars of descending
width, the top one in accent — "shelved lines, one just saved". It reads at 16px better
than the alternatives because it is pure horizontal mass with no enclosing shape stealing
pixels, and its meaning is the product's actual verb.

Icons are cut from that SVG geometry verbatim, **including the canvas's per-size optical
adjustments**: as the mark shrinks the bars get thicker and wider and the corner radius
grows (16px uses 8-unit bars at rx 4; 128px uses 6-unit bars at rx 3). Scaling one
drawing down instead would thin the bars into mush at toolbar size.

**Treatment is the dark tile, not the bare mark.** The canvas presents both; the tile is
the 52px rounded square in each card's footer. A toolbar icon sits on light *and* dark
browser chrome, and the two muted bars are near-black at 16–22% opacity — on a dark
toolbar the bare mark would show one terracotta bar and nothing else. The tile uses
`--dark` #131615 with `--dark-accent` #E39272, so the whole mark survives any background.

Verified at 16px pixel by pixel: three distinct bars, 1px gaps, widths 12/9/6.

### Kept from the canvas, absent from the specs

Adopted as-is, no conflict: date-range filter, Newest/Oldest/Title sort, light/dark theme
toggle, the "Restricted page" popup state, the storage-pressure popup state, and
`rel="noreferrer"` on outbound links.

Theme preference persists to `browser.storage.local` alongside `defaultColor` (TRD §5.3),
not to `localStorage` as the mock does — the mock had no extension storage available.

### Amendment — 2026-08-20 — a backup is two files, not one

D4 split JSON (backup) from HTML (share). That left a gap: the backup folder held only
`shelf-backup.json`, which a person cannot read.

**Decision:** every backup writes a pair into the folder.

| File | Answers | Readable |
|---|---|---|
| `shelf-backup.json` | "I lost my laptop" — restores into Shelf exactly | No |
| `shelf-backup.html` | "Shelf no longer exists" — opens in any browser, forever | Yes |

**Why the second one is not optional.** The JSON alone covers hardware loss. It does not
cover the product disappearing — and that is the scenario Shelf was built in response to.
PRD §1 opens on Pocket deleting eighteen years of saves; its users were left holding
exports of a service that no longer existed. A backup you cannot read without the dead
application is not an archive, it is a hostage. PRD principle 1 says this outright:
"plain JSON **and readable HTML**".

The HTML copy carries the **whole** library, unlike the share export which defaults to
`isPublic` only. A backup that silently omits unmarked clips is worse than no backup.
This does not weaken §8.4's confirmation, which guards *publishing*; writing to the
user's own backup folder is the personal-safety act D4 already exempted.

Both files skip the write when unchanged, and neither carries an internal timestamp, so a
synced folder stays quiet.

Also downloadable directly from the shelf footer, for browsers with no directory access.

### Amendment — 2026-08-20 — Public Sans only, and three controls removed

Canvas revised again, against a screenshot of the running shelf. Four changes.

**D1 superseded: the typeface is Public Sans, and there is no serif.**
Lora and Karla are gone; all 22 serif usages in the canvas became one `--sans` token.
`--serif` is deliberately **not** defined in `theme.css` any more, so a stray reference
fails visibly rather than falling back to Times without anyone noticing.

Bundled as four woff2 files — roman (variable 400–800) and italic (400–600), each in
latin and latin-ext. **93 KB, down from 129 KB**, because one variable family replaces
two. The italic is bundled although the canvas no longer uses it: 47 KB is cheaper than
discovering it missing after a release.

The type scale was rebalanced rather than swapped, because a sans needs different
settings to carry the same emphasis a serif carried:

| Element | Was | Now |
|---|---|---|
| Wordmark | Lora 23 / 500 | 20 / 700 |
| `Saved` | Lora 31 / 500 | 29 / 600 |
| Day heading | Lora 17 | 15 / 600 |
| Row lead | Lora 20 / 500 | 18 / 600 |
| Passage | Lora 15 *italic* | 15, **no italic** |

The passage loses its italic. At a sans this size italic reads as emphasis rather than
quotation, and the accent rule down its left already says "quoted".

**Removed: date-range filter.** Search covers it, and two empty `dd/mm/yyyy` fields sat
in the header permanently to serve a rare case.

**Removed: Title sort.** With it goes the only case that abandoned day grouping — the
shelf is now always chronological, which is what PRD §8.2's timeline is for.

**Empty-state copy** follows: "Nothing matches that search. Clear it to see everything."
It can no longer suggest widening dates that do not exist.

The export's inline stylesheet names Public Sans but ships no font file — a self-contained
export cannot carry a woff2 without base64-inflating it. It falls back to the system sans,
which matches in rhythm if not in face.

`test/design.test.mjs` now guards typography the way it already guarded colour: the canvas
must declare a sans and no serif, no shipped file may name a retired typeface, and every
bundled font must be referenced and every reference must exist. A leftover `Lora` does not
error — it silently renders one surface in a different face.

Logo mark 1a is unchanged in geometry; only its labels were retyped. Icons stand.

### Undesigned surfaces

Not covered by the canvas. Each is resolved at its build step, not now.

| Surface | Step | Spec |
|---|---|---|
| Floating save bar (shadow DOM) | 5 | TRD §7.1 |
| Static HTML share export | 7 | TRD §12, PRD §8.4 |
| Backup folder picker and warning | 8 | TRD §13, PRD §9 screen 2 |
| Four onboarding screens | 9 | PRD §9 |

---

## 2026-08-20 — Extension root is `shelf/`

`manifest.json` lives in `shelf/`, not at the repo root, so PRD.md, TRD.md, BUILD_PLAN.md,
this file, `design/`, and `.claude/` are never packaged into a store submission. Matches
TRD §4.1's tree and lets §17's `xcrun safari-web-extension-converter shelf/` run unmodified.

---

## 2026-08-26 — The save bar has an off switch

The bar is the one part of Shelf that appears uninvited on someone else's page. Users
reported it as stressful rather than useful on sites where they select text constantly —
a YouTube title, a search field's neighbours, anywhere reading involves dragging a cursor.
PRD principle 5 says the bar must not hijack the page; without a way to switch it off, the
only remedy a user has is uninstalling.

### D7 — Two settings, not one: per-site exceptions under a global master

`storage.local.barEnabled` (boolean, absent means on) turns the bar off everywhere.
`storage.local.barOffSites` (array of site keys, absent means none) turns it off on named
sites only. The master wins: with `barEnabled: false` the per-site switch is inert and says
so.

An off-LIST rather than an on-list, so a site granted tomorrow gets the bar without
anything having been written for it today. Defaults are therefore "absent" for both keys,
and a fresh profile behaves exactly as it did before this decision.

The site key is the hostname minus a leading `www.` — `domainOf()` in `util.js`, and the
same expression inlined in `content.js`, which cannot import. `m.youtube.com` is
deliberately a different key from `youtube.com`: they are different reading experiences and
merging them would surprise whoever switched one off.

**Rejected: revoking the host permission instead.** It already removes the bar and needs no
new state — but it also removes the excerpt ladder, the page-save button, and the clip
count for that site. Turning off a button should not cost the user three features.

**Rejected: unregistering the content script per origin.** `registerContentScripts` matches
are a single list rebuilt from `permissions.getAll()`; adding a second source of truth to it
means the bar's visibility depends on two systems agreeing, and a stale registration is
invisible until someone selects text. The gate lives inside `content.js` instead, where it
is one boolean.

### D8 — The switch is on the popup, not in a settings screen

Named after the site it governs ("Save bar on youtube.com"), one click from the toolbar —
the user is already on the page that annoyed them. A settings screen would be the wrong
distance away from the problem, and there is no options page to put one in.

The shelf page footer carries the master switch and, more importantly, the list of
per-site exceptions with a reset. A site switched off in the popup is otherwise invisible
from everywhere except that site, and "the bar stopped appearing on one blog" would have no
answer anywhere in the product.

### D9 — Off is never a dead end

Every note under both switches names the context menu: right-click → **Save selection to
Shelf** needs no content script and no host permission (TRD §9.1), so switching the bar off
costs the button, not the product. Copy that omits this turns a preference into "I have
disabled the extension".

`content.js` reads both keys directly from `storage.local` and watches `storage.onChanged`,
rather than asking the worker. A round trip would wake a torn-down service worker on every
page load for a boolean, and the live listener is what makes a flipped switch reach tabs
that are already open — without it the user turns the bar off, returns to their tab, selects
a word, and it appears anyway, which reads as a broken switch.

`barOn` starts `null` (unknown) and suppresses the bar until the first read resolves. A
default of `true` would flash the bar on precisely the site it was switched off for, which
is the whole complaint.
