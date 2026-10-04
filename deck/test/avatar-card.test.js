// @ts-check
// The emblem, the avatar card's content, which avatars nod, and the message details read from drawn rows.

import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";

async function load() {
  const { install, $, $$, text } = await import("./fake-dom.js");
  install();
  /** @type {any} */ (globalThis).DOMParser = class { parseFromString() { const s = document.createElement("svg"); s.append(document.createElement("circle")); return { documentElement: s }; } };
  /** @type {any} */ (document).importNode = (/** @type {any} */ n) => n;
  /** @type {any} */ (document).createElementNS = (/** @type {string} */ _ns, /** @type {string} */ tag) => document.createElement(tag);
  const card = await import("../js/avatar-card.js");
  const det = await import("../js/message-details.js");
  const { emblem } = await import("../vendor/vyrecode/emblem.js");
  return { ...card, ...det, emblem, $, $$, text };
}

test("emblem: four cells on a ground, the same seed always the same, different seeds differ, a draft is dashed", async () => {
  const { emblem } = await load();
  const a = emblem([3, 5, 0, 1, 2, 3, 5, 0]), b = emblem([3, 5, 0, 1, 2, 3, 5, 0]), c = emblem([9, 2, 4, 6, 7, 1, 9, 3]);
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.match(a, /clip-path="url\(#em\)"/);
  assert.equal((a.match(/<(circle|path|rect) /g) || []).length >= 6, true, "the ground, the clip, four cells");
  const d = emblem([3, 5, 0, 1, 2, 3, 5, 0], { draft: true });
  assert.match(d, /stroke-dasharray/);
  assert.doesNotMatch(d, /clip-path="url/);
});

test("card: each kind says its name, its kind and a way in", async () => {
  const { cardModel } = await load();
  const data = { owner: { name: "Alex" }, assistant: { name: "juno" }, agents: [{ name: "kit", provider: "claude", status: "working" }],
    projects: [{ slug: "acme", name: "Acme intake" }], threads: [{ project: "acme", asks: 2, agent: "kit" }, { project: "acme", asks: 0 }] };
  assert.equal(cardModel({ family: "person", ref: null, seed: "x" }, data).name, "Alex");
  const asst = cardModel({ family: "assistant", ref: null, seed: "x" }, data);
  assert.equal(asst.actions[0].label, "Ask juno");
  const proj = cardModel({ family: "project", ref: "acme", seed: "s" }, data);
  assert.deepEqual([proj.name, proj.rows], ["Acme intake", [["Chats", "2"], ["Needs you", "2"]]]);
  assert.equal(proj.actions[0].href, "/projects/acme");
  const ag = cardModel({ family: "agent", ref: "kit", seed: "kit" }, data);
  assert.deepEqual(ag.rows, [["Engine", "claude"], ["Now", "working"], ["Chats", "1"]]);
  assert.equal(ag.actions[0].href, "/agents/kit");
  const tm = cardModel({ family: "teammate", ref: "reviewer-acme", seed: "reviewer-acme" }, data);
  assert.deepEqual([tm.name, tm.rows[0]], ["reviewer", ["Project", "acme"]]);
});

test("nod: a free avatar nods; one inside a link, a button or a message does not", async () => {
  const { nodTarget } = await load();
  const free = document.createElement("span"); free.setAttribute("class", "vy-av");
  const box = document.createElement("div"); box.append(free); document.body.append(box);
  assert.equal(nodTarget(free), free);
  const a = document.createElement("a"); const inA = document.createElement("span"); inA.setAttribute("class", "vy-av"); a.append(inA); document.body.append(a);
  assert.equal(nodTarget(inA), null);
  const row = document.createElement("div"); row.setAttribute("class", "cv-row"); const inRow = document.createElement("span"); inRow.setAttribute("class", "vy-av"); row.append(inRow); document.body.append(row);
  assert.equal(nodTarget(inRow), null);
});

test("message details: an avatar or time on a message row hits it; the model, the time and the tools are read from the rows", async () => {
  const { messageHit, detailsOf, fullTime } = await load();
  const mk = (/** @type {string} */ cls, /** @type {string} */ text = "") => { const e = document.createElement("div"); e.setAttribute("class", cls); if (text) e.append(text); return e; };
  const head = /** @type {any} */ (mk("cv-row cv-head")); head._kind = "assistant"; head._ts = 1759400000000;
  const av = mk("vy-av"); const who = mk("msg-who", "kit"); const prov = mk("msg-prov", "Claude, opus"); const when = mk("msg-when", "09:30");
  head.append(av, who, prov, when);
  const tool = mk("cv-row cv-tool"); tool.append(mk("cv-tool-head", "Edit menu.md"));
  const turn = mk("cv-row cv-turn", "12 s · $0.04");
  const wrap = document.createElement("div"); wrap.append(head, tool, turn); document.body.append(wrap);
  assert.equal(messageHit(av), head);
  assert.equal(messageHit(when), head);
  assert.equal(messageHit(prov), null, "only the avatar, name and time");
  const d = detailsOf(head);
  assert.deepEqual([d.who, d.model, d.tools, d.turn, d.at], ["kit", "Claude, opus", ["Edit menu.md"], "12 s · $0.04", 1759400000000]);
  assert.equal(fullTime(null), "Not recorded");
});
