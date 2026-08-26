/**
 * Shelf — the save bar. TRD §7.1.
 *
 * CLASSIC SCRIPT, NOT AN ES MODULE. Content scripts run in an isolated world with no
 * module loader for extension origins, so `import` here fails at parse time. Nothing in
 * this file may import; it talks to the worker over the message protocol in §8 instead.
 * test/manifest.test.mjs asserts this never regresses.
 *
 * Registered at runtime by background.js against whatever origins the user has granted.
 * It never runs on a site with no permission — that case falls back to the context menu.
 *
 * Holds no durable state and never modifies the page. The bar lives in a closed shadow
 * root attached to a single host element; removing that element removes every trace.
 *
 * It does READ two settings — see Enablement below. That is storage.local directly, not
 * a message, and it is the one exception to the paragraph above it.
 */

(function () {
  'use strict';

  // Re-injection guard (TRD §7.1). registerContentScripts covers new navigations while
  // executeScript covers tabs already open when permission was granted — a tab can get
  // both.
  if (window.__shelfLoaded) return;
  window.__shelfLoaded = true;

  /** Selection must survive whitespace collapse at this length to qualify. */
  const MIN_CHARS = 2;

  /** TRD §6 — bytes of surrounding text kept per side. */
  const CONTEXT_CHARS = 32;

  /** mouseup debounce. Long enough to coalesce a drag, short of the 60ms budget (§15). */
  const DEBOUNCE_MS = 10;

  const GAP = 8;          // px between selection and bar
  const CONFIRM_MS = 1100;

  let host = null;        // the shadow host element
  let root = null;        // its closed shadow root
  let button = null;
  let debounce = 0;
  let lastCapture = null;

  /**
   * Whether the bar may appear here at all.
   *
   * null means "not read yet" and suppresses the bar, which is the safe way round: a
   * user who turned the bar off on this site must never see it flash in the window
   * between document_idle and the first storage read. The cost is that a selection made
   * inside that window (single-digit milliseconds) shows nothing.
   */
  let barOn = null;

  /* ---------------------------------------------------------------- *
   * Enablement
   *
   * Two settings in storage.local, both read straight from here rather than fetched
   * over the message protocol. A round trip to the worker would mean waking a torn-down
   * service worker on every page load — for a boolean — and would widen the window in
   * which barOn is still null.
   *
   *   barEnabled   false turns the bar off everywhere. Absent means on.
   *   barOffSites  site keys the bar is off for. Absent means none.
   *
   * An off-LIST rather than an on-list, so a site the user grants tomorrow gets the bar
   * without anything having been written for it today.
   * ---------------------------------------------------------------- */

  /**
   * The per-site key. Hostname minus a leading `www.`, which is exactly the string the
   * popup shows next to the switch — what the user toggles is what they read.
   *
   * Duplicated from util.domainOf because this file cannot import (see the header).
   * test/savebar.test.mjs asserts the two expressions stay identical; if they drift, a
   * site turned off in the popup is stored under one key and matched under another —
   * the switch reads off, the bar keeps appearing, and nothing reports a problem.
   */
  function siteKey() {
    // Not named `host` — that is the shadow host element in this file.
    const name = location.hostname;
    return name.startsWith('www.') ? name.slice(4) : name;
  }

  /** The gate itself: master on, and this site not in the off-list. */
  function barOnFor(values) {
    const off = Array.isArray(values.barOffSites) ? values.barOffSites : [];
    return values.barEnabled !== false && !off.includes(siteKey());
  }

  chrome.storage.local.get(['barEnabled', 'barOffSites'], (values) => {
    if (chrome.runtime.lastError) {
      // Storage unreadable is not a reason to withhold the product's main affordance.
      barOn = true;
      return;
    }
    barOn = barOnFor(values || {});
    console.debug('[shelf:content] save bar', barOn ? 'on' : 'off', 'for', siteKey());
  });

  /**
   * Live, so flipping the switch in the popup reaches every open tab at once. Without
   * this the user turns the bar off, goes back to the page they were reading, selects a
   * word, and it appears anyway — which reads as the switch not working.
   */
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (!('barEnabled' in changes) && !('barOffSites' in changes)) return;
    chrome.storage.local.get(['barEnabled', 'barOffSites'], (values) => {
      if (chrome.runtime.lastError) return;
      barOn = barOnFor(values || {});
      // Turned off with the bar on screen — take it away now, not at the next selection.
      if (!barOn) hide();
    });
  });

  /* ---------------------------------------------------------------- *
   * Qualification
   * ---------------------------------------------------------------- */

  function collapse(s) {
    return String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  }

  /**
   * The bar must never appear on a selection inside an input, textarea, or editable
   * region (TRD §7.1). Someone selecting text they are writing is editing, not clipping,
   * and a floating button over their cursor is actively hostile.
   */
  function isEditable(node) {
    let el = node && node.nodeType === Node.ELEMENT_NODE ? node : node && node.parentElement;
    while (el) {
      const tag = el.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
      if (el.isContentEditable) return true;
      el = el.parentElement;
    }
    return false;
  }

  /** Cheap enough to run on every selectionchange — see the <3ms idle budget in §15. */
  function qualifyingSelection() {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;
    const text = collapse(sel.toString());
    if (text.length < MIN_CHARS) return null;
    if (isEditable(sel.anchorNode) || isEditable(sel.focusNode)) return null;
    return { sel, text, range: sel.getRangeAt(0) };
  }

  /* ---------------------------------------------------------------- *
   * Capture
   * ---------------------------------------------------------------- */

  /**
   * TRD §6's hedge — 32 chars either side, taken straight off the Range.
   *
   * Unused in v1. It exists because on-page highlight repainting, if it is ever built,
   * works retroactively on every clip that stored context and never on the ones that
   * did not. Cheap to store, impossible to backfill.
   */
  function contextAround(range) {
    let prefix = '';
    let suffix = '';
    try {
      const start = range.startContainer;
      const end = range.endContainer;
      if (start.nodeType === Node.TEXT_NODE) {
        const from = Math.max(0, range.startOffset - CONTEXT_CHARS);
        prefix = start.textContent.slice(from, range.startOffset);
      }
      if (end.nodeType === Node.TEXT_NODE) {
        suffix = end.textContent.slice(range.endOffset, range.endOffset + CONTEXT_CHARS);
      }
    } catch (err) {
      // A detached or exotic Range is not worth losing the clip over.
      console.debug('[shelf:content] context capture skipped', err);
    }
    return { prefix: collapse(prefix), suffix: collapse(suffix) };
  }

  /** Integer seconds if a video is meaningfully underway. TRD §7.2. */
  function mediaSeconds() {
    const video = document.querySelector('video');
    if (!video || !Number.isFinite(video.currentTime) || video.currentTime <= 1) return null;
    return Math.floor(video.currentTime);
  }

  /**
   * The URL to store — the moment, not just the page (TRD §7.2).
   *
   * Note the asymmetry with canonicalUrl: this keeps the timestamp so clicking the clip
   * returns to 8:04, while normalizeUrl strips it so two clips from one video still
   * count as one page.
   */
  function urlWithTime(seconds) {
    const href = location.href;
    if (seconds == null) return href;
    try {
      const u = new URL(href);
      const host = u.hostname.replace(/^www\./, '');
      if (host === 'youtube.com' || host.endsWith('.youtube.com') || host === 'youtu.be') {
        u.searchParams.set('t', seconds + 's');
        return u.toString();
      }
      // Media Fragments URI — understood by plain <video> elements.
      return href.split('#')[0] + '#t=' + seconds;
    } catch {
      return href;
    }
  }

  /* ---------------------------------------------------------------- *
   * The bar
   *
   * Closed shadow root, non-negotiable per §7.1 — page CSS would otherwise reach in and
   * destroy it. `all: initial` on the host blocks inherited properties from leaking in
   * before the shadow boundary even applies.
   * ---------------------------------------------------------------- */

  function build() {
    host = document.createElement('div');
    // Order matters: `all: initial` resets position and display, so both are set after.
    host.style.cssText =
      'all: initial;' +
      'position: fixed;' +
      'display: block;' +
      'top: 0; left: 0;' +
      'z-index: 2147483647;' +
      'pointer-events: none;';

    root = host.attachShadow({ mode: 'closed' });

    const style = document.createElement('style');
    style.textContent = [
      ':host { all: initial; }',
      '.bar {',
      '  pointer-events: auto;',
      '  display: inline-flex; align-items: center; gap: 8px;',
      '  font: 500 13px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;',
      '  background: #1B1A17; color: #FBFAF7;',
      '  border-radius: 8px; padding: 0 4px 0 12px; height: 34px;',
      '  box-shadow: 0 6px 22px rgba(0,0,0,0.28), 0 0 0 1px rgba(255,255,255,0.08);',
      '  user-select: none; -webkit-user-select: none; white-space: nowrap;',
      '}',
      '.label { opacity: 0.62; letter-spacing: 0.02em; }',
      '.save {',
      '  font: inherit; cursor: pointer; border: 0;',
      /* Accent #A8462A on paper text is 5.63:1. Hover goes DARKER (#8E3A22,
         7.24:1) — lightening a mid-tone terracotta drops it to 4.33:1 and
         fails WCAG AA on the one control the whole feature depends on. */
      '  background: #A8462A; color: #FBFAF7;',
      '  border-radius: 6px; padding: 0 12px; height: 26px;',
      '}',
      '.save:hover { background: #8E3A22; }',   /* darker, not lighter — see below */
      '.saved .save { background: transparent; color: #E39272; cursor: default; }',
      '.saved .label { opacity: 0; }',
    ].join('\n');

    const bar = document.createElement('div');
    bar.className = 'bar';

    const label = document.createElement('span');
    label.className = 'label';
    label.textContent = 'Shelf';

    button = document.createElement('button');
    button.className = 'save';
    button.type = 'button';
    button.textContent = 'Save';

    bar.append(label, button);
    root.append(style, bar);

    /**
     * THE critical line in this file (§7.1). A mousedown anywhere outside the current
     * selection collapses it — so without preventDefault the selection is gone before
     * the click handler runs, and the bar saves nothing.
     */
    bar.addEventListener('mousedown', (e) => e.preventDefault());
    button.addEventListener('click', onSave);

    document.documentElement.append(host);
    return bar;
  }

  function barEl() {
    return root.querySelector('.bar');
  }

  function show(range) {
    const bar = host ? barEl() : build();

    bar.classList.remove('saved');
    button.textContent = 'Save';
    button.disabled = false;

    // Measure off-screen first so width is known before positioning.
    host.style.visibility = 'hidden';
    host.style.transform = 'translate(0px, 0px)';

    const size = bar.getBoundingClientRect();

    // Anchor to the LAST line of the selection, not the whole bounding box. On a
    // multi-line selection the last line is where the pointer was released and is
    // usually the shortest, so the bar lands near the cursor rather than floating in
    // the middle of the paragraph.
    const rects = range.getClientRects();
    const full = range.getBoundingClientRect();
    const anchor = rects.length ? rects[rects.length - 1] : full;

    /**
     * BELOW the selection by default.
     *
     * The obvious choice is above, and it is wrong. Medium, Substack, Notion and most
     * reading platforms put their own selection toolbar above the text, centred — so
     * "above" collides on exactly the sites this product is for, and at
     * z-index 2147483647 we always win, covering their controls. That is the hijacking
     * PRD principle 5 rules out.
     *
     * Below inverts the failure: we collide only on the rare site that puts its toolbar
     * underneath. Flip up only when there is genuinely no room.
     */
    let top = anchor.bottom + GAP;
    if (top + size.height > window.innerHeight - GAP) {
      top = Math.max(GAP, full.top - size.height - GAP);
    }

    // Centred on the anchor line, then clamped so an edge-of-viewport selection never
    // pushes the bar off-screen.
    let left = anchor.left + anchor.width / 2 - size.width / 2;
    left = Math.max(GAP, Math.min(left, window.innerWidth - size.width - GAP));

    host.style.transform = 'translate(' + Math.round(left) + 'px,' + Math.round(top) + 'px)';
    host.style.visibility = 'visible';
  }

  function hide() {
    if (host) host.style.visibility = 'hidden';
    lastCapture = null;
  }

  /* ---------------------------------------------------------------- *
   * Save
   * ---------------------------------------------------------------- */

  function onSave() {
    if (!lastCapture) return;
    button.disabled = true;

    const seconds = mediaSeconds();
    const payload = {
      source: 'bar',
      text: lastCapture.text,
      url: urlWithTime(seconds),
      title: document.title,
      context: lastCapture.context,
      seconds,
    };

    // PRD §8.1 — the worker writes before it replies, so the confirmation below always
    // trails a committed write. Navigating away mid-flight loses the confirmation, never
    // the clip.
    chrome.runtime.sendMessage({ type: 'SAVE_CLIP', payload }, (res) => {
      if (chrome.runtime.lastError) {
        console.debug('[shelf:content] save failed', chrome.runtime.lastError.message);
        button.textContent = 'Failed';
        setTimeout(hide, CONFIRM_MS);
        return;
      }
      const bar = barEl();
      if (res && res.ok) {
        bar.classList.add('saved');
        button.textContent = res.pageCount > 1 ? '✓ Saved · ' + res.pageCount + ' here' : '✓ Saved';
      } else {
        button.textContent = 'Failed';
      }
      setTimeout(hide, CONFIRM_MS);
    });
  }

  /* ---------------------------------------------------------------- *
   * Events
   * ---------------------------------------------------------------- */

  function evaluate() {
    if (!barOn) {
      hide();
      return;
    }
    const found = qualifyingSelection();
    if (!found) {
      hide();
      return;
    }
    lastCapture = { text: found.text, context: contextAround(found.range) };
    show(found.range);
  }

  document.addEventListener('mouseup', () => {
    clearTimeout(debounce);
    debounce = setTimeout(evaluate, DEBOUNCE_MS);
  }, true);

  document.addEventListener('keyup', (e) => {
    // Keyboard selection: shift+arrows, and ctrl/cmd+A.
    if (e.shiftKey || e.key === 'a' || e.key === 'A') {
      clearTimeout(debounce);
      debounce = setTimeout(evaluate, DEBOUNCE_MS);
    }
  }, true);

  /**
   * Hide-only path. Deliberately does no measuring or DOM work — selectionchange fires
   * on every caret move, and §15 budgets under 3ms for an idle content script.
   */
  document.addEventListener('selectionchange', () => {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed) hide();
  });

  // The bar is position:fixed, so scrolling would leave it stranded away from the text
  // it belongs to. Cheaper and less error-prone than tracking the range through scroll.
  window.addEventListener('scroll', hide, { passive: true, capture: true });
  window.addEventListener('resize', hide, { passive: true });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') hide();
  }, true);

  console.debug('[shelf:content] ready', location.hostname);
})();
