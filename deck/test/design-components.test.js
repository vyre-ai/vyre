// @ts-check
// The Deck-wide components of Design A v1 (docs/design/system/components): the one button system
// in css/buttons.css (the old class names kept as its aliases), the status marks (js/status-mark.js,
// css/marks.css) and the one toast (js/toast.js).

import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DECK = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// The pre-app pages (onboard/...) live in web/, the Deck's own files in deck/.
const read = (/** @type {string} */ f) => fs.readFileSync(fs.existsSync(path.join(DECK, f)) ? path.join(DECK, f) : path.join(DECK, "..", "web", f), "utf8");
const noComments = (/** @type {string} */ css) => css.replace(/\/\*[\s\S]*?\*\//g, "");
/** Every rule whose selector list names sel (a class selector as written, e.g. ".btn-sm"). */
const rules = (/** @type {string} */ css, /** @type {string} */ sel) => {
  const esc = sel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`(^|[\\s,(>])${esc}(?![\\w-])`);
  return [...noComments(css).matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter(m => re.test(m[1])).map(m => m[2]);
};
const decl = (/** @type {string} */ css, /** @type {string} */ sel, /** @type {RegExp} */ want) =>
  assert.ok(rules(css, sel).some(b => want.test(b)), `${sel} has ${want}`);

// ---- buttons ---------------------------------------------------------------------------------

test("buttons: every variant is drawn with the spec's colours", () => {
  const css = read("css/buttons.css");
  decl(css, ".button-primary", /background: var\(--primary-bg\); border-color: var\(--primary-bg\); color: var\(--primary-ink\)/);
  decl(css, ".button-secondary", /background: var\(--hover\); border-color: var\(--hover\); color: var\(--text\)/);
  decl(css, ".button-outline", /border-color: var\(--rule-strong\); color: var\(--text\)/);
  decl(css, ".button-ghost", /border-color: transparent; color: var\(--text\)/);
  decl(css, ".button-hold", /border-color: var\(--text\)/);
  decl(css, ".button-hold", /transition-duration: var\(--motion-hold, 600ms\)/);
});

test("buttons: four heights, from the control tokens with the spec values as fallbacks", () => {
  const css = read("css/buttons.css");
  decl(css, ".button-xs", /height: var\(--control-xs, 28px\)/);
  decl(css, ".button-sm", /height: var\(--control-sm, 32px\)/);
  decl(css, ".button-touch", /min-height: var\(--control-touch, 44px\).*border-radius: var\(--radius-button-touch, 10px\)/s);
  decl(css, ".button-touch-lg", /min-height: var\(--control-touch-lg, 54px\).*border-radius: var\(--radius-card, 12px\)/s);
  decl(css, ".button", /border-radius: var\(--radius-button, 8px\)/);
  // Every var() that names a size, radius, space, line, control or motion token carries a fallback.
  for (const m of noComments(css).matchAll(/var\(--(control|radius|size|line|space|motion|ease)[\w-]*\s*([,)])/g)) assert.equal(m[2], ",", `${m[0]} has a fallback`);
});

test("buttons: sentence case in Instrument Sans 600, never mono caps", () => {
  const css = read("css/buttons.css");
  decl(css, ".button", /font-family: var\(--sans\); font-size: var\(--size-base, 13px\); line-height: var\(--line-base, 18px\); font-weight: 600/);
  decl(css, ".button", /text-transform: none/);
  assert.doesNotMatch(noComments(css), /uppercase|var\(--mono\)/);
  assert.doesNotMatch(noComments(read("css/deck.css")), /^\.(btn|ibtn)[\w-]*[\s{,.:]/m, "deck.css no longer draws buttons (only views place them)");
});

test("buttons: busy locks the button and shows the spinner; disabled is ink on a quiet fill, not opacity", () => {
  const css = read("css/buttons.css");
  decl(css, '.button[aria-busy="true"]', /pointer-events: none/);
  decl(css, ".button-spin", /width: 14px; height: 14px/);
  decl(css, ".button-spin", /border: 1\.5px solid var\(--rule-strong\); border-top-color: var\(--text-2\)/);
  assert.match(noComments(css), /\.button-primary \.button-spin[^{]*\{ border-color: var\(--primary-hover\); border-top-color: var\(--primary-ink\)/);
  decl(css, ".button:disabled", /opacity: 1; background: transparent; border-color: var\(--rule\); color: var\(--label\)/);
  decl(css, ".button-primary:disabled", /background: var\(--hover\); border-color: var\(--hover\); color: var\(--label\)/);
  assert.match(noComments(css), /prefers-reduced-motion[\s\S]*\.button-spin \{ animation: none; \}/);
});

test("buttons: the old classes are aliases of the new system", () => {
  const css = read("css/buttons.css");
  const same = (/** @type {string} */ old, /** @type {string} */ now) =>
    assert.ok(rules(css, old).some(b => rules(css, now).includes(b)), `${old} is drawn by the same rule as ${now}`);
  same(".btn", ".button-outline");
  same(".btn-primary", ".button-primary");
  same(".btn-ghost", ".button-ghost");
  same(".btn-sm", ".button-xs");
  same(".sb", ".button-secondary");
  same(".sb", ".button-touch");
  same(".sb-full", ".button-full");
  same(".ibtn", ".icon-button");
  assert.doesNotMatch(noComments(read("css/sheet.css")), /^\.sb[\s.:{]|opacity: 0\.45/m, "sheet.css has no second button system");
});

test("buttons: on the phone every button and icon button is at least 44", () => {
  const css = read("css/buttons.css");
  const phone = noComments(css).split("@media (max-width: 719px), (max-height: 500px) and (pointer: coarse) {").slice(1).join("\n");
  assert.match(phone, /\.button, \.btn \{[^}]*min-height: var\(--control-touch, 44px\)/);
  assert.match(phone, /\.ibtn::after \{[^}]*inset: min\(0px, calc\(\(100% - var\(--control-touch, 44px\)\) \/ 2\)\)/);
});

test("buttons: buttons.css is linked right after deck.css on every page and kept at install", () => {
  for (const page of ["index.html", "onboard/index.html", "onboard/passkey/index.html"]) {
    assert.match(read(page), /<link rel="stylesheet" href="\/css\/deck.css">\n\s*<link rel="stylesheet" href="\/css\/buttons.css">/, page);
  }
  assert.match(read("sw.js"), /"\/css\/deck.css", "\/css\/buttons.css"/);
});

test("button.js: builds the variant and size, holds its width while busy, and gives it back", async () => {
  const { install } = await import("./fake-dom.js");
  install();
  const { button, setBusy } = await import("../js/button.js");
  const b = button({ label: "Send", variant: "primary", size: "touch", keyHint: "⌘⏎", keys: "Meta+Enter" });
  assert.equal(b.className, "button button-primary button-touch");
  assert.equal(b.getAttribute("aria-keyshortcuts"), "Meta+Enter");
  assert.equal(b.querySelector(".button-key")?.getAttribute("aria-hidden"), "true");
  setBusy(b, "Sending");
  assert.equal(b.getAttribute("aria-busy"), "true");
  assert.ok(b.querySelector(".button-spin"));
  assert.equal(b.querySelector(".button-label")?.textContent, "Sending");
  setBusy(b, false);
  assert.equal(b.getAttribute("aria-busy"), null);
  assert.equal(b.querySelector(".button-label")?.textContent, "Send");
  assert.equal(button({ label: "Delete 214 files", variant: "hold" }).getAttribute("aria-description"), "Hold for 0.6 seconds");
  assert.equal(button({ label: "Cancel", variant: /** @type {any} */ ("danger") }).className, "button button-outline", "no variant outside the five");
});

// ---- status marks ----------------------------------------------------------------------------

test("status-mark: the right mark for each status, most urgent first, named by its word", async () => {
  const { install } = await import("./fake-dom.js");
  install();
  const { statusMark, statusOf, worst, ORDER, WORDS, elapsed } = await import("../js/status-mark.js");
  assert.deepEqual([...ORDER], ["needs", "failed", "running", "unread", "done"]);
  for (const s of ORDER) {
    const m = statusMark(s);
    assert.equal(m.className, `sm sm-${s}`);
    assert.equal(m.getAttribute("role"), "img");
    assert.equal(m.getAttribute("aria-label"), WORDS[s]);
  }
  assert.equal(WORDS.needs, "needs you");
  // Session state words map onto the five.
  assert.equal(statusOf("waiting"), "needs");
  assert.equal(statusOf("starting"), "running");
  assert.equal(statusOf("stopped"), "done");
  assert.equal(statusOf("idle"), "done");
  assert.equal(worst(["done", "running", "failed"]), "failed");
  assert.equal(worst(["unread", "waiting"]), "needs");
  assert.equal(worst([]), null);
  // Running carries elapsed time; the word beside hides the mark.
  const line = statusMark("running", { word: true, since: 0, now: 4 * 60_000 });
  assert.equal(line.className, "st");
  assert.equal(line.textContent, "running · 4m");
  assert.equal(line.querySelector(".sm")?.getAttribute("aria-hidden"), "true");
  assert.equal(statusMark("failed", { beside: true }).getAttribute("aria-hidden"), "true");
  assert.deepEqual([elapsed(12_000), elapsed(4 * 60_000), elapsed(72 * 60_000)], ["12s", "4m", "1h 12m"]);
});

test("status-mark: the badge caps at 99+, says who waits, and hides at 0; path marks for direct, relayed and none", async () => {
  const { install } = await import("./fake-dom.js");
  install();
  const { badge, count, pathMark } = await import("../js/status-mark.js");
  const b = badge(3);
  assert.equal(b.textContent, "3");
  assert.equal(b.getAttribute("aria-label"), "3 need you");
  badge(128, b);
  assert.equal(b.textContent, "99+");
  assert.equal(b.getAttribute("aria-label"), "more than 99 need you");
  badge(0, b);
  assert.equal(b.hidden, true);
  assert.equal(count(214).className, "sm-count");
  assert.equal(pathMark("direct").className, "sm sm-path-direct");
  assert.equal(pathMark("relay").className, "sm sm-path-relayed");
  assert.equal(pathMark("peer-relay").className, "sm sm-path-relayed");
  assert.equal(pathMark("unknown").className, "sm sm-path-none");
});

test("status-mark: failed and relayed never take the attention colour or amber; marks never animate", () => {
  const css = read("css/marks.css");
  const bad = /--beacon|--recall|--signal\b|#EBC76B|violet|amber|gold/i;
  for (const sel of [".sm-failed", ".sm-path-relayed", ".dot.health-relayed", ".sm-path-none", ".sm-count"]) {
    const found = rules(css, sel);
    assert.ok(found.length, `${sel} is drawn`);
    for (const r of found) assert.doesNotMatch(r, bad, `${sel}: ${r}`);
  }
  decl(css, ".sm-failed", /width: 12px; height: 12px; border: 1\.5px solid var\(--text-2\)/);
  decl(css, ".sm-running", /width: 10px; height: 10px; border: 1\.5px solid var\(--focus\); background: transparent/);
  decl(css, ".sm-done", /box-shadow: inset 0 0 0 1\.5px var\(--label\)/);
  decl(css, ".sm-unread", /background: var\(--text\)/);
  decl(css, ".sm-needs", /width: 8px; height: 8px; background: var\(--beacon-dot\)/);
  decl(css, ".sm-badge", /height: 18px; min-width: 18px; padding: 0 5px/);
  assert.doesNotMatch(noComments(css), /animation|transition/);
  // The old dots are aliases, and deck.css no longer paints a path amber.
  decl(css, ".dot.beacon", /background: var\(--beacon-dot\)/);
  decl(css, ".dot.health-relayed", /background: var\(--label\)/);
  assert.doesNotMatch(noComments(read("css/deck.css")), /\.dot\.health-/);
  assert.match(read("index.html"), /href="\/css\/buttons.css">\n\s*<link rel="stylesheet" href="\/css\/marks.css">/);
  assert.match(read("sw.js"), /"\/css\/marks.css", "\/js\/status-mark.js"/);
});

// ---- the toast -------------------------------------------------------------------------------

test("toast: one module; Now and the vault use it and draw none of their own", () => {
  const files = [];
  const walk = (/** @type {string} */ d) => {
    for (const e of fs.readdirSync(path.join(DECK, d), { withFileTypes: true })) {
      const rel = path.posix.join(d, e.name);
      if (e.isDirectory()) { if (!/^(test|vendor|node_modules|fonts)$/.test(e.name)) walk(rel); }
      else if (/\.(js|css)$/.test(e.name) && !/\.test\.js$/.test(e.name)) files.push(rel);
    }
  };
  walk(".");
  const drawers = files.filter(f => f !== "js/toast.js" && /class: "(?:[^"]*\s)?(?:np-|vt-)?toast["\s]/.test(read(f)));
  assert.deepEqual(drawers, [], "only js/toast.js builds a toast element");
  const styled = files.filter(f => f.endsWith(".css") && f !== "css/toast.css" && /^\.[\w-]*toast[\w-]*\s*\{[^}]*position: fixed/m.test(read(f)));
  assert.deepEqual(styled, [], "only css/toast.css positions a toast");
  assert.match(read("js/now-phone.js"), /^import \{ showToast, UNDO_MS \} from "\.\/toast\.js";/m);
  assert.match(read("vault/ui.js"), /^import \{ showToast \} from "\.\.\/js\/toast\.js";/m);
  assert.match(read("index.html"), /href="\/css\/marks.css">\n\s*<link rel="stylesheet" href="\/css\/toast.css">/);
  assert.match(read("sw.js"), /"\/css\/toast.css", "\/js\/toast.js"/);
});

test("toast: 4 s, polite, one at a time; Undo and Cmd+Z undo, and hover pauses", async () => {
  const dom = await import("./fake-dom.js");
  const doc = dom.install();
  /** @type {Map<string, Function>} */ const keys = new Map();
  doc.addEventListener = (/** @type {string} */ t, /** @type {Function} */ f) => keys.set(t, f);
  doc.removeEventListener = (/** @type {string} */ t) => keys.delete(t);
  const { showToast, currentToast, UNDO_MS, RESUME_MS } = await import("../js/toast.js");
  assert.equal(UNDO_MS, 4000);
  assert.equal(RESUME_MS, 2000);
  const { mock } = await import("node:test");
  mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
  try {
    let undone = 0, why = "";
    const t = showToast({ text: "Denied", undo: () => { undone++; }, onClose: w => { why = w; } });
    assert.equal(t.el.getAttribute("role"), "status");
    assert.equal(t.el.getAttribute("aria-live"), "polite");
    assert.equal(t.el.parentNode, doc.body);
    assert.equal(t.el.querySelector(".toast-undo")?.className, "button button-ghost button-xs toast-undo", "Undo is a ghost button, never primary");
    await /** @type {any} */ (t.el.querySelector(".toast-undo")).click();
    assert.equal(undone, 1);
    assert.equal(why, "undo");
    assert.equal(currentToast(), null);

    // A new toast replaces the old; Cmd+Z undoes the one that is up.
    const a = showToast({ text: "Discarded", undo: () => { undone++; } });
    const b = showToast({ text: "Hidden here for an hour", undo: () => { undone += 10; } });
    assert.equal(a.open, false);
    assert.equal(a.el.parentNode, null);
    keys.get("keydown")?.({ key: "z", metaKey: true, preventDefault() {} });
    assert.equal(undone, 11);
    assert.equal(b.open, false);
    assert.equal(keys.has("keydown"), false, "the shortcut goes with the toast");

    // It closes itself after 4 s; hover pauses it, and leaving restarts it at 2 s.
    const c = showToast({ text: "Approved" });
    mock.timers.tick(1000);
    c.el.dispatchEvent(new Event("pointerenter"));
    mock.timers.tick(10_000);
    assert.equal(c.open, true, "paused under the pointer");
    c.el.dispatchEvent(new Event("pointerleave"));
    mock.timers.tick(1999);
    assert.equal(c.open, true);
    mock.timers.tick(1);
    assert.equal(c.open, false);

    // In place: it takes the row's slot.
    const slot = doc.createElement("div");
    const d = showToast({ text: "Removed npm run lint", undo: () => {}, slot });
    assert.equal(d.el.parentNode, slot);
    assert.match(d.el.className, /toast-inplace/);
    assert.ok(d.el.querySelector(".toast-check"));
    mock.timers.tick(UNDO_MS);
    assert.equal(d.open, false);
  } finally {
    mock.timers.reset();
  }
});

test("toast: the look follows the spec (float shadow, 480 max, 44 tall, 24 above Lumen)", () => {
  const css = read("css/toast.css");
  decl(css, ".toast-float", /max-width: min\(480px, calc\(100vw - 32px\)\); min-height: var\(--control-touch, 44px\)/);
  decl(css, ".toast-float", /border-radius: var\(--radius-card, 12px\); box-shadow: var\(--float\)/);
  decl(css, ".toast-float", /animation: toast-in var\(--motion-panel, 220ms\)/);
  decl(css, ".toast-float", /bottom: calc\(var\(--cap-bottom, 12px\) \+ var\(--cap-h, 56px\) \+ 24px\)/);
  decl(css, ".toast-inplace", /height: var\(--control-touch, 44px\); gap: 10px; padding: 0 14px; background: var\(--hover\); border-top: 1px solid var\(--rule\)/);
  assert.doesNotMatch(noComments(css), /--light-top|--primary|--beacon|--focus/);
});
