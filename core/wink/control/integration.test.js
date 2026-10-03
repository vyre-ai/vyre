// @ts-check
// A real Headscale, our supervisor, our gate in front of it, and one real tailscaled (userspace
// networking, no root) that registers through the gate with a pre-auth key from the supervisor.
// Skipped unless VYRE_WINK_REAL=1 and the binaries exist. Run it on the test server only, never on
// a person's machine:
//   VYRE_WINK_REAL=1 VYRE_HEADSCALE_BIN=... VYRE_TAILSCALED_BIN=... VYRE_TAILSCALE_BIN=... node --test core/wink/control/integration.test.js

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import https from "node:https";
import { spawn, execFile } from "node:child_process";
import { SCRATCH } from "../../../test/scratch.mjs";
import { createHeadscale, freePort, localPrefixes } from "./headscale.js";
import { createGate } from "./gate.js";
import { compilePolicy } from "./policy.js";
import { selfSigned } from "./testing/selfsigned.js";

const HS = process.env.VYRE_HEADSCALE_BIN || "";
const TSD = process.env.VYRE_TAILSCALED_BIN || "";
const TS = process.env.VYRE_TAILSCALE_BIN || "";
const have = (/** @type {string} */ p) => !!p && fs.existsSync(p);
const real = process.env.VYRE_WINK_REAL === "1" && have(HS) && have(TSD) && have(TS);

const lanIp = (() => {
  for (const list of Object.values(os.networkInterfaces())) for (const i of list || []) if (i.family === "IPv4" && !i.internal) return i.address;
  return null;
})();

const run = (/** @type {string} */ bin, /** @type {string[]} */ args, /** @type {object} */ env = {}) => new Promise(resolve => {
  execFile(bin, args, { env: { PATH: process.env.PATH, ...env }, timeout: 60_000 }, (e, out, err) => resolve({ code: e ? 1 : 0, out: String(out), err: String(err) }));
});
const get = (/** @type {number} */ port, /** @type {string} */ host, /** @type {string} */ p) => new Promise(resolve => {
  const r = http.get({ host, port, path: p, timeout: 3000 }, () => { r.destroy(); resolve(null); });
  r.on("error", () => resolve(null));
});

