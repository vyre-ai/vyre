// @ts-check
// js/avatars.js: the four families of ADR 0043, each seeded as the ADR says, each its own
// silhouette; the parse cache; unique gradient ids per copy; the fallbacks when a fingerprint is
// missing (never a crash, never a ring from a made-up seed); and the tap's hop honouring Reduce
// Motion. Synthetic ids only (the sample world: alex, kit, juno).

import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { install } from "../test/fake-dom.js";

const document = install();
const define = (/** @type {string} */ k, /** @type {any} */ v) => Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true });
/** @type {any} */ (document).importNode = (/** @type {any} */ n) => deepCopy(n);

/** The fake DOM has no cloneNode: copy a fake element and its children by hand. */
function deepCopy(/** @type {any} */ n) {
  const E = /** @type {any} */ (globalThis).Element;
  if (!(n instanceof E)) return n;
  const c = new E(n.tagName.toLowerCase());
  for (const [k, v] of n.attrs) c.setAttribute(k, v);
  for (const k of n.childNodes) c.append(deepCopy(k));
  return c;
}

let parses = 0;
/** A stand-in parser: an <svg> holding a gradient with the source's first id and a circle using it. */
define("DOMParser", class {
  parseFromString(/** @type {string} */ src) {
    parses++;
    const E = /** @type {any} */ (globalThis).Element;
    const svg = new E("svg");
    svg.setAttribute("data-src", src);
    const id = /id="([^"]+)"/.exec(src)?.[1];
    if (id) {
      const g = new E("radialGradient"); g.setAttribute("id", id); svg.append(g);
      const c = new E("circle"); c.setAttribute("fill", `url(#${id})`); svg.append(c);
    }
    return { documentElement: svg };
  }
});

const av = await import("./avatars.js");
const { fingerprintHex, fp8 } = {
  fingerprintHex: (/** @type {string} */ prefix, /** @type {string} */ id) => createHash("sha256").update(prefix + id).digest("hex").slice(0, 16),
  fp8: (/** @type {string} */ hex) => Array.from({ length: 8 }, (_, i) => parseInt(hex.slice(i * 2, i * 2 + 2), 16)),
};
const OWNER_ID = "00112233445566778899aabbccddeeff"; // a made-up owner.id (16 bytes, hex)
const personHex = fingerprintHex("vyre:person:v1:", OWNER_ID);
const assistantHex = fingerprintHex("vyre:assistant:v1:", OWNER_ID);

test("fpBytes: 16 hex chars are the 8 bytes; a 4-byte (8 hex) or missing value is null", () => {
  assert.deepEqual(av.fpBytes(personHex), fp8(personHex));
  assert.equal(av.fpBytes(personHex.slice(0, 8)), null);
  assert.equal(av.fpBytes(null), null);
  assert.equal(av.fpBytes("not hex at all!!"), null);
});

