// Shared rig and disk helpers for runner.session.test.js and runner.handover.test.js (split from runner.test.js for per-file time limits).
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import crypto from "node:crypto";
import { SCRATCH, runnerScratch } from "../../test/scratch.mjs";
import { createRunner } from "./runner.js";
import { unavailable } from "./sandbox.js";
import { workspaceUnavailable, fscryptSupported } from "./workspace.js";
import { fakeSpace } from "./testing/fake-space.js";
import { HARNESS_MARK } from "./pipe-home.js";

export const PLUGIN_FLAG = `--${"plugin-dir"}`;
export const SKIP = unavailable() || workspaceUnavailable() || "";
export const LINUX = process.platform === "linux";
export const tmp = () => runnerScratch("rn-");
export const rm = d => fs.rmSync(d, { recursive: true, force: true });
export const sleep = ms => new Promise(r => setTimeout(r, ms));

const hmac = s => crypto.createHmac("sha256", "test-seal-key").update(s).digest("hex");
const seal = st => ({ ...st, mac: hmac(JSON.stringify(st)) });
const unseal = st => { const { mac, ...rest } = st || {}; return Boolean(mac) && mac === hmac(JSON.stringify(rest)); };

export const procState = pid => { try { const t = fs.readFileSync(`/proc/${pid}/stat`, "utf8"); return t.slice(t.lastIndexOf(")") + 2, t.lastIndexOf(")") + 3); } catch { return ""; } };

function* diskFiles(root) {
  for (const e of fs.readdirSync(root, { withFileTypes: true })) {
    const f = path.join(root, e.name);
    if (e.name === "mnt") continue;
    if (e.isDirectory()) yield* diskFiles(f);
    else if (e.isFile()) {
      try { yield [f, fs.readFileSync(f)]; } catch { /* locked fscrypt ciphertext is not readable as a file */ }
    }
  }
}
export const diskPlaintextSearch = base => !(process.platform === "linux" && fscryptSupported(base));
export const findOnDisk = (root, needles) => { const hits = []; for (const [f, b] of diskFiles(root)) for (const n of needles) if (b.includes(Buffer.from(n))) hits.push([f, n]); return hits; };

export const get = (port, p, headers = {}, method = "GET") => new Promise(res => { const q = http.request({ hostname: "127.0.0.1", port, path: p, method, headers }, m => { let b = ""; m.on("data", d => b += d); m.on("end", () => res({ status: m.statusCode, body: b })); }); q.on("error", e => res({ error: e.code })); q.end(); });

export async function upstream() {
  const seen = [];
  const s = http.createServer((req, res) => { seen.push({ url: req.url, headers: req.headers }); res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ ok: true })); });
  await new Promise(r => s.listen(0, "127.0.0.1", r));
  return { port: s.address().port, seen, close: () => new Promise(r => { s.closeAllConnections(); s.close(r); }) };
}

export async function rig(t, over = {}) {
  const base = tmp(); const agentDir = tmp(); const outsideDir = tmp();
  fs.copyFileSync(new URL("./testing/fake-agent.js", import.meta.url), path.join(agentDir, "agent.js"));
  fs.writeFileSync(path.join(outsideDir, "private.txt"), "OUTSIDE-PRIVATE-FILE");
  const up = await upstream();
  const sp = over.space || fakeSpace({ ttlMs: over.ttlMs || 3_600_000 });
  const grants = over.grants || { spaceAllows: true, memberAccepts: true };
  const server = { starts: 0, asked: [] };
  const mk = (b = base) => createRunner({ base: b, space: "harlow", device: "kit", vault: sp.vault, sync: sp.sync, grants: () => grants, requestServer: over.requestServer || ((session, reason) => { server.starts++; server.asked.push([session, reason]); }), retryMs: 50, ...(over.onEvent ? { onEvent: over.onEvent } : {}), sealState: seal, verifyState: unseal, sessionState: s => ({ v: 1, session: s, taint: "external" }) });
  const runner = mk();
  const routes = [{ prefix: "/provider", upstream: `http://127.0.0.1:${up.port}`, credential: { header: "x-api-key" }, allow: [{ method: "GET", path: "/v1/messages" }, { method: "POST", path: "/v1/messages" }] },
    { prefix: "/space", upstream: `http://127.0.0.1:${up.port}/api`, credential: { header: "authorization", prefix: "Bearer " }, allow: [{ method: "GET", path: "/gmail/*" }] }];
  const launch = (r, session, extra = {}) => r.start({ session, command: process.execPath, args: [path.join(agentDir, "agent.js"), ...(extra.moreArgs || [])], readOnly: [agentDir], routes,
    env: { VYRE_PROBE_FILE: path.join(outsideDir, "private.txt"), VYRE_PROBE_HOME: process.env.HOME || process.env.USERPROFILE || "/root", VYRE_PROBE_PORT: String(up.port) }, ...extra });
  t.after(async () => { try { await runner.stopAll(); await runner.lock(); } catch {} await up.close(); for (const d of [base, agentDir, outsideDir]) rm(d); });
  return { base, runner, sp, up, routes, launch, server, mk };
}

export const waitFor = async (fn, ms = 10000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = await fn(); if (v) return v; await sleep(50); } throw new Error("timed out"); };

export { HARNESS_MARK, SCRATCH };
