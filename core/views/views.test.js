// @ts-check
// Module views in a real vyred in a temp home: a fixture module declares a board, a summary, a list and an outward form under `views`; the app's tools (views.list, views.get, views.act) answer frames
// for them, the module's own tool runs as the module and never as the person, an outward action previews first, the older `shows.capsule` `view:` key says the same thing, and the board is pinned in the sidebar.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { start } from "../daemon/index.js";
import { call } from "../daemon/client.js";
import { validate } from "../modules/index.js";
import { tempHome } from "../../test/helpers.js";
import { keyOf } from "../../lib/sidebar/model.js";
import { boardFrame, summaryFrame } from "./frames.js";
import { commandsOf, kindOf } from "./engine.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));

const board = {
  tool: "cards.list", input: { q: "{q}" }, columns: [{ id: "todo", title: "To do" }, { id: "doing", title: "Doing" }, "done"],
  map: { rows: "cards", id: "id", title: "name", subtitle: "who", column: "status" },
  actions: [
    { id: "move", title: "Move", tool: "cards.move", input: { id: "{id}", status: "{column}" } },
    { id: "nudge", title: "Nudge", form: "nudge" },
  ],
};
const manifest = {
  name: "cards", version: "0.1.0", description: "A board of cards.", roles: ["box"], requires: [],
  does: { tools: [{ name: "cards.list", summary: "the cards" }, { name: "cards.move", summary: "move a card" }, { name: "cards.count", summary: "the counts" }, { name: "cards.calls", summary: "what ran" }, { name: "cards.nudge", summary: "message the card's owner", outward: "send" }] },
  watches: {}, needs: {}, teaches: {},
  views: {
    board: { title: "Board", icon: "tray", board },
    counts: { title: "Counts", summary: { tool: "cards.count", input: {}, map: { cards: [{ label: "Open", path: "open" }, { label: "Done", path: "done" }], chart: { kind: "bar", rows: "byDay", label: "day", value: "n" } } } },
    all: { title: "All cards", list: { tool: "cards.list", input: {}, map: { rows: "cards", id: "id", title: "name" } } },
  },
  shows: { cli: [], capsule: { "view:old": { title: "Old name", list: { tool: "cards.list", input: {}, map: { rows: "cards", id: "id", title: "name" } } } } },
};
manifest.views.board.forms = { nudge: { title: "Nudge {title}", fields: [{ name: "note", label: "Note", type: "multiline", required: true }], submit: { title: "Send", tool: "cards.nudge", input: { id: "{id}", note: "{note}" }, outward: true } } };
// the forms of a board live beside it in the declaration, as for a list
const src = `export default { async start(ctx) {
  const log = [];
  const reg = (name, fn) => ctx.tool(name, { effect: "read", input: { type: "object" }, run: fn });
  reg("cards.list", async (i, m) => ({ cards: [{ id: "c1", name: "Write brief", who: "Dana", status: "todo" }, { id: "c2", name: "Review", who: "Lee", status: "doing" }, { id: "c3", name: "Odd one", who: "Kit", status: "parked" }] }));
  reg("cards.move", async (i, m) => { log.push({ tool: "move", input: i, caller: m.caller }); return { said: "Moved." }; });
  reg("cards.calls", async () => ({ log }));
  reg("cards.count", async () => ({ open: 2, done: 7, byDay: [{ day: "Mon", n: 3 }, { day: "Tue", n: 5 }] }));
  reg("cards.nudge", async (i, m) => { log.push({ tool: "nudge", input: i, caller: m.caller, asked: m.asked }); return { said: "Sent." }; });
  return {};
} };`;

/** @param {any} t */
async function world(t, mf = manifest) {
  const root = tempHome(t);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ role: "box", transcripts: [], vault: { keystore: "file" }, modules: { enable: [], disable: ["recall", "memory", "learn"] } }));
  const dir = path.join(root, "modules", "cards");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "module.json"), JSON.stringify(mf));
  fs.writeFileSync(path.join(dir, "index.js"), src);
  const d = await start({ root, log: () => {} });
  t.after(() => d.stop());
  const c = (/** @type {string} */ tool, input = {}, caller = "cli") => call(tool, input, { root, caller });
  return { c };
}

test("views: the module's manifest is valid and the views module's own is too", () => {
  assert.deepEqual(validate(JSON.parse(fs.readFileSync(path.join(HERE, "module.json"), "utf8")), { firstParty: true }), []);
  assert.deepEqual(validate({ apiVersion: 1, ...manifest, roles: ["box"] }, {}).filter((/** @type {any} */ p) => /views/.test(String(p))), []);
});

test("views: views.list shows every view with its kind, from `views` and from the older shows.capsule key, and never a tool name", async t => {
  const { c } = await world(t);
  const r = (await c("views.list", {})).data.commands;
  const by = Object.fromEntries(r.filter((/** @type {any} */ x) => x.module === "cards").map((/** @type {any} */ x) => [x.id, x]));
  assert.deepEqual(Object.keys(by).sort(), ["all", "board", "counts", "old"]);
  assert.deepEqual([by.board.kind, by.counts.kind, by.all.kind, by.old.kind], ["board", "summary", "list", "list"]);
  assert.equal(by.board.firstParty, false);
  assert.ok(!JSON.stringify(r).includes("cards.list"), "ids and titles only");
});

