// @ts-check
// capsule: commands, views and actions from the manifests' `view:` entries.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { discover, Registry, validate } from "../modules/index.js";
import { open } from "../store/index.js";
import { Events } from "../events/index.js";
import { tempHome, writeModule } from "../../test/helpers.js";
import { fill, fillDeep, getPath, allowed, listFrame } from "./frames.js";

const LOCAL = path.resolve(import.meta.dirname, "..", "..", "local", "capsule");
const self = () => ({ dir: LOCAL, manifest: JSON.parse(fs.readFileSync(path.join(LOCAL, "module.json"), "utf8")), problems: [] });

const north = {
  version: "0.1.0", roles: ["local"], needs: { slots: ["front"] },
  does: { tools: ["north.orders", "north.read", "north.send", "north.held", "north.locked", "north.big"] },
  shows: { capsule: {
    "view:orders": {
      title: "Orders", keywords: ["bakery"], alias: "ord", icon: "tray", root: true, arg: { name: "q", placeholder: "customer" },
      list: {
        tool: "north.orders", input: { q: "{q}", limit: 20, who: "{secret}", sel: "{front.selection}" },
        map: { rows: "orders", id: "ref", title: "name", subtitle: "note", accessory: "day", url: "link" }, empty: "No orders match that.",
        detail: { tool: "north.read", input: { ref: "{id}" }, map: { title: "name", body: "text", fields: [{ label: "Customer", path: "who.name" }, { label: "Total", path: "total" }] } },
        actions: [
          { id: "open", title: "Open", do: { open: "{url}" } },
          { id: "file", title: "Reveal", do: { open: "file:///etc/hosts" } },
          { id: "copy", title: "Copy name", do: { copy: "{title}: {subtitle}" } },
          { id: "reply", title: "Reply", form: "reply" },
          { id: "held", title: "Hold", tool: "north.held" },
          { id: "locked", title: "Locked", tool: "north.locked" },
        ],
      },
      forms: { reply: { title: "Reply to {title}", fields: [{ name: "body", label: "Your reply", type: "multiline", required: true }],
        submit: { title: "Send", tool: "north.send", input: { ref: "{id}", body: "{body}", app: "{front.app}" }, outward: true } } },
    },
    "view:big": { title: "Big", list: { tool: "north.big", input: {}, map: { rows: "items", id: "id", title: "t" } } },
    "results:north.orders": { title: "North" },
    "action:north.read": { title: "Read" },
  } },
};
const northSrc = `export default { async start(ctx) {
  const reg = (name, fn) => ctx.tool(name, { input: { type: "object" }, run: fn });
  reg("north.orders", async (i, meta) => { globalThis.__cap.push({ tool: "north.orders", input: i, caller: meta.caller }); return { orders: [{ ref: "o1", name: "Harlow", note: "Sourdough", day: "Mon", link: "https://example.com/o/1" }], rows: [{ id: "r1", name: "Legacy", sub: "old", kind: "order" }] }; });
  reg("north.read", async (i, meta) => { globalThis.__cap.push({ tool: "north.read", input: i, caller: meta.caller }); return { name: "Harlow", text: "Two loaves", who: { name: "Dana" }, total: 14 }; });
  reg("north.send", async (i, meta) => { globalThis.__cap.push({ tool: "north.send", input: i, caller: meta.caller, asked: meta.asked }); return { said: "Sent." }; });
  reg("north.held", async () => ({ state: "held", id: "g1" }));
  reg("north.locked", async () => { throw Object.assign(new Error("the vault is locked"), { code: "locked" }); });
  reg("north.big", async () => ({ items: Array.from({ length: 60 }, (_, n) => ({ id: "b" + n, t: "x".repeat(900) })) }));
  return {};
} };`;

