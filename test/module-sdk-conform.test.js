// @ts-check
// @vyre/module-sdk/conform (ADR 0047 section 7): a module that keeps the contract passes with no
// failures, and each broken rule comes back as one line that says what to change.

import "../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { conformModule, scanImports, scanDoors, importsOf, GUARD_WORDS } from "../packages/module-sdk/conform.js";
import { FORBIDDEN } from "../scripts/lib/hygiene.js";

const base = () => ({
  name: "juno", version: "0.1.0", apiVersion: 1, description: "Juno's reading list for alex.",
  does: { tools: [
    { name: "juno.list", summary: "list the reading list" },
    { name: "juno.clear", summary: "clear the list", reach: "asked" },
    { name: "juno.share", summary: "share the list", outward: "post" },
  ] },
  watches: { emits: ["juno.cleared"] },
});

const GOOD = `let n = 0;
export default {
  async start(ctx) {
    ctx.store.migrate(["CREATE TABLE juno_items (id INTEGER PRIMARY KEY, title TEXT)"]);
    const ex = [{ input: {} }];
    ctx.tool("juno.list", { effect: "read", description: "The reading list", input: { type: "object" }, examples: ex, run: () => ({ items: [] }) });
    ctx.tool("juno.clear", { effect: "read", description: "Clear it", input: { type: "object" }, examples: ex, run: () => { ctx.events.emit("juno.cleared", {}); return { cleared: 0 }; } });
    ctx.tool("juno.share", { effect: "read", description: "Share it", input: { type: "object" }, examples: ex, run: () => ({ shared: true }) });
    return { async stop() {} };
  },
};
`;

/** A module folder in a temp dir. */
function folder(t, manifest, source, extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vyre-conform-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, "module.json"), JSON.stringify(manifest));
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ type: "module" }));
  fs.writeFileSync(path.join(dir, "index.js"), source);
  for (const [f, text] of Object.entries(extra)) { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), text); }
  return dir;
}
const has = (/** @type {string[]} */ fails, /** @type {RegExp} */ re) => assert.ok(fails.some(f => re.test(f)), `${re} not in ${JSON.stringify(fails, null, 1)}`);

test("conform: the guard words are hygiene's own list", () => {
  assert.deepEqual(GUARD_WORDS, FORBIDDEN);
});

test("conform: a module that keeps the contract passes", async t => {
  assert.deepEqual(await conformModule(folder(t, base(), GOOD)), []);
});

