// @ts-check
// The design language's registry: every block's sample is valid, every block shrinks to a valid block, the rules refuse what the language never holds, and the catalogue stays small.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { BLOCKS, CELL_KINDS, FORM_OF, cellText, SURFACES, applyOverride, catalogue, contentFrom, reduceBlock, reduceScreen, validateScreen, wrapFrame } from "./blocks.js";

/** @param {Record<string, any>} blocks @param {any} [layout] */
const screen = (blocks, layout) => ({ v: 2, title: "T", layout: layout || { col: Object.keys(blocks).map(block => ({ block })) }, blocks });

test("blocks: every block's sample is valid content, and its compact and glance forms are valid blocks of the language", () => {
  for (const [type, spec] of Object.entries(BLOCKS)) {
    const full = { type, content: spec.sample, ...(type === "records" ? { data: { records: { type: "matter" } } } : {}) };
    assert.deepEqual(validateScreen(screen({ b: full })), [], `${type} sample`);
    for (const form of /** @type {const} */ (["compact", "glance"])) {
      const r = reduceBlock(full, form);
      if (r === null) { assert.ok(spec.reduce?.[form]?.drop, `${type} ${form} may only be left out when it says so`); continue; }
      assert.deepEqual(validateScreen(screen({ b: r })), [], `${type} ${form}`);
      assert.ok(BLOCKS[r.type], `${type} ${form} becomes a known block`);
    }
    assert.ok(spec.forms.compact && spec.forms.glance && spec.about, `${type} says how it shrinks`);
  }
});

test("blocks: the rules name the path and the fix", () => {
  const bad = (/** @type {any} */ s) => validateScreen(s).join("\n");
  assert.match(bad(screen({ b: { type: "chart2" } })), /blocks\.b\.type "chart2" is not a block/);
  assert.match(bad(screen({ b: { type: "stats", props: { color: "red" } } })), /props\.color is not a prop of stats; use tone/);
  assert.match(bad(screen({ b: { type: "banner", props: { tone: "#ff0000" } } })), /tone must be one of/);
  assert.match(bad(screen({ b: { type: "list", props: { title: "#ff0000" } } })), /is a colour/);
  assert.match(bad(screen({ b: { type: "list", props: { title: "<b>x</b>" } } })), /is markup/);
  assert.match(bad(screen({ b: { type: "list", props: { title: "12px wide" } } })), /is a size/);
  assert.match(bad(screen({ b: { type: "list", style: { x: 1 } } })), /blocks\.b\.style is not a block key; use props/);
  assert.match(bad(screen({ a: { type: "list" }, b: { type: "list" } }, { block: "a" })), /blocks\.b is not in the layout/);
  assert.match(bad(screen({ a: { type: "list" } }, { col: [{ block: "a" }, { block: "zz" }] })), /layout names block "zz"/);
  assert.match(bad(screen({ a: { type: "list" } }, { tabs: [{ block: "a" }] })), /tabs\[0\] needs a label/);
  assert.match(bad(screen({ a: { type: "list" } }, { split: [{ block: "a" }] })), /split needs 2 or 3 panes/);
  assert.match(bad(screen({ a: { type: "actions", data: { tool: "m.x" } } }, { block: "a" })), /data\.tool: a actions reads static/);
  assert.match(bad(screen({ a: { type: "form", data: { records: { type: "contact" } } } })), /a form reads tool, operation, static/);
  assert.match(bad(screen({ a: { type: "stats", data: { tool: "m.x", map: { items: "a b" } } } })), /plain dotted path/);
  assert.match(bad(screen({ a: { type: "stats", content: { bogus: [] } } })), /content\.bogus is not content of stats/);
  assert.match(bad({ ...screen({ a: { type: "list" } }), colour: 1 }), /screen\.colour is not a screen key; use tone/);
  let deep = /** @type {any} */ ({ block: "a" });
  for (let i = 0; i < 5; i++) deep = { col: [deep] };
  assert.match(bad(screen({ a: { type: "list" } }, deep)), /nest up to 4 deep/);
  const many = Object.fromEntries(Array.from({ length: 25 }, (_, i) => [`b${i}`, { type: "text" }]));
  assert.match(bad(screen(many)), /holds up to 24 blocks/);
});

