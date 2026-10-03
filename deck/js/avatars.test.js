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
const { fingerprint8, toBase64url } = await import("../../lib/identity.js");
const OWNER_ID = "00112233445566778899aabbccddeeff"; // a made-up owner.id (16 bytes, hex)
// system.info's own encoding, from the box's own helper: base64url of the first 8 bytes.
const personHex = toBase64url(fingerprint8(OWNER_ID, "person"));
const assistantHex = toBase64url(fingerprint8(OWNER_ID, "assistant"));
const fp8 = (/** @type {string} */ b64) => [...Buffer.from(b64, "base64url")];

test("fpBytes decodes system.info's base64url fingerprint to lib/identity's own 8 bytes; anything else is null", () => {
  assert.equal(personHex.length, 11);
  assert.deepEqual(av.fpBytes(personHex), [...fingerprint8(OWNER_ID, "person")]);
  assert.deepEqual(av.fpBytes(assistantHex), [...fingerprint8(OWNER_ID, "assistant")]);
  assert.equal(av.fpBytes(personHex.slice(0, 6)), null, "4 bytes (the first cut's bug) is not a fingerprint");
  assert.equal(av.fpBytes(createHash("sha256").update("x").digest("hex").slice(0, 16)), null, "hex is not the wire format");
  assert.equal(av.fpBytes(null), null);
  assert.equal(av.fpBytes("not base64!"), null);
});