test("real: headscale + gate + one tailscaled node registers through the gate", { skip: !real || !lanIp, timeout: 120_000 }, async t => {
  const dir = fs.mkdtempSync(path.join(SCRATCH, "w-"));
  /** @type {import("node:child_process").ChildProcess|null} */ let tsd = null;
  /** @type {string[]} */ const hsLog = [];
  const gateEvents = [];
  const { cert, key } = selfSigned({ ips: [/** @type {string} */ (lanIp), "127.0.0.1"] });
  const gatePort = await freePort();
  const serverUrl = `https://${lanIp}:${gatePort}`;
  const hs = createHeadscale({
    dir: path.join(dir, "hs"), serverUrl, bin: HS, usedPrefixes: localPrefixes(), supervise: false,
    onLog: l => hsLog.push(l),
  });
  t.after(async () => {
    if (tsd && tsd.exitCode === null) { tsd.kill("SIGTERM"); await new Promise(r => setTimeout(r, 500)); if (tsd.exitCode === null) tsd.kill("SIGKILL"); }
    await hs.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const st = await hs.start();
  assert.equal(st.state, "running");
  console.log(`# headscale ${st.state}, prefix ${st.prefix}, admin socket mode ${(fs.statSync(hs.socketPath).mode & 0o777).toString(8)}`);
  // the gate in front, forwarding to the real daemon's loopback port
  const gate2 = createGate({
    listen: { host: /** @type {string} */ (lanIp), port: gatePort }, tls: { cert, key },
    upstream: { host: "127.0.0.1", port: /** @type {number} */ (hs.listen?.port) }, derp: false, onEvent: e => gateEvents.push(e),
  });
  await gate2.listen();
  t.after(() => gate2.close());
  console.log(`# gate on ${lanIp}:${gatePort}, certificate pin ${gate2.pin}`);

  // The policy first: the tag must exist before a key can carry it.
  hs.setPolicy(compilePolicy({ rows: [], hubPort: 8443, jobPort: 9444, tags: ["tag:wink-device"] }).text);
  await new Promise(r => setTimeout(r, 500));
  const keyFile = path.join(dir, "authkey");
  const k = await hs.createPreauthKey({ tags: ["tag:wink-device"], ttlMs: 300_000, file: keyFile });
  assert.equal(fs.statSync(keyFile).mode & 0o777, 0o600);
  assert.ok(!JSON.stringify([hsLog, gateEvents, k]).includes(fs.readFileSync(keyFile, "utf8")), "the key is in no log, event or answer");

  // One real node, userspace networking, trusting only our gate's certificate.
  const certFile = path.join(dir, "gate.pem");
  fs.writeFileSync(certFile, cert, { mode: 0o600 });
  const sock = path.join(dir, "ts.sock"), state = path.join(dir, "ts");
  fs.mkdirSync(state, { recursive: true });
  const env = { SSL_CERT_FILE: certFile, HOME: dir };
  tsd = spawn(TSD, ["--tun=userspace-networking", `--statedir=${state}`, `--socket=${sock}`, "--no-logs-no-support", "--port=0"], { env: { PATH: process.env.PATH || "", ...env }, stdio: "ignore" });
  for (let i = 0; i < 50 && !fs.existsSync(sock); i++) await new Promise(r => setTimeout(r, 100));
  const up = await run(TS, [`--socket=${sock}`, "up", `--login-server=${serverUrl}`, `--auth-key=file:${keyFile}`, "--hostname=wink-it-1", "--accept-routes=false", "--accept-dns=false", "--ssh=false", "--exit-node=", "--reset", "--timeout=60s"], env);
  console.log(`# tailscale up: code ${up.code} ${up.err.trim().split("\n")[0] || ""}`);
  assert.equal(up.code, 0, up.err);
  await run(TS, [`--socket=${sock}`, "set", "--update-check=false", "--auto-update=false", "--webclient=false"], env);

  const nodes = await hs.listNodes();
  console.log("# nodes:", JSON.stringify(nodes.map(n => ({ id: n.id, name: n.name, ips: n.ips, tags: n.tags, user: n.user, online: n.online }))));
  assert.equal(nodes.length, 1);
  assert.deepEqual(nodes[0].tags, ["tag:wink-device"]);
  assert.ok(nodes[0].ips[0].startsWith(/** @type {string} */ (st.prefix).split(".").slice(0, 3).join(".")), "the node got an address inside the space's /24");
  assert.equal(nodes[0].stableId, String(nodes[0].id));

  // The real client address: Headscale logs the address the gate put in X-Forwarded-For, not the gate's own 127.0.0.1.
  const reg = hsLog.filter(l => /path=\/(machine\/register|ts2021)/.test(l));
  console.log("# headscale log, registration lines:\n" + reg.map(l => "#   " + l).join("\n"));
  assert.ok(reg.length > 0);
  assert.ok(reg.every(l => l.includes(`remote=${lanIp}`)), "the logged remote is the real client address");
  assert.ok(!reg.some(l => l.includes("remote=127.0.0.1")));

  // A node's own policy line after binding: the compiled rules are accepted by the daemon.
  const row = { id: "dev-1", kind: /** @type {"device"} */ ("device"), bound: true, ip: nodes[0].ips[0] };
  const hub = { id: "hub", kind: /** @type {"hub"} */ ("hub"), bound: true, ip: /** @type {string} */ (st.prefix).replace(/\.0\/24$/, ".250") };
  const pol = hs.setPolicy(compilePolicy({ rows: [row, hub], hubPort: 8443, jobPort: 9444, tags: ["tag:wink-device"], prefix: st.prefix || undefined }).text);
  assert.equal(pol.signalled, true);
  await new Promise(r => setTimeout(r, 1000));
  const errs = hsLog.filter(l => /\b(ERR|FTL|PNC)\b|policy.*(error|invalid)/i.test(l));
  console.log(`# after the policy reload: ${errs.length} error lines`);
  assert.deepEqual(errs, []);

  // The front door: nothing but the allow-list reached the daemon.
  for (const p of ["/api/v1/node", "/metrics", "/debug/pprof/", "/", "/windows", "/swagger", "/health"]) await get(gatePort, /** @type {string} */ (lanIp), p);
  // A client that lies about its address: the gate drops the header and Headscale logs the socket's address.
  await new Promise(resolve => {
    const r = https.get({ host: /** @type {string} */ (lanIp), port: gatePort, path: "/key?v=130", ca: cert, servername: "localhost", headers: { "X-Forwarded-For": "6.6.6.6", "True-Client-IP": "7.7.7.7" } }, res => { res.resume(); res.on("end", resolve); });
    r.on("error", resolve);
  });
  await new Promise(r => setTimeout(r, 300));
  const spoof = hsLog.filter(l => /path=\/key/.test(l));
  console.log("# headscale log, /key lines (one sent with X-Forwarded-For: 6.6.6.6):\n" + spoof.map(l => "#   " + l).join("\n"));
  assert.ok(spoof.length > 0 && spoof.every(l => !l.includes("6.6.6.6") && !l.includes("7.7.7.7")));
  // the supervisor's own /health checks come straight to the loopback port, not through the gate
  const seen = hsLog.filter(l => /http request/.test(l) && !(/path=\/health/.test(l) && /remote=127\.0\.0\.1/.test(l))).map(l => (/path=(\S+)/.exec(l) || [])[1]);
  console.log(`# paths Headscale saw: ${[...new Set(seen)].join(" ")}`);
  for (const p of seen) assert.ok(["/key", "/ts2021", "/machine/register", "/machine/map"].includes(p) || p.startsWith("/key"), `unexpected path reached Headscale: ${p}`);
  const gs = gate2.stats();
  console.log(`# gate stats: ${JSON.stringify(gs)}`);

  await hs.deleteNode(nodes[0].id);
  assert.deepEqual(await hs.listNodes(), []);
  console.log("# node deleted, list empty");
});