test("blocks: a module's tool must be one it declared, and an action is checked as a view action is", () => {
  const c = { tools: new Set(["m.rows"]), allowed: new Set(), firstParty: false };
  const ok = screen({ s: { type: "stats", data: { tool: "m.rows", map: { items: "x" } } } });
  assert.deepEqual(validateScreen(ok, c), []);
  assert.match(validateScreen(screen({ s: { type: "stats", data: { tool: "vault.list" } } }), c).join(), /"vault.list" is not one of this module's tools/);
  assert.match(validateScreen(screen({ s: { type: "list", data: { tool: "m.rows" }, actions: [{ id: "Go", title: "Go", tool: "m.rows" }] } }), c).join(), /actions\[0\]\.id/);
  assert.deepEqual(validateScreen(screen({ s: { type: "list", data: { tool: "m.rows" }, actions: [{ id: "go", title: "Go", tool: "m.rows" }] } }), c), []);
});

test("blocks: a phone stacks rows and splits, a chat card keeps three blocks and every approval, an override wins", () => {
  const s = screen({
    kpis: { type: "stats", content: { items: [{ label: "a", value: "1" }, { label: "b", value: "2" }, { label: "c", value: "3" }, { label: "d", value: "4" }] } },
    list: { type: "list", content: { rows: Array.from({ length: 9 }, (_, i) => ({ id: String(i), title: `r${i}` })) } },
    detail: { type: "detail", content: { title: "D", fields: [] } },
    ask: { type: "approval", content: { title: "Send it", words: [{ label: "To", value: "x" }] } },
    note: { type: "text", content: { text: "x".repeat(400) } },
  }, { col: [{ block: "kpis" }, { row: [{ split: [{ block: "list" }, { block: "detail" }] }, { block: "note" }] }, { block: "ask" }] });
  assert.deepEqual(validateScreen(s), []);
  assert.deepEqual(reduceScreen(s, "app").layout, s.layout, "the app draws it as declared");
  const phone = reduceScreen(s, "phone");
  assert.deepEqual(phone.layout, { col: [{ block: "kpis" }, { col: [{ stack: [{ block: "list" }, { block: "detail" }] }, { block: "note" }] }, { block: "ask" }] });
  assert.equal(phone.blocks.kpis.props.cols, 2);
  const chat = reduceScreen(s, "chat");
  assert.deepEqual(chat.layout, { col: [{ block: "kpis" }, { block: "list" }, { block: "ask" }] }, "kpis, list, then the approval; the rest is left out");
  assert.ok(Object.keys(chat.blocks).includes("ask"), "an approval is never left out");
  assert.equal(Object.keys(chat.blocks).length, 3);
  assert.equal(chat.blocks.kpis.content.items.length, 3);
  assert.equal(chat.blocks.kpis.content.more, 1);
  assert.deepEqual(validateScreen({ ...chat, v: 2 }), []);
  // an override: the phone's own layout is final, a null block is left out, props patch
  const o = { ...s, surfaces: { phone: { layout: { col: [{ block: "ask" }, { block: "list" }] }, blocks: { detail: null, note: null, kpis: null, list: { props: { title: "Mine" } } } } } };
  assert.deepEqual(validateScreen(o), []);
  const mine = reduceScreen(o, "phone");
  assert.deepEqual(mine.layout, { col: [{ block: "ask" }, { block: "list" }] });
  assert.equal(mine.blocks.list.props.title, "Mine");
  assert.deepEqual(Object.keys(mine.blocks).sort(), ["ask", "list"]);
  assert.equal(applyOverride(s, "phone"), null);
  assert.deepEqual(reduceScreen(o, "app").layout, s.layout, "the app ignores a phone override");
});

test("blocks: the shrinks that change a block's type say so and keep the data honest", () => {
  const table = { type: "table", content: BLOCKS.table.sample };
  const asList = /** @type {any} */ (reduceBlock(table, "compact"));
  assert.equal(asList.type, "list");
  assert.deepEqual(asList.content.rows[0], { id: "1", title: "Smith", subtitle: "Intake · $2,000" });
  const chart = /** @type {any} */ (reduceBlock({ type: "chart", content: BLOCKS.chart.sample }, "glance"));
  assert.deepEqual(chart.content.items[0], { label: "Thu", value: "8", spark: [3, 5, 4, 8] });
  const board = /** @type {any} */ (reduceBlock({ type: "board", content: BLOCKS.board.sample }, "glance"));
  assert.deepEqual(board.content.items, [{ label: "To do", value: "1" }, { label: "Doing", value: "1" }]);
  assert.equal(reduceBlock({ type: "filter", content: BLOCKS.filter.sample }, "glance"), null);
  const long = /** @type {any} */ (reduceBlock({ type: "text", content: { text: "y".repeat(500) } }, "glance"));
  assert.ok(long.content.text.length <= 160);
  assert.deepEqual(SURFACES.map(s => FORM_OF[/** @type {keyof typeof FORM_OF} */ (s)]), ["full", "compact", "glance", "glance"]);
});

test("blocks: a v1 frame is a one-block screen, and a failure is a banner", () => {
  const w = wrapFrame({ v: 1, kind: "list", title: "Cards", rows: [{ id: "1", title: "A", actions: [{ id: "x", title: "X" }] }], more: true });
  assert.deepEqual(validateScreen(w), []);
  assert.equal(w.blocks.main.type, "list");
  assert.equal(w.blocks.main.content.more, true);
  const e = wrapFrame({ v: 1, kind: "needs", message: "Connect Gmail" });
  assert.deepEqual([e.blocks.main.type, e.blocks.main.props.tone, e.blocks.main.content.text], ["banner", "warn", "Connect Gmail"]);
  assert.deepEqual(validateScreen(e), []);
  const sum = wrapFrame({ v: 1, kind: "summary", title: "S", cards: [{ label: "A", value: "1" }] });
  assert.deepEqual(sum.blocks.main.content, { cards: [{ label: "A", value: "1" }] });
});

test("blocks: contentFrom reads an answer by dotted paths, with no expressions", () => {
  const ans = { totals: [{ k: "Open", n: 12, d: "+2" }, { k: "Done", n: 40 }], head: "Hello" };
  assert.deepEqual(contentFrom("stats", { items: "totals", label: "k", value: "n", delta: "d" }, ans), { items: [{ label: "Open", value: "12", delta: "+2" }, { label: "Done", value: "40" }] });
  assert.deepEqual(contentFrom("text", { text: "head" }, ans), { text: "Hello" });
  const t = contentFrom("table", { rows: "totals", id: "k", columns: [{ id: "k", title: "Name", path: "k" }, { id: "n", title: "Count", path: "n" }] }, ans);
  assert.deepEqual(t.rows[1], { id: "Done", cells: { k: "Done", n: "40" } });
  assert.equal(contentFrom("timeline", {}, { events: [] }).empty, "Nothing here.");
  assert.deepEqual(contentFrom("stats", { items: "zz" }, ans).items, []);
});

test("blocks: the catalogue stays small enough for an agent to read first", () => {
  const index = catalogue("index");
  assert.equal(index.split("\n").length, Object.keys(BLOCKS).length);
  assert.ok(index.length <= 6000, `the index is ${index.length} characters (about ${Math.round(index.length / 4)} tokens)`);
  for (const t of Object.keys(BLOCKS)) assert.ok(catalogue("block", t).length <= 1600, `${t} spec is ${catalogue("block", t).length} characters`);
  assert.match(catalogue("block", "nope"), /unknown block/);
  assert.match(catalogue("layouts"), /split = list and pane/);
});

test("blocks: a row's status is a tone by name, from the declaration's own map, and a value outside the language's tones is dropped", async () => {
  const { listFrame } = await import("./frames.js");
  const { frame } = listFrame({ tones: { green: "ok", red: "err", odd: "#ff0000" }, map: { rows: "r", id: "id", title: "t", accessory: "light" } }, { r: [{ id: "1", t: "a", light: "green" }, { id: "2", t: "b", light: "red" }, { id: "3", t: "c", light: "odd" }, { id: "4", t: "d", light: "x" }] }, { title: "Sites" });
  assert.deepEqual(frame.rows.map((/** @type {any} */ r) => r.tone), ["ok", "err", undefined, undefined]);
  assert.deepEqual(validateScreen(screen({ l: { type: "list", data: { tool: "m.x", tones: { green: "ok" }, map: { rows: "r", tone: "light" } } } })), []);
  assert.match(validateScreen(screen({ l: { type: "list", data: { tool: "m.x", tones: { green: "#0f0" } } } })).join(), /data\.tones is for a list or board/);
});

test("blocks: a typed cell reads as plain words where it cannot be drawn, a sealed one says only that it is sealed, and the kinds are the field registry's", async () => {
  assert.equal(cellText({ k: "link", v: "urn:c/1", link: { title: "Lena Ortiz" } }), "Lena Ortiz");
  assert.equal(cellText({ k: "actor", v: "a1", who: { name: "Alex" } }), "Alex");
  assert.equal(cellText({ k: "money", v: 800 }), "800");
  assert.equal(cellText({ k: "sealed", on: true }), "Sealed");
  assert.equal(cellText({ k: "sealed", on: false }), "");
  assert.equal(cellText(null), "");
  assert.equal(cellText("x"), "x");
  const fs = await import("node:fs");
  const src = fs.readFileSync(new URL("../../apps/app/ui/fields/registry.tsx", import.meta.url), "utf8");
  const kinds = [...src.matchAll(/^  ([a-z_]+): make\(/gm)].map(m => m[1]);
  assert.deepEqual(CELL_KINDS.filter(k => k !== "title").sort(), kinds.sort(), "a cell kind is a field kind of the registry (plus title)");
});

test("blocks: a glance is written as a list or a detail frame for Lumen, with the numbers first and no action", async () => {
  const { glanceFrame } = await import("./blocks.js");
  const g = reduceScreen(screen({
    k: { type: "stats", content: { items: [{ label: "Open", value: "12", delta: "+2" }, { label: "Done", value: "40" }] } },
    l: { type: "list", content: { rows: [{ id: "1", title: "Smith", subtitle: "today", accessory: "new" }] } },
    n: { type: "text", content: { text: "Hello" } },
  }), "lumen");
  const f = glanceFrame({ ...g, title: "Desk" });
  assert.deepEqual([f.v, f.kind, f.title], [1, "list", "Desk"]);
  assert.deepEqual(f.rows.map(r => [r.title, r.subtitle]), [["12  +2", "Open"], ["40", "Done"], ["Smith", "today"]]);
  assert.ok(f.rows.every(r => r.actions.length === 0));
  const d = glanceFrame(reduceScreen(screen({ k: { type: "keyvalue", content: { pairs: [{ label: "Client", value: "Dana" }] } }, a: { type: "approval", content: { title: "Send it", words: [{ label: "To", value: "x@y" }] }, actions: [{ id: "go", title: "Go" }] } }), "lumen"));
  assert.equal(d.kind, "detail");
  assert.match(d.body, /Send it/);
  assert.match(d.body, /Open Vyre to answer/);
  assert.deepEqual(d.fields, [{ label: "Client", value: "Dana" }, { label: "To", value: "x@y" }]);
  assert.deepEqual(d.actions, []);
});

test("blocks: a list row may carry faces, provider marks, several accessories and a dim flag; each is checked, never drawn from anything but words", () => {
  const rows = (/** @type {any[]} */ r) => screen({ l: { type: "list", content: { rows: r } } });
  const ok = { id: "1", title: "t", faces: [{ kind: "person", name: "Alex" }, { kind: "assistant", name: "Kit" }], providers: ["claude", "codex"], accessories: [{ label: "Needs you", tone: "accent" }, { label: "2m", as: "text" }], dim: true };
  assert.deepEqual(validateScreen(rows([ok])), []);
  assert.deepEqual(validateScreen(rows([{ id: "1", title: "t" }])), [], "every extra is optional");
  assert.match(validateScreen(rows([{ ...ok, faces: [{ kind: "robot", name: "x" }] }])).join(), /faces\[0\]/);
  assert.match(validateScreen(rows([{ ...ok, faces: Array.from({ length: 6 }, () => ({ kind: "person", name: "a" })) }])).join(), /faces/);
  assert.match(validateScreen(rows([{ ...ok, providers: ["a", "b", "c", "d"] }])).join(), /providers/);
  assert.match(validateScreen(rows([{ ...ok, accessories: [{ label: "x", tone: "#ff0000" }] }])).join(), /accessories\[0\]/);
  assert.match(validateScreen(rows([{ ...ok, accessories: [{ label: "x", as: "html" }] }])).join(), /accessories\[0\]/);
  assert.match(validateScreen(rows([{ ...ok, dim: "yes" }])).join(), /dim/);
});
