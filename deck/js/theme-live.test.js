// @ts-check
// js/theme-live.js: the Deck follows the settings hub's theme (ADR 0035 section 5) with no reload
// and no flash, reads again only when rev moved, and leaves a box without the hub as it was.

import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { themeHref, schemeFor, repaints, followTheme } from "./theme-live.js";

const tick = () => new Promise(r => setTimeout(r, 0));

/** A document with a head of links, enough for followTheme. */
function fakeDoc() {
  /** @type {any[]} */ const links = [];
  const mk = () => {
    /** @type {Record<string, Function>} */ const on = {};
    const l = { rel: "", _href: "", get href() { return this._href; }, set href(v) { this._href = v; },
      getAttribute: (/** @type {string} */ k) => k === "href" ? l._href : null,
      addEventListener: (/** @type {string} */ t, /** @type {Function} */ f) => { on[t] = f; },
      fire: (/** @type {string} */ t) => on[t]?.(),
      after: (/** @type {any} */ n) => { links.splice(links.indexOf(l) + 1, 0, n); },
      remove: () => { const i = links.indexOf(l); if (i >= 0) links.splice(i, 1); } };
    return l;
  };
  const first = mk(); first.rel = "stylesheet"; first.href = "/theme.css"; links.push(first);
  const doc = {
    documentElement: { dataset: /** @type {Record<string, string>} */ ({}) },
    head: { append: (/** @type {any} */ n) => links.push(n) },
    createElement: () => mk(),
    querySelectorAll: () => links.filter(l => l.rel === "stylesheet" && String(l.href).startsWith("/theme.css")),
  };
  return { doc: /** @type {any} */ (doc), links };
}

/** The hub: snapshot answers in order; events and resumes fed by hand. */
function fakeHub(/** @type {any[]} */ answers) {
  /** @type {any[]} */ const asked = [];
  /** @type {Map<string, Function>} */ const subs = new Map();
  /** @type {Function[]} */ const resumes = [];
  return {
    asked, emit: (/** @type {any} */ e) => subs.get(e.type)?.(e), resume: () => resumes.forEach(f => f("reconnect")),
    deps: {
      attempt: async (/** @type {string} */ name, /** @type {any} */ input) => { asked.push([name, input]); return answers.length > 1 ? answers.shift() : answers[0]; },
      on: (/** @type {string} */ t, /** @type {Function} */ f) => { subs.set(t, f); return () => subs.delete(t); },
      onResume: (/** @type {Function} */ f) => { resumes.push(f); return () => {}; },
    },
  };
}
const media = (/** @type {boolean} */ light) => () => ({ matches: light, addEventListener() {}, removeEventListener() {} });

test("themeHref: the device and rev when known, plain /theme.css without them", () => {
  assert.equal(themeHref({}), "/theme.css");
  assert.equal(themeHref({ rev: 42 }), "/theme.css?rev=42");
  assert.equal(themeHref({ device: "device:2uwffior5lehgnfh", rev: 7 }), "/theme.css?device=tailnet%3Aalex-phone&rev=7");
});

test("schemeFor: paper, dark, system follows the OS, anything else leaves the device's own choice", () => {
  assert.equal(schemeFor("paper", false), "paper");
  assert.equal(schemeFor("dark", true), "dark");
  assert.equal(schemeFor("system", true), "paper");
  assert.equal(schemeFor("system", false), "dark");
  assert.equal(schemeFor(undefined, true), null);
});

test("repaints: only appearance.* keys", () => {
  assert.equal(repaints({ payload: { key: "appearance.scheme" } }), true);
  assert.equal(repaints({ payload: { key: "sessions.effort" } }), false);
  assert.equal(repaints({}), false);
});

test("start: the snapshot's rev and device go on the link; the old sheet leaves only once the new one loaded", async () => {
  const { doc, links } = fakeDoc();
  const hub = fakeHub([{ data: { rev: 42, device: "device:2uwffior5lehgnfh", values: { "appearance.scheme": "paper" } } }]);
  const kept = new Map([["vyre.theme", "dark-old"]]);
  followTheme({ ...hub.deps, doc, media: media(false), store: { setItem: (k, v) => kept.set(k, v), removeItem: k => kept.delete(k) } });
  await tick();
  assert.equal(kept.get("vyre.theme"), "paper", "the saved choice follows the hub, so the next launch paints it first");
  assert.deepEqual(hub.asked, [["settings.snapshot", {}]]);
  assert.deepEqual(links.map(l => l.href), ["/theme.css", "/theme.css?device=tailnet%3Aalex-phone&rev=42"], "both while the new one loads: no flash");
  links[1].fire("load");
  assert.deepEqual(links.map(l => l.href), ["/theme.css?device=tailnet%3Aalex-phone&rev=42"]);
  assert.equal(doc.documentElement.dataset.theme, "paper");
});

test("settings.changed: an appearance key reads again and swaps; another key or another device's change does nothing", async () => {
  const { doc, links } = fakeDoc();
  const hub = fakeHub([{ data: { rev: 1, device: "device:gpzhvr7irq45zdmx", values: {} } }, { data: { rev: 2, device: "device:gpzhvr7irq45zdmx", values: { "appearance.scheme": "dark" } } }]);
  doc.documentElement.dataset.theme = "paper";
  followTheme({ ...hub.deps, doc, media: media(true) });
  await tick();
  links[1].fire("load");
  assert.equal(doc.documentElement.dataset.theme, "paper", "no hub value: the device's own choice stands");
  hub.emit({ type: "settings.changed", payload: { key: "sessions.effort", rev: 2 } });
  hub.emit({ type: "settings.changed", payload: { key: "appearance.scheme", device: "device:2uwffior5lehgnfh", rev: 2 } });
  await tick();
  assert.equal(hub.asked.length, 1, "neither is this device's theme");
  hub.emit({ type: "settings.changed", payload: { key: "appearance.scheme", device: "device:gpzhvr7irq45zdmx", level: "device", rev: 2 } });
  await tick();
  assert.equal(hub.asked.length, 2);
  assert.equal(links.at(-1).href, "/theme.css?device=tailnet%3Aalex-mbp&rev=2");
  assert.equal(doc.documentElement.dataset.theme, undefined, "dark");
});

test("reconnect: the same rev reads once and changes nothing; a moved rev swaps", async () => {
  const { doc, links } = fakeDoc();
  const hub = fakeHub([{ data: { rev: 5, values: {} } }, { data: { rev: 5, values: {} } }, { data: { rev: 6, values: {} } }]);
  followTheme({ ...hub.deps, doc, media: media(false) });
  await tick();
  links[1].fire("load");
  hub.resume();
  await tick();
  assert.deepEqual(links.map(l => l.href), ["/theme.css?rev=5"], "same rev: no new link");
  hub.resume();
  await tick();
  assert.equal(links.at(-1).href, "/theme.css?rev=6");
});

test("a server without the hub: /theme.css and the device's scheme stay, and it is not asked again", async () => {
  const { doc, links } = fakeDoc();
  const hub = fakeHub([{ error: { code: "no_such_tool" } }]);
  doc.documentElement.dataset.theme = "paper";
  followTheme({ ...hub.deps, doc, media: media(false) });
  await tick();
  hub.resume();
  hub.emit({ type: "settings.changed", payload: { key: "appearance.scheme" } });
  await tick();
  assert.equal(hub.asked.length, 1);
  assert.deepEqual(links.map(l => l.href), ["/theme.css"]);
  assert.equal(doc.documentElement.dataset.theme, "paper");
});
