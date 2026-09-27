// @ts-check
// The Deck-wide components of Design A v1 (docs/design/system/components): the one button system
// in css/buttons.css, with the old class names kept as its aliases.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DECK = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (/** @type {string} */ f) => fs.readFileSync(path.join(DECK, f), "utf8");
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
  const phone = noComments(css).split("@media (max-width: 760px), (max-height: 500px) and (pointer: coarse) {").slice(1).join("\n");
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
