// Lending end to end over the REAL Wink peer wire (core/wink/node/peer-wire.js: admitPeer and joinPeer, ed25519 device-key proof) with the real kernel and the real sealing process at the
// home, the real runner, sandbox and encrypted workspace on the lender. Roles, each on its own box, driven by scripts/runner-lend-e2e.sh:
//   home <port> <root> <agentPath>         the Space's home: real kernel + real sealer + Offers, the lent-home service, the kernel remote server behind withKernelCall, a Wink door on <port>
//   lender <port> <base> <device>          a member's computer lending itself: joins the home over the Wink wire, leases its workspace key, takes the session's definition, runs it, checkpoints to the home
//   resume <port> <base> <device>          another computer of the same member: continues the session from the home's last checkpoint
//   peek <port> <device>                   what the home holds for the session
// STAND-INS (listed in team/archive/work-journals/runner.md): the TCP carrier (an ssh port forward instead of the tailnet, ufw blocks the boxes' own ports); presence for the Offers (SHIM(presence), as in
// kernel/gateway/leases.real.test.js); the device keys (derived from a seed, no identity chain); the agent (testing/fake-agent.js).
import "../core/runner/testing/hosted-guard.js";
import fs from "node:fs"; import path from "node:path"; import net from "node:net"; import crypto from "node:crypto";
import { createKernel } from "../kernel/index.js";
import { canonical, sha256 } from "../kernel/core/canonical.js";
import { startSealer } from "../kernel/seal/client.js";
import { createRemoteServer } from "../kernel/remote/server.js";
import { createRemoteKernel } from "../kernel/remote/client.js";
import { withKernelCall, winkTransport } from "../kernel/remote/wink.js";
import { admitPeer, joinPeer, socketPipe } from "../core/wink/node/peer-wire.js";
import { createLentHome } from "../core/runner/lent-home.js";
import { createLenderHost } from "../core/runner/lender-host.js";
import { createRunner } from "../core/runner/runner.js";

const [role, ...a] = process.argv.slice(2);
const SPACE = "spc_aaaaaaaaaaaa", OWNER = "per_owner", BOB = "per_bob", NK = "nodekey:" + "44".repeat(32), SES = process.env.SESSION || "s1";
const DEVICES = ["dev_lender", "dev_server"];
const t0 = Date.now(), log = (...x) => console.log(String(Math.round((Date.now() - t0) / 100) / 10).padStart(6) + "s", ...x);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const seedOf = d => crypto.createHash("sha256").update("vyre-lend-e2e:" + d).digest();
const privOf = d => crypto.createPrivateKey({ key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seedOf(d)]), format: "der", type: "pkcs8" });
const pubOf = d => crypto.createPublicKey(privOf(d)).export({ format: "der", type: "spki" }).subarray(-32).toString("base64url");
const proof = (action, input, resource) => ({ op: `grant.${action.split(".")[1]}`, fields: { resource, input_hash: sha256(canonical({ action, input })) }, n: Math.random() });
const used = new Set();
const presence = { check: async ({ chain, op, fields, proof: p }) => (chain && p && p.op === op && canonical(p.fields) === canonical(fields) && !used.has(p.n) && (used.add(p.n), true) ? null : "wrong_payload") };