/** An added module: v1 manifest, object tool entries, its own tools. */
const kit = () => ({
  name: "kit", version: "0.1.0", apiVersion: 1, description: "Kit's list.", roles: ["local"],
  does: { tools: [{ name: "kit.list", summary: "the list" }, { name: "kit.send", summary: "send it", outward: "send" }] },
  shows: { capsule: { "view:things": { title: "Things", root: true, list: { tool: "kit.list", input: { q: "{q}" }, map: { rows: "items", id: "id", title: "name", url: "url" },
    actions: [{ id: "open", title: "Open", do: { open: "{url}" } }, { id: "web", title: "Web", do: { open: "javascript:alert(1)" } }, { id: "send", title: "Send", tool: "kit.send", input: { id: "{id}" }, outward: true }] } } } },
});
const kitSrc = `export default { async start(ctx) {
  ctx.tool("kit.list", { input: { type: "object" }, run: async (i, meta) => { globalThis.__cap.push({ tool: "kit.list", caller: meta.caller }); return { items: [{ id: "k1", name: "Thing", url: "https://kit.example/1" }] }; } });
  ctx.tool("kit.send", { input: { type: "object" }, run: async (i, meta) => { globalThis.__cap.push({ tool: "kit.send", caller: meta.caller, asked: meta.asked }); return { said: "Kit sent." }; } });
  return {};
} };`;

async function registry(t, extra = []) {
  globalThis.__cap = [];
  t.after(() => { delete globalThis.__cap; });
  const home = tempHome(t);
  const own = path.join(home, "own"), added = path.join(home, "added");
  writeModule(own, "north", north, northSrc);
  writeModule(added, "kit", kit(), kitSrc);
  for (const [n, m, s] of extra) writeModule(added, n, m, s);
  const db = open(path.join(home, "vyre.db"));
  t.after(() => db.close());
  const reg = new Registry({ db, events: new Events(db), config: { role: "local" }, log: () => {}, firstPartyRoots: [own] });
  await reg.start([self(), ...discover([own], { firstPartyRoots: [own] }), ...discover([added])], { role: "local" });
  return reg;
}

test("capsule: templates fill a fixed set of names, an unknown one is empty, a path is a plain dotted path", () => {
  assert.equal(fill("Hi {title}, {nope}!", { title: "Dana", nope: "x" }, allowed()), "Hi Dana, !", "a name outside the set fills empty even when a value is there");
  assert.equal(fill("{front.selection}", { "front.selection": "secret" }, allowed()), "", "front is empty unless declared");
  assert.equal(fill("{front.selection}", { "front.selection": "words" }, allowed({ front: true })), "words");
  assert.deepEqual(fillDeep({ n: "{count}", s: "a {q}", nested: [{ k: "{q}" }] }, { count: 3, q: "x" }, new Set(["count", "q"])), { n: 3, s: "a x", nested: [{ k: "x" }] }, "a whole {name} keeps its type");
  assert.equal(getPath({ a: { b: [{ c: 7 }] } }, "a.b.0.c"), 7);
  assert.equal(getPath({ a: 1 }, "a.b.c"), undefined);
  const { frame } = listFrame({ map: { rows: "r", id: "i", title: "t" } }, { r: Array.from({ length: 60 }, (_, n) => ({ i: "id" + n, t: "y".repeat(900) })) }, { title: "Big" });
  assert.equal(frame.rows.length <= 50, true);
  assert.equal(frame.more, true);
  assert.ok(frame.rows[0].title.length <= 500, "a string is cut to 500");
});

test("capsule: commands lists view entries and the older results: keys, marks an added module, and keeps its root off", async t => {
  const reg = await registry(t);
  assert.equal(reg.modules.get("kit").state, "running", reg.modules.get("kit").error);
  const r = (await reg.call("capsule.commands", {}, "capsule")).data.commands;
  const by = Object.fromEntries(r.map(c => [`${c.module}/${c.id}`, c]));
  assert.deepEqual(Object.keys(by).sort(), ["kit/things", "north/big", "north/north-orders", "north/orders"]);
  assert.equal(by["north/orders"].root, true);
  assert.equal(by["north/orders"].firstParty, true);
  assert.equal(by["kit/things"].firstParty, false);
  assert.equal(by["kit/things"].root, false, "an added module's root is off until the person turns it on");
  assert.match(by["north/orders"].hash, /^[0-9a-f]{16}$/);
  assert.ok(!JSON.stringify(r).includes("north.orders"), "titles and ids only, no tool names");
  for (const c of ["mcp", "mcp:agent:kit", "module:sessions"]) assert.ok((await reg.call("capsule.commands", {}, c)).error, c);
});

