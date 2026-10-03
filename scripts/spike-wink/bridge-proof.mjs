// bridge-proof.mjs: a drive that only the device behind a router can reach, used by a space's home over the connection the DEVICE holds open to it,
// on two real machines (tailnet, 3 Oct). The home never dials the device: the device runs in a network namespace behind NAT (see bridge-proof.sh).
//   node scripts/spike-wink/bridge-proof.mjs init PAIR.json
//   node scripts/spike-wink/bridge-proof.mjs home --pair F --root D --fwd BIN --control URL [--key K] --relay-host IP --relay-port N --sealing DIR --label L [--mb 16] [--cut-file F]
//        the space's home: node with a door, a relay, the engine's Pool, the Wink adapter, the held-connection registry; waits for the device, pairs, writes, reads
//   node scripts/spike-wink/bridge-proof.mjs device --pair F --root D --fwd BIN --control URL [--key K] --peer-addr IP:PORT --relay URL --sealing DIR --mount DIR
//        the device with the drive: a node with NO door, holdDrive() (connect, serve frames, reconnect), the endpoint (a directory stands in for the drive)
// `--sealing` is a checkout of origin/work/sealing (kernel/storage/*): the proof imports the engine from there; core/wink imports nothing from it.
// Everything runs under --root; the secret is held in a file vault under --root (0600), stands in for the real vault, and is never printed.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { keyPair, dh } from "../../core/relay/noise.js";
import { newRouteKey, routeId } from "../../core/relay/wire.js";
import { createHost } from "../../core/wink/node/host.js";
import { relayPeer } from "../../core/wink/node/relay-peer.js";
import { deviceSide } from "../../core/relay/channel.js";
import { createBridgeSecrets, createBridgeEndpoint, acceptDrive, bridgeServe, pairFromHome, bridgeMakeBackend, BRIDGE_TOOL } from "../../core/wink/storage/bridge.js";
import { createHolds, holdDrive } from "../../core/wink/storage/hold.js";
import { attachPool } from "../../core/wink/storage/pool.js";

const [mode, ...rest] = process.argv.slice(2);
const opt = k => { const i = rest.indexOf(`--${k}`); return i >= 0 ? rest[i + 1] : undefined; };
const out = o => console.log(JSON.stringify({ at: Date.now(), ...o }));
const b64 = b => Buffer.from(b).toString("base64url");
const unb = s => Buffer.from(s, "base64url");
const SPACE = "harlow", OFFER = "sto_bridgeproof1", DRIVE_DEVICE = "dev_minidrive";

if (mode === "init") {
  const box = keyPair(), dev = keyPair(), route = newRouteKey();
  const ed = crypto.generateKeyPairSync("ed25519");
  const pair = { space: SPACE, boxId: "box-" + crypto.randomBytes(4).toString("hex"), deviceId: DRIVE_DEVICE,
    entry: { priv: ed.privateKey.export({ type: "pkcs8", format: "der" }).toString("base64url"), pub: ed.publicKey.export({ type: "spki", format: "der" }).subarray(-32).toString("base64url") },
    box: { priv: b64(box.priv), pub: b64(box.pub) }, device: { priv: b64(dev.priv), pub: b64(dev.pub) }, route: { priv: b64(route.priv), pub: b64(route.pub), id: routeId(route.pub) } };
  fs.writeFileSync(rest[0], JSON.stringify(pair), { mode: 0o600 });
  out({ ev: "init", route: pair.route.id });
  process.exit(0);
}

const pair = JSON.parse(fs.readFileSync(String(opt("pair")), "utf8"));
const root = path.resolve(String(opt("root")));
fs.mkdirSync(root, { recursive: true, mode: 0o700 });
const sealing = path.resolve(String(opt("sealing")));
const eng = f => import(path.join(sealing, "kernel", "storage", f));

/** A file vault: the stand-in for the real one in this proof. */
function fileVault(file) {
  const read = () => { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return {}; } };
  const write = o => fs.writeFileSync(file, JSON.stringify(o), { mode: 0o600 });
  return { put: async ({ name, fields }) => { const o = read(); o[name] = fields; write(o); }, fetch: async (n, f) => { const v = read()[n]; if (!v) throw new Error("none"); return v[f]; }, remove: async n => { const o = read(); delete o[n]; write(o); } };
}