if (role === "home") {
  const [port, root, agentPath] = a;
  fs.mkdirSync(root, { recursive: true });
  const sealer = startSealer({ dir: path.join(root, "seal"), timeoutMs: 8000, dev: true, unattested: true });
  const k = await createKernel({ space: SPACE, owner: OWNER, owner_uid: 501, key: Buffer.alloc(32, 8), sealer, presence, resolveCredential: async () => ({ secret: "v" }) });
  const owner = k.chains.fromFacts({ kind: "device", device_key_id: "d-o", person: OWNER, path: "direct", session: "s" });
  const g = k.gateway.grants, role_ = { person: BOB, role: "member" };
  await g.setRole(owner, role_, { presence: proof("grants.role", role_, `vyre://${SPACE}/member/${BOB}`) });
  const mk = (chain, o) => g.offers.offer(chain, o, { presence: proof("grants.offer", o, `vyre://${SPACE}/offer/new`) });
  await mk(owner, { side: "space_allows", member: BOB });
  for (const d of DEVICES) await mk(k.chains.fromFacts({ kind: "device", device_key_id: d, person: BOB, path: "direct" }), { side: "member_accepts", member: BOB, device: d, device_key: "KEY_" + d });
  const agentDir = path.dirname(agentPath);
  const home = createLentHome({ space: SPACE, root: path.join(root, "lent"), offers: g.offers, leases: k.gateway.leases, lenderCap: () => process.env.CAP || undefined,
    specFor: async () => ({ command: process.execPath, args: [agentPath], env: {}, routes: [], readOnly: [agentDir, path.dirname(process.execPath)], labels: {}, network: process.env.NETWORK || "internet", credentialRoutes: [] }) });
  const server = createRemoteServer({ space: SPACE, kernel: k, services: { lent: home } });
  const dispatch = withKernelCall(async () => { throw Object.assign(new Error("no such tool"), { code: "no_such_tool" }); }, { serverFor: s => (s === SPACE ? server : null), personOf: d => (DEVICES.includes(d) ? BOB : null), pathOf: () => "wink" });
  net.createServer(sock => { admitPeer(socketPipe(sock), { id: { nodeKey: NK }, box: "home", entry: eid => (DEVICES.includes(eid) ? { eid, kind: "device", pub: pubOf(eid) } : null), serve: (c, tool, input) => dispatch(c, tool, input) }).catch(() => {}); sock.on("error", () => {}); })
    .listen(Number(port), "127.0.0.1", () => log("home listening (Wink peer wire)", port, "real sealer, real kernel"));
} else {
  const port = Number(a[0]);
  const device = role === "peek" ? a[1] : a[2];
  const sock = net.connect(port, "127.0.0.1"); await new Promise((res, rej) => { sock.once("connect", res); sock.once("error", rej); });
  const wink = await joinPeer(socketPipe(sock), { device, nodeKey: NK, sign: m => crypto.sign(null, m, privOf(device)).toString("base64url") });
  const remote = createRemoteKernel({ space: SPACE, transport: winkTransport({ sessionFor: () => wink }) });
  const host = createLenderHost({ invoke: remote.call, deviceId: device, deviceKey: "KEY_" + device, ...(process.env.CAP ? { lenderCap: process.env.CAP } : {}) });
  await host.ready;
  const sync = host.ports.sync;
  if (role === "peek") { const cp = await sync.getCheckpoint(SES).catch(e => ({ error: e.code })); const lines = cp && !cp.error ? await sync.getTranscript(SES, 1).catch(() => []) : []; console.log(JSON.stringify({ turn: cp?.turn ?? 0, seq: cp?.seq ?? 0, files: Object.keys(cp?.manifest || {}), transcriptLines: lines.length, grants: host.ports.grants() })); process.exit(0); }
  const base = a[1]; const agentDir = path.join(base, "agent"); fs.mkdirSync(agentDir, { recursive: true });
  fs.copyFileSync(new URL("../core/runner/testing/fake-agent.js", import.meta.url), path.join(agentDir, "agent.js"));
  const r = createRunner({ base: path.join(base, "rn"), space: "harlow", device, ...host.ports, watchdog: false, verifyState: () => true, state: () => ({ onPower: true, awake: true, cpuPct: 10, memPct: 40 }),
    onEvent: e => { if (e.type === "checkpoint" || e.type === "exit") log("event", JSON.stringify(e).slice(0, 200)); } });
  const spec = await host.ports.spec({ session: SES });
  log(role, "definition from the home: network", spec.network, "(lender cap", process.env.CAP || "none", ")");
  const h = await r.start({ session: SES, resume: role === "resume", command: process.execPath, args: [path.join(agentDir, "agent.js")], readOnly: [agentDir, path.dirname(process.execPath)], routes: [], network: spec.network });
  log(role, "started pid", h.pid, "resumed", JSON.stringify(h.resumed ? { turn: h.resumed.turn, seq: h.resumed.seq } : null));
  h.child.stdout.on("data", d => { for (const l of String(d).split("\n").filter(Boolean)) log("agent>", l.slice(0, 300)); });
  const homeTurn = async () => (await sync.getCheckpoint(SES))?.turn || 0;
  if (role === "lender") {
    for (const [n, w] of [[1, "alpha"], [2, "bravo"]]) { h.send("turn " + w); for (let i = 0; i < 120 && (await homeTurn()) < n; i++) await sleep(500); log("home holds checkpoint", await homeTurn()); }
    h.send("turn charlie"); log("turn 3 sent");
    await sleep(Number(process.env.KILL_AFTER_MS || 0)); process.kill(-process.pid, "SIGKILL");
    await sleep(600000);
  } else {
    await sleep(8000);
    h.send("turn delta"); for (let i = 0; i < 120 && (await homeTurn()) < (h.resumed?.turn || 0) + 1; i++) await sleep(500);
    log("after resume the home holds checkpoint", await homeTurn());
    await h.stop(); await r.lock(); process.exit(0);
  }
}