test("capsule: a list frame carries rows and action ids, runs the tool as the surface, and marks an added module's rows", async t => {
  const reg = await registry(t);
  const f = (await reg.call("capsule.view", { module: "north", command: "orders", q: "har" }, "capsule")).data;
  assert.equal(f.kind, "list");
  assert.deepEqual(f.rows[0], { id: "o1", title: "Harlow", subtitle: "Sourdough", accessory: "Mon", actions: f.rows[0].actions });
  assert.deepEqual(f.rows[0].actions.map(a => a.id), ["open", "file", "copy", "reply", "held", "locked"]);
  assert.ok(!JSON.stringify(f).includes("north.held"), "no tool names in a frame");
  const call = globalThis.__cap.find(c => c.tool === "north.orders");
  assert.equal(call.caller, "capsule", "a first party view's tool runs as the person's surface");
  assert.deepEqual(call.input, { q: "har", limit: 20, who: "", sel: "" }, "an unknown name and an undeclared front fill empty");
  const k = (await reg.call("capsule.view", { module: "kit", command: "things" }, "capsule")).data;
  assert.equal(k.from, "kit", "an added module's frame is marked");
  assert.equal(globalThis.__cap.find(c => c.tool === "kit.list").caller, "module:kit", "an added module's tool runs as itself");
  const legacy = (await reg.call("capsule.view", { module: "north", command: "north-orders", q: "x" }, "capsule")).data;
  assert.equal(legacy.rows[0].title, "Legacy", "the results: shorthand keeps its default map");
  const big = (await reg.call("capsule.view", { module: "north", command: "big" }, "capsule")).data;
  assert.ok(big.rows.length <= 50 && Buffer.byteLength(JSON.stringify(big)) <= 256 * 1024);
});

test("capsule: detail and effects; an added module opens https only", async t => {
  const reg = await registry(t);
  await reg.call("capsule.view", { module: "north", command: "orders" }, "capsule");
  const d = (await reg.call("capsule.view", { module: "north", command: "orders", view: "detail", id: "o1" }, "capsule")).data;
  assert.deepEqual([d.kind, d.title, d.body, d.fields], ["detail", "Harlow", "Two loaves", [{ label: "Customer", value: "Dana" }, { label: "Total", value: "14" }]]);
  const act = (a, extra = {}) => reg.call("capsule.act", { module: "north", command: "orders", action: a, id: "o1", ...extra }, "capsule").then(r => r.data);
  assert.deepEqual(await act("open"), { v: 1, kind: "done", effect: { open: "https://example.com/o/1" } });
  assert.deepEqual(await act("copy"), { v: 1, kind: "done", effect: { copy: "Harlow: Sourdough" } });
  assert.deepEqual((await act("file")).effect, { open: "file:///etc/hosts" }, "a first party module may open a file");
  await reg.call("capsule.view", { module: "kit", command: "things" }, "capsule");
  const kact = (a, extra = {}) => reg.call("capsule.act", { module: "kit", command: "things", action: a, id: "k1", ...extra }, "capsule").then(r => r.data);
  assert.deepEqual((await kact("open")).effect, { open: "https://kit.example/1" });
  assert.equal((await kact("web")).kind, "error", "an added module cannot open a javascript: link");
});

