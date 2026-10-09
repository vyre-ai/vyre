// @ts-check
// design in a real vyred in a temp home: the catalogue and checker for anyone, a proposal kept pending until the person says yes, a yes making the space's screen (a view of the module "space"
// that reads its tools), the owner's before and after, and an agent never deciding.
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

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** @param {any} t */
async function world(t) {
  const root = tempHome(t);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ role: "box", transcripts: [], vault: { keystore: "file" }, modules: { enable: [], disable: ["recall", "memory", "learn"] } }));
  const d = await start({ root, log: () => {} });
  t.after(() => d.stop());
  return (/** @type {string} */ tool, input = {}, caller = "cli") => call(tool, input, { root, caller });
}

const screen = (/** @type {string} */ tool) => ({ v: 2, title: "Agents", layout: { col: [{ block: "who" }, { block: "n" }] }, blocks: {
  who: { type: "list", data: { tool, map: { rows: "agents", id: "name", title: "name", subtitle: "kind" } }, actions: [{ id: "show", title: "Show", do: { copy: "{title}" } }] },
  n: { type: "text", props: { style: "note" }, data: { static: { text: "Everyone Vyre works with." } } },
} });

test("design: the module's manifest is valid", () => {
  assert.deepEqual(validate(JSON.parse(fs.readFileSync(path.join(HERE, "module.json"), "utf8")), { firstParty: true }), []);
});

test("design: anyone reads the catalogue and checks a screen; the words name the fix", async t => {
  const c = await world(t);
  const idx = (await c("design.catalogue", {}, "mcp")).data.text;
  assert.match(idx, /^list: /m);
  assert.match((await c("design.catalogue", { level: "block", type: "stats" }, "mcp")).data.text, /"type":"stats"/);
  const ok = (await c("design.validate", { screen: screen("agents.list") }, "mcp")).data;
  assert.equal(ok.ok, true, JSON.stringify(ok));
  const bad = (await c("design.validate", { screen: { v: 2, layout: { block: "x" }, blocks: { x: { type: "stats", props: { color: "red" } } } } }, "mcp")).data;
  assert.equal(bad.ok, false);
  assert.match(bad.problems.join("\n"), /props\.color is not a prop of stats; use tone/);
});

test("design: a proposal waits for the owner; a yes makes it the space's screen, a no keeps the old one, and an agent cannot decide", async t => {
  const c = await world(t);
  const bad = (await c("design.propose", { id: "agents", screen: { v: 2, layout: { block: "x" }, blocks: { x: { type: "nope" } } }, why: "x" }, "mcp")).data;
  assert.ok(bad.problems.length, "a screen outside the language is not even filed");
  const p = (await c("design.propose", { id: "agents", title: "Agents", screen: screen("agents.list"), why: "A page for the team's agents" }, "mcp")).data.proposal;
  assert.equal(p.status, "pending");
  assert.deepEqual(p.uses, { reads: ["agents.list"], runs: [] });
  assert.deepEqual((await c("design.screens", {}, "mcp")).data.screens, [], "nothing changed yet");
  assert.ok((await c("views.list", {})).data.commands.every((/** @type {any} */ x) => x.module !== "space"));
  const asAgent = await c("design.decide", { id: p.id, yes: true }, "mcp");
  assert.ok(asAgent.error, "an agent never decides");
  const list = (await c("design.proposals", {})).data.proposals;
  assert.equal(list[0].before, null);
  assert.equal(list[0].after.title, "Agents");
  const done = (await c("design.decide", { id: p.id, yes: true })).data;
  assert.deepEqual([done.status, done.version], ["accepted", 1]);
  assert.ok((await c("design.decide", { id: p.id, yes: false })).error, "decided once");
  // the space's screen is a view of the module "space", and it reads its tool
  const cmd = (await c("views.list", {})).data.commands.find((/** @type {any} */ x) => x.module === "space" && x.id === "agents");
  assert.equal(cmd.kind, "screen");
  const f = (await c("views.get", { module: "space", command: "agents", surface: "app" })).data;
  assert.equal(f.v, 2, JSON.stringify(f));
  assert.ok(Array.isArray(f.blocks.who.content.rows), JSON.stringify(f.blocks.who));
  // a second proposal for the same id shows the screen it would replace; a no leaves version 1
  const p2 = (await c("design.propose", { id: "agents", screen: { ...screen("agents.list"), title: "Agents v2" }, why: "again" }, "mcp")).data.proposal;
  assert.equal(p2.replaces, true);
  assert.equal((await c("design.proposals", { status: "pending" })).data.proposals[0].before.title, "Agents");
  assert.equal((await c("design.decide", { id: p2.id, yes: false })).data.status, "rejected");
  assert.equal((await c("design.screens", {})).data.screens[0].version, 1);
  assert.equal((await c("design.screen.remove", { id: "agents" })).data.removed, true);
});