test("four families, four silhouettes, each deterministic from its seed", () => {
  const p = av.avatarSource("person", "x", 120, { fp: fp8(personHex) });
  const a = av.avatarSource("assistant", assistantHex, 120);
  const b = av.avatarSource("agent", "kit", 120);
  const t = av.avatarSource("teammate", "design-harlow", 40);
  assert.match(p, /<circle cx="60" cy="60" r="58"/, "the person is a true circle");
  assert.match(a, /opacity="0\.18"/, "the assistant creature has its glow halo");
  assert.match(b, /<path d="M[\d.]+ [\d.]+ L[\d.]+ [\d.]+ L[^"]+Z" fill="url\(#a[a-z0-9]+\)" stroke="#[0-9a-f]{6}" stroke-width="2.6"/, "an agent is a superellipse body with one light and one 2.6 rim (v2)");
  assert.match(t, /<rect x="30" y="58"/, "a teammate is a character with a body");
  const pj = av.avatarSource("project", "harlow-legal", 120);
  assert.match(pj, /<rect x="2" y="2" width="116" height="116" rx="30"/, "a project is a filled tile");
  assert.doesNotMatch(pj, /stroke-dasharray/);
  assert.match(av.avatarSource("project", "harlow-legal", 120, { draft: true }), /stroke-dasharray/, "a draft tile is dashed");
  assert.equal(new Set([p, a, b, t, pj]).size, 5);
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

test("Wink ring on every family (design-system.md step 6): same ring, the family's own mark in the centre, only at RING_AT and above", async () => {
  const { projectBytes, entityBytes } = await import("../../lib/avatar-seed/index.js");
  const fp = fp8(assistantHex);
  const ringed = (/** @type {any} */ family, /** @type {string} */ seed, /** @type {any} */ o = {}) => av.avatarSource(family, seed, 210, { ring: true, ...o });
  for (const [family, seed, o] of /** @type {[any, string, any][]} */ ([["agent", "juno", {}], ["teammate", "reviewer-northwind", { color: "#2F93DA" }], ["project", "northwind", {}], ["assistant", "x", { fp }]])) {
    const svg = ringed(family, seed, o);
    assert.match(svg, /viewBox="0 0 600 600"/, `${family}: the ring's 600 canvas`);
    assert.ok((svg.match(/<line /g) || []).length >= 72, `${family}: the 72 ticks`);
    assert.match(svg, /id="vy-cc"/, `${family}: the mark sits inside the clear centre`);
    assert.doesNotMatch(av.avatarSource(family, seed, 210, o), /viewBox="0 0 600 600"/, `${family}: no ring unless asked`);
  }
  assert.deepEqual(av.ringBytes("project", "northwind"), projectBytes("northwind"), "a project carries the bytes its emblem is drawn from");
  assert.deepEqual(av.ringBytes("agent", "juno"), entityBytes("agent", "juno"));
  assert.deepEqual(av.ringBytes("assistant", "x", { fp }), fp, "the assistant carries its real fingerprint");
  assert.equal(av.ringBytes("assistant", "x", { fp: null }), null, "no fingerprint, no ring");
  assert.equal(av.ringBytes("project", "chat-1", { draft: true }), null, "a draft tile is no identity yet");
  assert.doesNotMatch(av.avatarSource("project", "chat-1", 210, { ring: true, draft: true }), /viewBox="0 0 600 600"/);
  av._reset();
  av.setIdentity({});
  for (const make of [() => av.agentAvatar("juno", { size: 210, ring: true }), () => av.projectAvatar("northwind", { size: 210, ring: true }), () => av.teammateAvatar("reviewer-northwind", { size: 210, ring: true })])
    assert.ok(make().getAttribute("class").includes("vy-av-ring"));
  assert.ok(!av.agentAvatar("juno", { size: 40, ring: true }).getAttribute("class").includes("vy-av-ring"), "everyday sizes are the mark alone");
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
  const hex = (/** @type {string} */ b64) => Buffer.from(b64, "base64url").toString("hex");
  assert.equal(src, av.avatarSource("assistant", hex(assistantHex), 120));
  assert.notEqual(src, av.avatarSource("assistant", hex(personHex), 120));
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
  av.setTeammates([{ agent: "design-harlow", project: "harlow" }]);
  assert.equal(av.agentAvatar("design-harlow").getAttribute("data-family"), "teammate");
  assert.equal(av.agentAvatar("kit").getAttribute("data-family"), "agent");
  av.setIdentity({ assistant: { name: "juno" } });
  assert.equal(av.whoAvatar("juno").getAttribute("data-family"), "assistant");
  assert.equal(av.whoAvatar(null).getAttribute("data-family"), "assistant");
  assert.equal(av.whoAvatar("claude-code").getAttribute("data-family"), "assistant");
});

test("a chat's draft tile and the project made from it share colour and mark; only the dash changes", () => {
  const bytes = av.projectBytes("9d0e4c1a-chat");
  assert.equal(bytes.length, 8);
  assert.deepEqual(av.projectBytes("9d0e4c1a-chat"), bytes, "stable");
  const draft = av.avatarSource("project", "9d0e4c1a-chat", 120, { draft: true });
  const solid = av.avatarSource("project", "9d0e4c1a-chat", 120);
  const color = av.projectColor("9d0e4c1a-chat");
  assert.ok(draft.includes(color) && solid.includes(color), "the same colour");
  // A project made from the chat stores the chat's id as its avatar_seed (core/projects from_thread).
  av._reset();
  av.setProjects([{ slug: "northwind", avatar_seed: "9d0e4c1a-chat" }, { slug: "harlow-legal" }]);
  assert.equal(av.projectSeed("northwind"), "9d0e4c1a-chat");
  assert.equal(av.projectSeed("harlow-legal"), "harlow-legal", "no stored seed: the slug, never the name");
});

test("threadAvatar: a project session wears the project tile, a loose chat the assistant's creature (never the dashed draft tile), agents and teammates their own, the assistant only in its own thread", () => {
  av._reset();
  av.setIdentity({ assistant: { name: "juno" } });
  av.setTeammates([{ agent: "design-harlow-legal", project: "harlow-legal" }]);
  av.setProjects([{ slug: "harlow-legal", avatar_seed: "hl-seed" }]);
  const fam = (/** @type {any} */ t) => { const e = av.threadAvatar(t); return e.getAttribute("data-family") + (e.hasAttribute("data-draft") ? ":draft" : ""); };
  assert.equal(fam({ agent: null, project: "harlow-legal", thread: "t1" }), "project");
  assert.equal(fam({ agent: "claude-code", project: "harlow-legal", thread: "t1" }), "project");
  assert.equal(fam({ agent: null, project: null, thread: "t2" }), "assistant");
  assert.equal(fam({ agent: "juno", project: null, thread: "t3" }), "assistant");
  assert.equal(fam({ agent: "kit", project: "harlow-legal", thread: "t4" }), "agent");
  assert.equal(fam({ agent: "design-harlow-legal", project: "harlow-legal", thread: "t5" }), "teammate");
  const src = /** @type {any} */ (av.threadAvatar({ agent: null, project: "harlow-legal", thread: "t1" }).firstChild).getAttribute("data-src");
  assert.equal(src, av.avatarSource("project", "hl-seed", 120, { theme: "dark" }), "drawn from the stored seed");
});

test("a teammate wears its project's colour; the theme reaches its rim and the page redraws on a switch", () => {
  av._reset();
  av.setProjects([{ slug: "harlow-legal", avatar_seed: "hl-seed" }]);
  const el = av.teammateAvatar("design-harlow-legal", { size: 40, project: "harlow-legal" });
  const src = /** @type {any} */ (el.firstChild).getAttribute("data-src");
  assert.equal(src, av.avatarSource("teammate", "design-harlow-legal", 40, { theme: "dark", color: av.projectColor("hl-seed") }));
  document.body.append(el);
  /** @type {any} */ (document.documentElement).dataset = { theme: "paper" };
  av.redrawAvatars(/** @type {any} */ (document.documentElement));
  const after = /** @type {any} */ (el.firstChild).getAttribute("data-src");
  assert.equal(after, av.avatarSource("teammate", "design-harlow-legal", 40, { theme: "paper", color: av.projectColor("hl-seed") }));
  assert.notEqual(after, src, "paper draws its own rim");
  /** @type {any} */ (document.documentElement).dataset = {};
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
  av.installAvatars(doc);
  const el = av.agentAvatar("kit");
  on.click({ target: el });
  assert.ok(el.classList.contains("vy-av-play"));
  on.animationend({ target: el });
  assert.ok(!el.classList.contains("vy-av-play"));
  still = true;
  on.click({ target: el });
  assert.ok(!el.classList.contains("vy-av-play"));
});