test("capsule: an outward action previews the exact words, and only the same hash sends, with asked passed on", async t => {
  const reg = await registry(t);
  await reg.call("capsule.view", { module: "north", command: "orders" }, "capsule");
  const form = (await reg.call("capsule.act", { module: "north", command: "orders", action: "reply", id: "o1" }, "capsule")).data;
  assert.equal(form.kind, "view");
  assert.equal(form.frame.kind, "form");
  assert.equal(form.frame.title, "Reply to Harlow");
  const submit = (extra = {}) => reg.call("capsule.act", { module: "north", command: "orders", action: "submit", form: "reply", id: "o1", fields: { body: "Thanks!" }, front: { app: "Mail", selection: "x" }, ...extra }, "capsule").then(r => r.data);
  assert.equal((await submit({ fields: {} })).code, "missing", "a required field");
  const p = await submit();
  assert.equal(p.kind, "preview");
  assert.deepEqual(p.words, [{ label: "ref", value: "o1" }, { label: "body", value: "Thanks!" }, { label: "app", value: "Mail" }]);
  assert.equal(globalThis.__cap.some(c => c.tool === "north.send"), false, "nothing sent by a preview");
  assert.equal((await submit({ asked: { hash: "0".repeat(32) } })).kind, "preview", "a wrong hash previews again");
  assert.equal((await submit({ fields: { body: "Changed" }, asked: { hash: p.hash } })).kind, "preview", "the hash is bound to the exact words");
  const sent = await submit({ asked: { hash: p.hash } });
  assert.deepEqual([sent.kind, sent.said], ["done", "Sent."]);
  const call = globalThis.__cap.find(c => c.tool === "north.send");
  assert.equal(call.caller, "capsule");
  assert.deepEqual([call.asked.surface, call.asked.hash], ["capsule", p.hash], "the Gate gets asked: { surface, hash, at }");
  const k = (extra = {}) => reg.call("capsule.act", { module: "kit", command: "things", action: "send", id: "k1", ...extra }, "capsule").then(r => r.data);
  await reg.call("capsule.view", { module: "kit", command: "things" }, "capsule");
  const kp = await k();
  assert.equal(kp.kind, "preview", "an added module's outward action previews too");
  const held = await k({ asked: { hash: kp.hash } });
  assert.equal(held.kind, "held", "an outward tool of an added module is held at the Gate, never sent by a declaration");
  assert.equal(globalThis.__cap.some(c => c.tool === "kit.send"), false, "it never ran as the person or as the module");
});

test("capsule: held and needs come back as themselves, never as sent", async t => {
  const reg = await registry(t);
  await reg.call("capsule.view", { module: "north", command: "orders" }, "capsule");
  const act = a => reg.call("capsule.act", { module: "north", command: "orders", action: a, id: "o1" }, "capsule").then(r => r.data);
  assert.deepEqual([(await act("held")).kind, (await act("held")).id], ["held", "g1"]);
  assert.equal((await act("locked")).kind, "needs");
  assert.equal((await act("nope")).code, "not_found");
  assert.equal((await reg.call("capsule.view", { module: "north", command: "gone" }, "capsule")).error.code, "not_found");
});

test("capsule: an added module's view names its own tools, a person can never be the caller of another module's, and the icon list is fixed", async t => {
  const own = kit();
  const bad = (edit) => { const m = JSON.parse(JSON.stringify(own)); edit(m); return validate(m).join("; "); };
  assert.equal(validate(own).filter(p => /capsule|view/.test(p)).length, 0);
  assert.match(bad(m => { m.shows.capsule["view:things"].list.tool = "north.orders"; }), /not one of this module's tools or its needs.tools/);
  assert.match(bad(m => { m.shows.capsule["view:things"].icon = "not.a.symbol"; }), /icon list/);
  assert.match(bad(m => { m.shows.capsule["view:things"].list.map.rows = "a b"; }), /plain dotted path/);
  assert.match(bad(m => { m.shows.capsule["view:things"].list.actions[0].shortcut = "alt+o"; }), /Command or Shift chord/);
  assert.match(bad(m => { m.shows.capsule["view:things"].list.actions[0].do = { open: "x", copy: "y" }; }), /do must be one of/);
  assert.match(bad(m => { m.shows.capsule["view:things"].list.actions[2].form = "nope"; }), /exactly one of do, tool or form/);
  const reg = await registry(t);
  // The capsule module refuses a tool no view declares, whoever it would run as.
  assert.equal(reg.capsuleMayCall("capsule", "north.orders"), true);
  assert.equal(reg.capsuleMayCall("capsule", "north.send"), true, "declared as a form submit");
  assert.equal(reg.capsuleMayCall("capsule", "vault.reveal"), false);
  assert.equal(reg.capsuleMayCall("capsule", "kit.list"), false, "an added module's tool is never run as the person");
  assert.equal(reg.capsuleMayCall("module:kit", "kit.list"), true);
  assert.equal(reg.capsuleMayCall("module:kit", "north.orders"), false, "an added module reaches only its own declared tools");
  assert.equal(reg.capsuleMayCall("module:north", "kit.list"), false);
});