test("design: views.preview resolves a screen that is not installed, for the owner's before and after", async t => {
  const c = await world(t);
  const f = (await c("views.preview", { screen: { v: 2, layout: { block: "n" }, blocks: { n: { type: "text", data: { static: { text: "Hello" } } } } }, surface: "phone" })).data;
  assert.equal(f.v, 2, JSON.stringify(f));
  assert.equal(f.blocks.n.content.text, "Hello");
  const bad = (await c("views.preview", { screen: { v: 2, layout: { block: "x" }, blocks: { x: { type: "nope" } } } })).data;
  assert.equal(bad.code, "bad_screen");
});

const CSS = '[data-block="kpis"] { background-color: var(--surface-2); border-radius: var(--r-card); }';

test("design: custom CSS goes through the Engineer, passes the linter, waits for the owner and is drawn for the web only", async t => {
  const c = await world(t);
  const asOther = await c("design.css.propose", { scope: "space", css: CSS, why: "x" }, "mcp");
  assert.equal(asOther.error && asOther.error.code, "denied", "an agent that is not the Engineer is refused (the Engineer itself is checked by its verified agent claim, which a test cannot forge)");
  const bad = (await c("design.css.propose", { scope: "space", css: "body { color: red; }", why: "x" }, "cli")).data;
  assert.ok(bad.problems.length, "the linter words come back");
  const p = (await c("design.css.propose", { scope: "space", css: CSS, why: "softer cards" }, "cli")).data.proposal;
  assert.equal(p.appliesTo, "web");
  assert.deepEqual((await c("design.css", {}, "mcp")).data.css, [], "nothing on until the owner says yes");
  const list = (await c("design.proposals", { status: "pending" })).data.proposals;
  assert.deepEqual([list[0].kind, list[0].before, list[0].after], ["css", null, CSS]);
  assert.deepEqual((await c("design.decide", { id: p.id, yes: true })).data, { status: "accepted", css: "space", appliesTo: "web" });
  assert.deepEqual((await c("design.css", {}, "mcp")).data.css, [{ scope: "space", css: CSS }]);
  assert.deepEqual((await c("design.css.verify", {})).data.off, [], "still passes");
});

test("design: an update that breaks a custom CSS turns it off with the reason, and the screen draws without it", async t => {
  const root = tempHome(t);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ role: "box", transcripts: [], vault: { keystore: "file" }, modules: { enable: [], disable: ["recall", "memory", "learn"] } }));
  let d = await start({ root, log: () => {} });
  const c = (/** @type {string} */ tool, input = {}, caller = "cli") => call(tool, input, { root, caller });
  const p = (await c("design.css.propose", { scope: "screen:orders", css: '[data-screen="orders"] [data-block="list"] { color: var(--accent); }', why: "x" }, "cli")).data.proposal;
  await c("design.decide", { id: p.id, yes: true });
  assert.equal((await c("design.css", {}, "mcp")).data.css.length, 1);
  await d.stop();
  // an update changes what passes: the stored stylesheet now names a token that is gone (written straight into the module's store while vyred is down)
  const { DatabaseSync } = await import("node:sqlite");
  const dbs = [];
  (function walk(/** @type {string} */ dir) { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const f = path.join(dir, e.name); if (e.isDirectory()) walk(f); else if (/^vyre\.db$/.test(e.name)) dbs.push(f); } })(root);
  assert.ok(dbs.length, "found the store");
  for (const f of dbs) { const db = new DatabaseSync(f); try { db.prepare("UPDATE design_css SET css = ?").run('[data-screen="orders"] { color: var(--gone); }'); } finally { db.close(); } }
  d = await start({ root, log: () => {} });
  t.after(() => d.stop());
  assert.deepEqual((await c("design.css", {}, "mcp")).data.css, [], "the broken stylesheet is not drawn");
  const st = (await c("design.css.status", {})).data.css[0];
  assert.deepEqual([st.scope, st.status], ["screen:orders", "off"]);
  assert.match(st.reason, /--gone is not a token|use design tokens/);
});