if (mode === "home") {
  const label = String(opt("label")), MB = 1 << 20, mb = Number(opt("mb") || 16);
  const { Pool } = await eng("pool.js");
  const { backendFor } = await eng("devices.js");
  const { dirBackend } = await eng("backends.js");
  const { createRelay } = await import("../../relay/node/server.js");
  const { relayLink } = await import("../../core/relay/link.js");
  const { bridge } = await import("../../core/relay/bridge.js");
  const boxPriv = unb(pair.box.priv), devPub = unb(pair.device.pub);
  const host = createHost({ root: path.join(root, `node-${label}`), forwarderBin: String(opt("fwd")), log: m => out({ ev: "log", m }) });
  host.addSpace({ id: pair.space, controlUrl: String(opt("control")), authKey: opt("key"), hostname: `proof-home-${label}`, box: pair.boxId, peerPort: 8443 });
  const t0 = performance.now();
  const up = await host.start(pair.space);
  out({ ev: "node-up", label, ms: Math.round(performance.now() - t0), nodeKey: up.nodeKey.slice(0, 16) + "..." });
  const holds = createHolds({ waitMs: 60_000, log: m => out({ ev: "log", m }) });
  const identity = { entry: eid => (eid === DRIVE_DEVICE ? { eid, kind: "device", pub: pair.entry.pub } : null) };
  const refuse = async () => { throw Object.assign(new Error("the home answers nothing to a drive's device"), { code: "denied" }); };
  await host.serveHome(pair.space, { serve: refuse, relayServe: refuse, identity, onSession: (caller, session) => { out({ ev: "session", label, caller, t: Math.round(performance.now() - t0) }); holds.onSession(caller, session); } });
  const relay = createRelay();
  const relayUrl = await relay.listen(Number(opt("relay-port")), String(opt("relay-host")));
  const link = relayLink({ url: relayUrl, route: pair.route.id, routeKey: { pub: unb(pair.route.pub), priv: unb(pair.route.priv) }, boxKey: { pub: unb(pair.box.pub), priv: boxPriv },
    admit: async devicePub => { if (!devicePub.equals(devPub)) throw new Error("not a paired device"); return { device: DRIVE_DEVICE }; },
    onchannel: (channel, { reply }) => bridge(channel, { handler: (req, res) => { res.statusCode = 404; res.end(); }, caller: `device:${reply.device}`, peer: {},
      peers: { space: pair.space, allow: () => true, accept: host.acceptRelay(pair.space) } }),
    log: m => out({ ev: "log", m }) });
  await link.ready(10_000);
  out({ ev: "home-ready", label, peerAddr: `${up.ips[0]}:8443`, relay: relayUrl });
  // the device dials out; wait for the connection it holds
  const w0 = performance.now();
  while (!holds.has(DRIVE_DEVICE) && performance.now() - w0 < 300_000) await new Promise(r => setTimeout(r, 200));
  if (!holds.has(DRIVE_DEVICE)) { out({ ev: "FAIL", why: "the device never connected" }); process.exit(1); }
  out({ ev: "connected", label, ms: Math.round(performance.now() - t0), waitedMs: Math.round(performance.now() - w0) });
  if (opt("settle")) { await new Promise(r => setTimeout(r, Number(opt("settle")) * 1000)); out({ ev: "settled", label, sessions: "newest open session is used" }); }
  const secrets = createBridgeSecrets({ vault: fileVault(path.join(root, "vault.json")) });
  const linkTo = d => holds.linkTo(d);

  // 1. pairing: the device opens, the home seals the secret to its one-time key and sends only the sealed box
  const p0 = performance.now();
  await pairFromHome({ secrets, linkTo }, { offer: OFFER, device: DRIVE_DEVICE, kind: "smb", location: { mount: opt("dev-mount"), share: "Office" }, capacity: 200 * MB });
  out({ ev: "paired", label, ms: Math.round(performance.now() - p0), secretInVault: Boolean(await secrets.get(OFFER)) });
  const bad = await linkTo(DRIVE_DEVICE).call(BRIDGE_TOOL, { offer: OFFER, op: "ping", key: "", ts: Date.now(), sig: "forged" });
  out({ ev: "forged-frame", label, status: bad.status });
  const none = await linkTo(DRIVE_DEVICE).call(BRIDGE_TOOL, { offer: "sto_unknown", op: "ping", ts: Date.now(), sig: "x" }).then(() => "ALLOWED", e => `${e.code}`);
  out({ ev: "unknown-offer", label, result: none });
  for (const kb of [64, 512, 1400]) {
    const t = performance.now();
    const r = await linkTo(DRIVE_DEVICE).call(BRIDGE_TOOL, { offer: OFFER, op: "put", key: "x", ts: Date.now(), sig: "forged", body: Buffer.alloc(kb * 1024).toString("base64") }, { timeoutMs: 15_000 }).then(x => `status ${x.status}`, e => `${e.code}`);
    out({ ev: "size-probe", label, kb, result: r, ms: Math.round(performance.now() - t) });
  }
  // 2. the pool: its own home copy and the bridged drive added through the adapter
  const poolDir = path.join(root, `pool-${label}`); fs.rmSync(poolDir, { recursive: true, force: true });
  const pool = new Pool({ dir: poolDir, key: crypto.randomBytes(32), chunk: MB });
  const homeBe = dirBackend(path.join(poolDir, "home-chunks"));
  pool.addNode({ id: "home", backend: homeBe, home: true, offered: 500 * MB });
  const storage = { poolOffers: () => [{ id: OFFER, kind: "smb", location: { host: "nas", share: "Office", via: DRIVE_DEVICE }, storage: { capacity: 200 * MB, class: ["cold", "backup"] }, seenFrom: "the Mac mini", seenFromDevice: DRIVE_DEVICE }], setUsed() {}, drainRequests: () => [] };
  const sync = await attachPool({ storage, pool, by: () => ({ kind: "person", id: "alex" }), log: m => out({ ev: "log", m }), makeBackend: bridgeMakeBackend({ backendFor, secrets, linkTo, retry: { log: m => out({ ev: "retry", m }) } }) }).sync();
  out({ ev: "pool", label, added: sync.added, skipped: sync.skipped });
  await pool.probe();
  const office = pool.nodes.get(OFFER);
  out({ ev: "office-free", label, free: pool.free(office) });
  let first = true;
  for (const k of ["put", "get", "del", "ping"]) { const f = office.backend[k].bind(office.backend); office.backend[k] = async (...a) => {
    if (k === "put" && first && opt("cut-file")) { first = false; fs.writeFileSync(String(opt("cut-file")), String(Date.now())); }
    try { return await f(...a); } catch (e) { out({ ev: "backend-error", op: k, code: e.code, message: String(e.message).slice(0, 200) }); throw e; } }; }
  office.backend.stats = office.backend.stats;

  // 3. write: cold (two copies: home and the drive) and a 4 MB backup (the drive only)
  const data = crypto.randomBytes(mb * MB + 123), data2 = crypto.randomBytes(4 * MB);
  const wr0 = performance.now();
  const w = await pool.put(data, { class: "cold" });
  const wr1 = performance.now();
  const b = await pool.put(data2, { class: "backup" });
  const wr2 = performance.now();
  const chunks = Object.values(pool.ix.chunks), onDrive = chunks.filter(c => c.nodes.includes(OFFER)).length;
  out({ ev: "write", label, cold_bytes: data.length, cold_ms: Math.round(wr1 - wr0), cold_mbit_s: +((data.length * 8) / ((wr1 - wr0) / 1000) / 1e6).toFixed(1), backup_bytes: data2.length, backup_ms: Math.round(wr2 - wr1),
    chunks_total: chunks.length, chunks_on_drive: onDrive, atRisk: w.atRisk || b.atRisk, retried: office.backend.stats && office.backend.stats.retried, failedCalls: office.backend.stats && office.backend.stats.failedCalls });
  // 4. the home loses its own copies; reads must come from the drive alone
  let removed = 0;
  for (const [cid, c] of Object.entries(pool.ix.chunks)) if (c.nodes.includes("home")) { await homeBe.del(`c/${cid}`); removed++; }
  const left = fs.existsSync(path.join(poolDir, "home-chunks")) ? fs.readdirSync(path.join(poolDir, "home-chunks"), { recursive: true }).filter(f => !fs.statSync(path.join(poolDir, "home-chunks", String(f))).isDirectory()).length : 0;
  const r0 = performance.now();
  const got = await pool.get(w.id), r1 = performance.now();
  const got2 = await pool.get(b.id), r2 = performance.now();
  const same = crypto.createHash("sha256").update(got).digest("hex") === crypto.createHash("sha256").update(data).digest("hex") && Buffer.compare(got2, data2) === 0;
  out({ ev: "read-back", label, home_copies_removed: removed, home_files_left: left, cold_ms: Math.round(r1 - r0), cold_mbit_s: +((data.length * 8) / ((r1 - r0) / 1000) / 1e6).toFixed(1), backup_ms: Math.round(r2 - r1), identical: same });
  if (!same) { out({ ev: "FAIL", why: "bytes differ" }); process.exitCode = 1; }
  const secret = await secrets.get(OFFER);
  const leaked = (function walk(p) { return fs.statSync(p).isDirectory() ? fs.readdirSync(p).some(f => walk(path.join(p, f))) : fs.readFileSync(p).includes(secret); })(poolDir);
  out({ ev: "secret-outside-vault", label, found: leaked });
  link.stop(); await relay.close(); await host.stopAll();
  process.exit(process.exitCode || 0);
} else if (mode === "device") {
  const mount = path.resolve(String(opt("mount")));
  const { createBridge } = await eng("bridge.js");
  fs.mkdirSync(mount, { recursive: true });
  const secrets = createBridgeSecrets({ vault: fileVault(path.join(root, "vault.json")) });
  const endpoint = createBridgeEndpoint({ createBridge, secrets, log: m => out({ ev: "log", m }) });
  const drive0 = acceptDrive({ endpoint, secrets, home: () => pair.boxId, roots: [mount], exists: p => { try { return fs.statSync(p).isDirectory(); } catch { return false; } } });
  const stateFile = path.join(root, "serving.json");
  // what the device serves is kept on disk, so a restart serves it again (the offer rows do this in the product)
  const drive = async (caller, input) => { const r = await drive0(caller, input); if (input.step === "seal") fs.writeFileSync(stateFile, JSON.stringify({ offer: input.offer, dir: path.join(mount, `vyre-${input.offer}`), capacity: input.capacity })); return r; };
  try { const st = JSON.parse(fs.readFileSync(stateFile, "utf8")); await endpoint.serve({ ...st, caller: `device:${pair.boxId}` }); out({ ev: "re-served", offer: st.offer }); } catch { /* first run */ }
  const edPriv = crypto.createPrivateKey({ key: unb(pair.entry.priv), format: "der", type: "pkcs8" });
  const rp = relayPeer({ deviceSide, url: String(opt("relay")), route: pair.route.id, box: unb(pair.box.pub), keys: { priv: unb(pair.device.priv), pub: unb(pair.device.pub) } });
  const host = createHost({ root: path.join(root, "node"), forwarderBin: String(opt("fwd")), log: m => out({ ev: "log", m }),
    device: { id: DRIVE_DEVICE, sign: msg => crypto.sign(null, msg, edPriv).toString("base64url") }, relayPeer: space => rp.open(space), graceMs: 1500 });
  host.addSpace({ id: pair.space, controlUrl: String(opt("control")), authKey: opt("key"), hostname: "proof-device", box: pair.boxId, peerAddr: String(opt("peer-addr")) });
  const t0 = performance.now();
  const up = await host.start(pair.space);
  out({ ev: "node-up", ms: Math.round(performance.now() - t0), listening: false });
  const serve = bridgeServe({ endpoint, drive, home: () => pair.boxId });
  const hold = holdDrive({ connect: (sp, o) => { const l = host.connect(sp, o); l.onchange(() => out({ ev: "link", t: Math.round(performance.now() - t0), ...l.status() })); return l; }, serve, space: pair.space, stuckMs: 20_000, log: m => out({ ev: "log", m }) });
  setInterval(() => out({ ev: "hold", t: Math.round(performance.now() - t0), ...hold.status() }), 10_000).unref();
  const quit = async () => { hold.stop(); rp.close(); await host.stopAll(); process.exit(0); };
  process.on("SIGTERM", quit); process.on("SIGINT", quit);
  setInterval(() => {}, 1 << 30);
} else { console.error("usage: bridge-proof.mjs init|home|device"); process.exit(2); }
