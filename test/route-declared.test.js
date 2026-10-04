// @ts-check
// The fetch-site rule (c): every raw route a module registers says whether it only reads or which writing methods it answers, and a
// route answers only those. A GET can be made by any page the person opens, so one with a side effect must never answer GET.

import "../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { tempHome, writeModule } from "./helpers.js";
import { start } from "../core/daemon/index.js";

test("a route with no declaration is refused at registration, and a writing route does not answer GET", async t => {
  const root = tempHome(t);
  writeModule(path.join(root, "modules"), "probe", { does: { tools: ["probe.noop", "probe.refused"] } }, `export default { async start(ctx) {
    ctx.tool("probe.noop", { effect: "read", input: { type: "object" }, run: async () => ({}) });
    ctx.route("reads", (req, res) => { res.writeHead(200); res.end("read"); }, { readOnly: true });
    ctx.route("writes", (req, res) => { res.writeHead(200); res.end("wrote"); }, { methods: ["PUT"] });
    let refused = "";
    try { ctx.route("undeclared", () => {}); } catch (e) { refused = e.message; }
    try { ctx.route("both", () => {}, { readOnly: true, methods: ["PUT"] }); } catch (e) { refused += "|" + e.message; }
    try { ctx.route("getter", () => {}, { methods: ["GET"] }); } catch (e) { refused += "|" + e.message; }
    ctx.tool("probe.refused", { effect: "read", input: { type: "object" }, run: async () => ({ refused }) });
    return {};
  } };`);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ role: "box", transcripts: [], vault: { keystore: "file" }, modules: { enable: [], disable: ["recall", "memory", "learn"] } }));
  const d = await start({ root, log: () => {} });
  t.after(() => d.stop());
  const r = await d.registry.call("probe.refused", {}, "cli");
  assert.match(String(r.data && r.data.refused), /undeclared must say \{ readOnly: true \}/);
  assert.match(String(r.data && r.data.refused), /both is read-only or writes, not both/);
  assert.match(String(r.data && r.data.refused), /getter must say/);
  const http = (method, p) => new Promise((resolve, reject) => {
    import("node:http").then(({ default: h }) => {
      const q = h.request({ socketPath: d.paths.socket, path: p, method }, res => { let b = ""; res.on("data", c => (b += c)); res.on("end", () => resolve({ status: res.statusCode, body: b })); });
      q.on("error", reject); q.end();
    });
  });
  assert.equal((await http("GET", "/v1/probe/reads")).status, 200);
  assert.equal((await http("PUT", "/v1/probe/reads")).status, 405, "a read-only route answers no write");
  assert.equal((await http("GET", "/v1/probe/writes")).status, 405, "a writing route does not answer GET");
  assert.equal((await http("PUT", "/v1/probe/writes")).status, 200);
});

test("every route the shipped modules register is declared", () => {
  // Static: each ctx.route( call in core and local ends with a declaration, so a new one without it fails here and at load.
  const roots = ["core", "local", "modules"];
  const calls = [];
  const walk = dir => { for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name.startsWith(".")) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p); else if (/\.(js|mjs)$/.test(e.name) && !/\.test\./.test(e.name)) {
      const s = fs.readFileSync(p, "utf8");
      for (const m of s.matchAll(/\bctx\.route\(/g)) {
        let depth = 0, k = m.index + m[0].length - 1;
        for (; k < s.length; k++) { if (s[k] === "(") depth++; else if (s[k] === ")" && --depth === 0) break; }
        calls.push({ file: p, tail: s.slice(Math.max(m.index, k - 80), k) });
      }
    }
  } };
  for (const r of roots) if (fs.existsSync(r)) walk(r);
  assert.ok(calls.length >= 5, `found ${calls.length} routes`);
  for (const c of calls) assert.match(c.tail, /\{ (?:readOnly: true|methods: \[[^\]]+\]) \}$/, `${c.file} registers a route with no declaration`);
});
