// A detached child (setsid, then its parent exits, as a nohup or a launchd job would leave it) that connects to
// the real socket as "cli" is capped at mcp: a probe tool sees "mcp", and a person-surface tool that deletes data
// (sync.delete, with confirm: true) is refused before it runs. Boots a daemon: runs on a runner or the test box.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { start } from "../core/daemon/index.js";
import { setSocketTrust, socketTrust } from "../core/daemon/peer.js";
import { tempHome, writeModule } from "./helpers.js";

/** Runs one call from a process that left every ancestry: a shell that setsid-starts the client and exits. */
function detachedCall(dir, socket, tool, input, label) {
  const out = path.join(dir, `out-${Math.random().toString(36).slice(2)}.json`);
  const js = path.join(dir, "client.mjs");
  fs.writeFileSync(js, `import http from "node:http"; import fs from "node:fs";
const data = JSON.stringify(${JSON.stringify(input)});
const req = http.request({ socketPath: ${JSON.stringify(socket)}, path: "/v1/tools/${tool}", method: "POST",
  headers: { "content-type": "application/json", "content-length": Buffer.byteLength(data), "x-vyre-caller": ${JSON.stringify(label)} } }, res => {
  let body = ""; res.on("data", c => (body += c)); res.on("end", () => fs.writeFileSync(${JSON.stringify(out)}, JSON.stringify({ status: res.statusCode, body: JSON.parse(body) })));
});
req.end(data);
`);
  // sh starts the client in its own session in the background and exits at once: the client's parent is gone.
  spawn("/bin/sh", ["-c", `setsid ${JSON.stringify(process.execPath)} ${JSON.stringify(js)} >/dev/null 2>&1 &`], { stdio: "ignore", detached: true }).unref();
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const tick = () => { if (fs.existsSync(out)) { try { return resolve(JSON.parse(fs.readFileSync(out, "utf8"))); } catch { /* still being written */ } } if (Date.now() - t0 > 20_000) return reject(new Error("the detached client never answered")); setTimeout(tick, 100); };
    tick();
  });
}

test("a detached child claiming cli is mcp, and cannot run a person-surface tool that deletes data", async t => {
  if (process.platform === "win32" || !fs.existsSync("/usr/bin/setsid") && !fs.existsSync("/bin/setsid")) return t.skip("needs setsid");
  const was = socketTrust();
  setSocketTrust("strict");
  t.after(() => setSocketTrust(was));
  const root = tempHome(t);
  writeModule(path.join(root, "modules"), "probe", { does: { tools: ["probe.who"] } }, `export default { async start(ctx) {
    ctx.tool("probe.who", { input: { type: "object" }, run: async (i, meta) => ({ caller: meta.caller }) });
    return {};
  } };`);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ role: "box", transcripts: [], vault: { keystore: "file" }, modules: { enable: [], disable: ["recall", "memory", "learn"] } }));
  const d = await start({ root, log: () => {} });
  t.after(() => d.stop());
  const dir = fs.mkdtempSync(path.join(root, "trust-"));
  for (const label of ["cli", "local"]) {
    const r = await detachedCall(dir, d.paths.socket, "probe.who", {}, label);
    assert.equal(r.body.data && r.body.data.caller, "mcp", `${label} from a detached child: ${JSON.stringify(r)}`);
  }
  const del = await detachedCall(dir, d.paths.socket, "sync.delete", { machine: "any", confirm: true }, "cli");
  assert.notEqual(del.status, 200, JSON.stringify(del.body));
  // Refused before it ran: by the callers list (mcp is not a person surface), or by the person-only floor asking for a proof the child cannot give.
  assert.ok(["denied", "presence_required", "no_such_tool"].includes(del.body.error && del.body.error.code), JSON.stringify(del.body));
  assert.notEqual(del.body.error.code, "no_link", "it must not reach the tool: sync.delete would have answered no_link");
});

test("the installer without a terminal (CI, docker exec) can mint the first-run onboarding link, and nothing else is loosened", async t => {
  if (process.platform === "win32" || !fs.existsSync("/usr/bin/setsid") && !fs.existsSync("/bin/setsid")) return t.skip("needs setsid");
  const was = socketTrust();
  setSocketTrust("strict");
  t.after(() => setSocketTrust(was));
  const root = tempHome(t);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ role: "box", transcripts: [], vault: { keystore: "file" }, modules: { enable: [], disable: ["recall", "memory", "learn"] } }));
  const d = await start({ root, log: () => {} });
  t.after(() => d.stop());
  const dir = fs.mkdtempSync(path.join(root, "trust-"));
  // Nobody owns this box yet: a peer with no terminal, capped as a program, still gets the one-time link.
  const link = await detachedCall(dir, d.paths.socket, "onboard.link", {}, "cli");
  assert.equal(link.status, 200, JSON.stringify(link.body));
  assert.match(String(link.body.data && link.body.data.url), /^http:\/\/127\.0\.0\.1:\d+\//);
  // The same child is still capped for everything else: it cannot answer or approve as the person.
  const del = await detachedCall(dir, d.paths.socket, "sync.delete", { machine: "any", confirm: true }, "cli");
  assert.notEqual(del.status, 200, JSON.stringify(del.body));
  // A caller that is not a socket peer capped as a program (an in-process mcp call) still may not.
  const plain = await d.registry.call("onboard.link", {}, "mcp");
  assert.equal(plain.error && plain.error.code !== undefined, true, JSON.stringify(plain));
});

test("once an owner exists, a capped peer cannot mint the onboarding link, and a first-run mint is on the audit trail", async t => {
  if (process.platform === "win32" || !fs.existsSync("/usr/bin/setsid") && !fs.existsSync("/bin/setsid")) return t.skip("needs setsid");
  const was = socketTrust();
  setSocketTrust("strict");
  t.after(() => setSocketTrust(was));
  const base = { role: "box", transcripts: [], vault: { keystore: "file" }, modules: { enable: [], disable: ["recall", "memory", "learn"] } };
  // Owned: the owner has been seen, so the carve-out is closed.
  const owned = tempHome(t);
  fs.writeFileSync(path.join(owned, "config.json"), JSON.stringify({ ...base, network: { tailscale: true, ownerSeen: true } }));
  const d1 = await start({ root: owned, log: () => {} });
  t.after(() => d1.stop());
  const refused = await detachedCall(fs.mkdtempSync(path.join(owned, "trust-")), d1.paths.socket, "onboard.link", {}, "cli");
  assert.notEqual(refused.status, 200, JSON.stringify(refused.body));
  assert.match(JSON.stringify(refused.body), /only from the box's own terminal|not available to mcp/);
  // Fresh: the mint is recorded with the caller and the capped flag.
  const fresh = tempHome(t);
  fs.writeFileSync(path.join(fresh, "config.json"), JSON.stringify(base));
  const d2 = await start({ root: fresh, log: () => {} });
  t.after(() => d2.stop());
  const seen = [];
  d2.events.on("onboard.linked", e => seen.push(e.payload));
  const ok = await detachedCall(fs.mkdtempSync(path.join(fresh, "trust-")), d2.paths.socket, "onboard.link", {}, "cli");
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.deepEqual(seen, [{ caller: "mcp", capped: true, firstRun: true }]);
});