test("four families, four silhouettes, each deterministic from its seed", () => {
  const p = av.avatarSource("person", "x", 120, { fp: fp8(personHex) });
  const a = av.avatarSource("assistant", assistantHex, 120);
  const b = av.avatarSource("agent", "kit", 120);
  const t = av.avatarSource("teammate", "design-harlow", 40);
  assert.match(p, /<circle cx="60" cy="60" r="58"/, "the person is a true circle");
  assert.match(a, /opacity="0\.18"/, "the assistant creature has its glow halo");
  assert.match(b, /<path d="M [\d.]+,[\d.]+ Q/, "an agent is a blob path");
  assert.match(t, /<rect x="30" y="58"/, "a teammate is a character with a body");
  assert.equal(new Set([p, a, b, t]).size, 4);
  assert.equal(av.avatarSource("agent", "kit", 120), b, "same seed, same drawing");
  assert.notEqual(av.avatarSource("agent", "juno", 120), b, "another agent, another blob");
  assert.notEqual(av.avatarSource("teammate", "docs-harlow", 40), t);
});

test("the person's default look is fingerprint byte 0 mod the option count (ADR 0043 2d)", () => {
  const fp = fp8(personHex);
  const want = av.avatarSource("person", "", 120, { option: fp[0] % av.PERSON_OPTIONS });
  assert.equal(av.avatarSource("person", "ignored", 120, { fp }), want);
});

test("the Vyre code ring: only with a real fingerprint and at RING_AT or above", () => {
  const fp = fp8(personHex);
  const ring = av.avatarSource("person", "", 200, { fp, ring: true });
  assert.match(ring, /viewBox="0 0 600 600"/, "the ring's 600 canvas");
  assert.match(av.avatarSource("person", "", 200, { fp: null, ring: true }), /viewBox="0 0 120 120"/, "no fingerprint, no ring");
  av._reset();
  av.setIdentity({ owner: { name: "alex", fingerprint8: personHex } });
  assert.ok(av.personAvatar({ size: 160, ring: true }).getAttribute("class").includes("vy-av-ring"));
  assert.ok(!av.personAvatar({ size: 40, ring: true }).getAttribute("class").includes("vy-av-ring"), "everyday sizes are the face alone");
  av.setIdentity({ owner: { name: "alex", fingerprint8: null } });
  assert.ok(!av.personAvatar({ size: 160, ring: true }).getAttribute("class").includes("vy-av-ring"), "a fallback never draws a ring");
});

test("no owner.id yet: person and assistant still draw, from their names", () => {
  av._reset();
  av.setIdentity({ owner: null, assistant: null });
  const p = av.personAvatar({ size: 24 });
  const a = av.assistantAvatar({ size: 24 });
  assert.equal(p.getAttribute("data-family"), "person");
  assert.equal(a.getAttribute("data-family"), "assistant");
  assert.ok(p.childNodes.length && a.childNodes.length);
});

test("the assistant is seeded from its own fingerprint, never the person's", () => {
  av._reset();
  av.setIdentity({ owner: { fingerprint8: personHex }, assistant: { name: "juno", fingerprint8: assistantHex } });
  const src = /** @type {any} */ (av.assistantAvatar({ size: 24 }).firstChild).getAttribute("data-src");
  assert.equal(src, av.avatarSource("assistant", assistantHex, 120));
  assert.notEqual(src, av.avatarSource("assistant", personHex, 120));
});

test("one parse per author: later rows clone the cached template", () => {
  av._reset();
  const before = parses;
  for (let i = 0; i < 500; i++) av.agentAvatar("kit");
  assert.equal(parses - before, 1);
  av.agentAvatar("juno");
  assert.equal(parses - before, 2);
});

test("each copy gets its own gradient id, and its fill follows", () => {
  av._reset();
  av.setIdentity({ owner: { name: "alex", fingerprint8: personHex } });
  const one = /** @type {any} */ (av.personAvatar({ size: 24 }).firstChild);
  const two = /** @type {any} */ (av.personAvatar({ size: 24 }).firstChild);
  const id1 = one.querySelector("radialGradient").getAttribute("id"), id2 = two.querySelector("radialGradient").getAttribute("id");
  assert.notEqual(id1, id2);
  assert.equal(one.querySelector("circle").getAttribute("fill"), `url(#${id1})`);
  assert.equal(two.querySelector("circle").getAttribute("fill"), `url(#${id2})`);
});

test("team.list marks teammates: their agent id draws a character, others a blob", () => {
  av._reset();
  av.setTeammates(["design-harlow"]);
  assert.equal(av.agentAvatar("design-harlow").getAttribute("data-family"), "teammate");
  assert.equal(av.agentAvatar("kit").getAttribute("data-family"), "agent");
  av.setIdentity({ assistant: { name: "juno" } });
  assert.equal(av.whoAvatar("juno").getAttribute("data-family"), "assistant");
  assert.equal(av.whoAvatar(null).getAttribute("data-family"), "assistant");
  assert.equal(av.whoAvatar("claude-code").getAttribute("data-family"), "assistant");
});

test("teammateId matches core/team's agentName: <role>-<project>, 31 chars, no trailing dash", () => {
  assert.equal(av.teammateId("design", "harlow"), "design-harlow");
  assert.equal(av.teammateId("reviewer", "northwind-bakery-website-rebuild"), "reviewer-northwind-bakery-websi");
  assert.equal(av.teammateId("docs", "abcdefghijklmnopqrstuvwxy-z"), "docs-abcdefghijklmnopqrstuvwxy");
  assert.equal(av.teammateId("design", null), "design");
});

test("without a DOM parser an avatar is its initial, not a crash", async () => {
  av._reset();
  const saved = /** @type {any} */ (globalThis).DOMParser;
  define("DOMParser", undefined);
  try {
    const el = av.agentAvatar("kit", { title: "kit" });
    assert.equal(el.textContent, "k");
  } finally { define("DOMParser", saved); }
});

test("decorative by default, an image when labelled", () => {
  assert.equal(av.agentAvatar("kit").getAttribute("aria-hidden"), "true");
  const l = av.personAvatar({ label: "Your avatar, alex" });
  assert.equal(l.getAttribute("role"), "img");
  assert.equal(l.getAttribute("aria-label"), "Your avatar, alex");
});

test("a tap plays the hop, and Reduce Motion keeps it still", () => {
  /** @type {Record<string, Function>} */ const on = {};
  const doc = /** @type {any} */ ({ addEventListener: (/** @type {string} */ k, /** @type {Function} */ f) => { on[k] = f; } });
  let still = false;
  define("matchMedia", () => ({ get matches() { return still; } }));
  av.installAvatarMotion(doc);
  const el = av.agentAvatar("kit");
  on.click({ target: el });
  assert.ok(el.classList.contains("vy-av-play"));
  on.animationend({ target: el });
  assert.ok(!el.classList.contains("vy-av-play"));
  still = true;
  on.click({ target: el });
  assert.ok(!el.classList.contains("vy-av-play"));
});
