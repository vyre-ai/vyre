// @ts-check
// VYRE_SUPERVISOR=app: the Windows app's core answers its five import tools and health on its pipe, nothing else, and runs only the modules it was told.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { tempHome } from "../../test/helpers.js";
import { start, appAllows } from "./index.js";

const call = (socketPath, method, path, body) => new Promise((resolve, reject) => {
  const req = http.request({ socketPath, method, path, headers: { "x-vyre-caller": "local", "content-type": "application/json" } }, res => {
    let b = ""; res.on("data", c => (b += c)); res.on("end", () => resolve({ status: res.statusCode, body: b }));
  });
  req.on("error", reject); req.end(body ? JSON.stringify(body) : undefined);
});

test("app mode: the allowed requests are exactly health and the five import tools", () => {
  const r = (method, url) => appAllows(/** @type {any} */ ({ method, url }));
  assert.equal(r("GET", "/v1/health"), true);
  for (const t of ["scan", "plan", "start", "stop", "status"]) assert.equal(r("POST", `/v1/tools/import.${t}`), true, t);
  for (const [m, u] of [["GET", "/v1/tools"], ["GET", "/v1/modules"], ["GET", "/v1/events"], ["POST", "/v1/tools/vault.get"], ["POST", "/v1/tools/import.cancel"], ["POST", "/v1/tools/import.scan%2e"], ["POST", "/v1/sync/upload/x"], ["GET", "/v1/streams/a/b"], ["PUT", "/v1/tools/import.scan"]]) assert.equal(r(m, u), false, `${m} ${u}`);
});

test("app mode: a running core refuses everything else and starts only the modules named", { timeout: 60_000 }, async t => {
  const root = tempHome(t);
  const keep = { s: process.env.VYRE_SUPERVISOR, m: process.env.VYRE_MODULES_ONLY };
  process.env.VYRE_SUPERVISOR = "app"; process.env.VYRE_MODULES_ONLY = "import,recall,memory,projects,sync,link";
  const d = await start({ root, log: () => {} });
  t.after(async () => { await d.stop(); for (const [k, v] of [["VYRE_SUPERVISOR", keep.s], ["VYRE_MODULES_ONLY", keep.m]]) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
  const sock = d.paths.socket;
  assert.equal((await call(sock, "GET", "/v1/health")).status, 200);
  assert.equal((await call(sock, "POST", "/v1/tools/import.status", {})).status, 200);
  for (const [m, p] of [["GET", "/v1/tools"], ["GET", "/v1/modules"], ["POST", "/v1/tools/vault.list"], ["POST", "/v1/tools/projects.list"]]) assert.equal((await call(sock, m, p, m === "POST" ? {} : undefined)).status, 404, `${m} ${p}`);
  const running = d.registry.status().filter(x => x.state === "running").map(x => x.name).sort();
  assert.ok(running.length <= 8, running.join(","));
  for (const n of running) assert.ok(["import", "recall", "memory", "projects", "sync", "link", "settings", "presence"].includes(n) || process.env.VYRE_MODULES_ONLY.split(",").includes(n), n);
  assert.ok(!running.includes("computers") && !running.includes("tailnet") && !running.includes("network"));
});