test("conform: the import scan", t => {
  assert.deepEqual(importsOf(`import a from "./a.js";\nimport "node:fs";\nexport { b } from '../b.js';\nconst c = await import("./c.js");\n// import x from "node:net";\nconst d = require("http");`).sort(),
    ["../b.js", "./a.js", "./c.js", "http", "node:fs"]);
  const dir = folder(t, base(), GOOD, {
    "lib/ok.js": `import { x } from "./util.js";\nimport fs from "node:fs";\nexport const y = x;\n`,
    "lib/util.js": `export const x = 1;\n`,
    "lib/bad.js": [`import { spawn } from "node:child_process";`, `import net from "net";`, `import https from "node:https";`, `import { Worker } from "worker_threads";`,
      `import cluster from "node:cluster";`, `import dgram from "dgram";`, `import http from "http";`, `import { migrate } from "../../vyre/core/store/index.js";`, `import other from "../../other/index.js";`].join("\n"),
    "bad.test.js": `import { spawn } from "node:child_process";\n`,
  });
  const fails = scanImports(dir);
  for (const spec of ["node:child_process", "net", "node:https", "worker_threads", "node:cluster", "dgram", "http"]) has(fails, new RegExp(`imports ${spec}; a module has no process`));
  has(fails, /imports \.\.\/\.\.\/vyre\/core\/store\/index\.js; a module never imports Vyre's files/);
  has(fails, /imports \.\.\/\.\.\/other\/index\.js, which is outside the module folder/);
  assert.ok(!fails.some(f => f.includes("ok.js") || f.includes("bad.test.js")), fails.join("\n"));
  assert.equal(fails.length, 9);
});

test("conform: each broken rule is one line that says what to change", async t => {
  const m = base();
  m.does.tools[0].summary = "list the reading list \u2014 fast";
  m.teaches = { tips: [{ id: "list", text: "Ask kit for the list.", surfaces: ["chat"], level: "first-use", trigger: "never-used", since: "0.1.0" }] };
  const src = `export default {
  async start(ctx) {
    setInterval(() => {}, 5000);
    ctx.tool("juno.list", { effect: "read", description: "The reading list", input: { type: "object" }, run: () => ({ at: new Date() }) });
    ctx.tool("juno.clear", { effect: "read", input: { type: "object" }, examples: [{ input: { n: 1 } }, { input: {} }], run: () => { ctx.events.emit("juno.gone", {}); return {}; } });
    return { async stop() { setTimeout(() => {}, 30000); } };
  },
};
`;
  const fails = await conformModule(folder(t, m, src));
  has(fails, /tool juno\.list summary has an em dash/);
  has(fails, /juno\.share is declared under does\.tools, but start did not register it/);
  has(fails, /start left a 5000 ms interval running/);
  has(fails, /juno\.list has no examples/);
  has(fails, /juno\.clear examples\[1\] failed: juno: emitted juno\.gone/);
  has(fails, /did something its manifest doesn't declare: juno: emitted juno\.gone/);
  has(fails, /a timeout of 30000 ms \(armed during stop\) was still running after stop/);
  has(fails, /an interval of 5000 ms \(armed during start\)/);
  assert.equal(setInterval.name, "setInterval", "the real timers are back");
});

test("conform: manifest problems, a slow start, a changing migration and a bad entry", async t => {
  const m = base();
  m.does.tools[0] = /** @type {any} */ ("juno.list");
  m.does.tools[1].reach = "person";
  delete m.description;
  let fails = await conformModule(folder(t, m, GOOD));
  has(fails, /manifest: tool "juno\.list" must be an object/);
  has(fails, /manifest: tool "juno\.clear": reach "person" is kept for Vyre's own tools/);
  has(fails, /manifest: description is required/);
  assert.deepEqual(await conformModule(folder(t, m, GOOD), { firstParty: true }), [], "Vyre's own modules keep the grace forms");

  fails = await conformModule(folder(t, base(), `export default { start: () => new Promise(r => setTimeout(r, 2500)) };`));
  has(fails, /start did not return within 2 s/);

  fails = await conformModule(folder(t, base(), GOOD.replace(`ctx.store.migrate(["CREATE TABLE juno_items (id INTEGER PRIMARY KEY, title TEXT)"]);`,
    `n++; ctx.store.migrate(["CREATE TABLE juno_items (id INTEGER PRIMARY KEY, title TEXT)", ...(n > 1 ? ["CREATE TABLE juno_more (id INTEGER)"] : [])]);`)));
  has(fails, /a second start changed the schema/);

  fails = await conformModule(folder(t, base(), `export const nothing = 1;\n`));
  has(fails, /must export default \{ start\(ctx\) \}/);
  fails = await conformModule(folder(t, base(), `export default { start() { throw Object.assign(new Error("no oven"), { code: "no_oven" }); } };\n`));
  has(fails, /start threw: no oven/);
});

test("conform: the ctx doors the source uses are declared, where the source shows it", t => {
  const src = `export default { async start(ctx) {
  await ctx.call("planner.list", {});
  await ctx.gate.request({ kind: "send", via: "mail.send", content: {} });
  await ctx.vault.request("mailer", { method: "GET", url: "https://api.juno.example/" });
  await ctx.connections.call("github", "issues.list", {});
  await ctx.fetch("https://api.juno.example/list");
  await ctx.memory.write({ kind: "fact", text: "juno reads on Sundays" });
  await ctx.ask("what next?", { purpose: "suggest" });
  await ctx.push.offer({ title: "Due", body: "x", kind: "due" });
  await ctx.undo.record({ tool: "juno.list", input: {}, inverse: { tool: "juno.list", input: {} } });
  return { stop() {} };
} };
`;
  const bare = base();
  const fails = scanDoors(folder(t, bare, src), bare);
  for (const re of [/ctx\.call\("planner\.list"\) needs "planner\.list" in needs\.tools/, /ctx\.gate\.request needs "gate\.request"/, /ctx\.vault\.request needs a credential/,
    /ctx\.connections\.call needs a provider/, /ctx\.fetch needs a host/, /ctx\.memory\.write needs "fact" or "note"/, /ctx\.ask and ctx\.spend need needs\.spend/, /ctx\.push\.offer needs its kind/]) has(fails, re);
  assert.equal(fails.length, 8, fails.join("\n"));
  assert.ok(fails.every(f => f.startsWith("index.js: ") && f.endsWith("(undeclared)")));

  const declared = { ...base(), needs: { tools: ["planner.*", "gate.request"], credentials: [{ id: "mailer", kind: "api-credential", provider: "juno", purpose: "read" }],
    connections: [{ provider: "github", purpose: "read issues" }], network: ["api.juno.example"], spend: { dailyUsd: 0.1 } },
    teaches: { memory: ["fact"] }, shows: { notices: ["due"] } };
  assert.deepEqual(scanDoors(folder(t, declared, src), declared), []);
  const wrong = { ...declared, needs: { ...declared.needs, network: ["other.example"], credentials: [{ id: "other", kind: "k", provider: "p", purpose: "x" }] }, teaches: { memory: ["note"] }, shows: { notices: ["late"] } };
  const w = scanDoors(folder(t, wrong, src), wrong);
  for (const re of [/needs its host under needs\.network/, /needs the id mailer under needs\.credentials/, /a fact needs "fact" under teaches\.memory/, /a due notice needs "due" under shows\.notices/]) has(w, re);
});