test("views: a board frame groups the cards into the declared columns, puts a stranger into Other, and carries action ids", async t => {
  const { c } = await world(t);
  const f = (await c("views.get", { module: "cards", command: "board" })).data;
  assert.equal(f.kind, "board", JSON.stringify(f));
  assert.equal(f.from, "cards", "an added module's frame says whose it is");
  assert.deepEqual(f.columns.map((/** @type {any} */ x) => [x.id, x.rows.map((/** @type {any} */ r) => r.id)]), [["todo", ["c1"]], ["doing", ["c2"]], ["done", []], ["other", ["c3"]]]);
  assert.deepEqual(f.columns[0].rows[0].actions.map((/** @type {any} */ a) => a.id), ["move", "nudge"]);
  assert.ok(!JSON.stringify(f).includes("cards.move"));
});

test("views: moving a card runs the module's own tool AS the module with the column filled in, and only a declared column", async t => {
  const { c } = await world(t);
  await c("views.get", { module: "cards", command: "board" });
  assert.equal((await c("views.act", { module: "cards", command: "board", action: "move", id: "c1", column: "doing" })).data.kind, "done");
  assert.equal((await c("views.act", { module: "cards", command: "board", action: "move", id: "c1", column: "../../etc" })).data.kind, "done");
  assert.deepEqual((await c("cards.calls")).data.log.map((/** @type {any} */ x) => [x.tool, x.input, x.caller]), [
    ["move", { id: "c1", status: "doing" }, "module:cards"],
    ["move", { id: "c1", status: "" }, "module:cards"],
  ]);
});

test("views: an outward action previews the exact words first and sends only with the preview's own token, once for these words", async t => {
  const { c } = await world(t);
  await c("views.get", { module: "cards", command: "board" });
  const ask = { module: "cards", command: "board", action: "submit", form: "nudge", id: "c1", fields: { note: "Please look today" } };
  const p = (await c("views.act", ask)).data;
  assert.equal(p.kind, "preview");
  assert.deepEqual(p.words.map((/** @type {any} */ w) => [w.label, w.value]), [["id", "c1"], ["note", "Please look today"]]);
  assert.equal((await c("cards.calls")).data.log.length, 0, "nothing was sent by the preview");
  assert.equal((await c("views.act", { ...ask, asked: { hash: p.hash, token: "1.nope" } })).data.kind, "preview", "a token that is not this preview's asks again");
  assert.equal((await c("views.act", { ...ask, fields: { note: "Other words" }, asked: { hash: p.hash, token: p.token } })).data.kind, "preview", "other words need their own preview");
  assert.equal((await c("cards.calls")).data.log.length, 0);
  const done = (await c("views.act", { ...ask, asked: { hash: p.hash, token: p.token } })).data;
  assert.equal(done.kind, "done");
  assert.deepEqual((await c("cards.calls")).data.log.map((/** @type {any} */ x) => [x.tool, x.input, x.caller]), [["nudge", { id: "c1", note: "Please look today" }, "module:cards"]]);
  assert.equal((await c("views.act", { ...ask, fields: { note: "" } })).data.kind, "error", "a required field left empty is refused");
});

test("views: a summary frame reads counts and one chart by path", () => {
  const f = summaryFrame(manifest.views.counts.summary, { open: 2, done: 7, byDay: [{ day: "Mon", n: 3 }, { day: "Tue", n: 5 }, { day: "x" }] }, { title: "Counts" });
  assert.deepEqual(f.cards, [{ label: "Open", value: "2" }, { label: "Done", value: "7" }]);
  assert.deepEqual(f.chart, { kind: "bar", points: [{ label: "Mon", value: 3 }, { label: "Tue", value: 5 }] });
  assert.equal(summaryFrame({ map: { cards: [{ label: "A", path: "a" }] } }, {}, { title: "T" }).empty, "Nothing to count yet.");
});

test("views: boardFrame needs no module and keeps the rows' own order inside a column", () => {
  const { frame } = boardFrame({ columns: ["a", "b"], map: { rows: "r", id: "id", title: "t", column: "s" } }, { r: [{ id: "1", t: "x", s: "b" }, { id: "2", t: "y", s: "a" }, { id: "3", t: "z", s: "b" }] }, { title: "B" });
  assert.deepEqual(frame.columns.map((/** @type {any} */ x) => x.rows.map((/** @type {any} */ r) => r.id)), [["2"], ["1", "3"]]);
});

test("views: `views` wins over the older key for the same id, and kindOf names what a view first shows", () => {
  const status = [{ name: "m", state: "running", firstParty: false, shows: { capsule: { "view:x": { title: "Old", list: { tool: "m.a" } } } }, views: { x: { title: "New", board: { tool: "m.b" } } } }];
  const cmd = commandsOf(status).get("m/x");
  assert.equal(cmd.decl.title, "New");
  assert.equal(kindOf(cmd.decl), "board");
  assert.equal(kindOf({ form: "f" }), "form");
});

test("views: the board is pinned in the sidebar by its view id, and shows in the merged list", async t => {
  const { c } = await world(t);
  const got = (await c("sidebar.get", {})).data;
  const m = got.modules.find((/** @type {any} */ x) => x.module === "cards");
  assert.deepEqual(m.screens.map((/** @type {any} */ s) => [s.id, s.view]).sort(), [["all", true], ["board", true], ["counts", true], ["old", true]], "views are screens with view: true, the older key's too");
  assert.equal(m.origin, undefined, "a drawn view needs no origin");
  const add = await c("sidebar.edit", { op: "add", entry: { kind: "module", module: "cards", screen: "board" } });
  assert.equal(add.error, undefined, JSON.stringify(add.error));
  const after = (await c("sidebar.get", {})).data;
  assert.ok(after.entries.some((/** @type {any} */ e) => keyOf(e) === "module:cards/board"));
});
