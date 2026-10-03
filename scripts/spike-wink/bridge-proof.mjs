// bridge-proof.mjs: a drive that only another device can reach, used by a space's home over the Wink connection, on two real machines (tailnet, 3 Oct).
//   node scripts/spike-wink/bridge-proof.mjs init PAIR.json
//   node scripts/spike-wink/bridge-proof.mjs drive --pair F --root D --fwd BIN --control URL [--key K] --relay-host IP --relay-port N --sealing DIR --mount DIR
//        the device with the drive: a Wink node with a door, a relay, and the endpoint that answers the home (a directory stands in for the mounted network drive)
//   node scripts/spike-wink/bridge-proof.mjs home --pair F --root D --fwd BIN --control URL [--key K] --drive DRIVE.json --label direct|blocked --sealing DIR --mount DIR [--mb 16]
//        the space's home: the engine's Pool, the Wink adapter (attachPool, bridgeMakeBackend, pairFromHome) and the node host's connect(space) as the wire
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
import { createBridgeSecrets, createBridgeEndpoint, acceptDrive, pairFromHome, bridgeMakeBackend, BRIDGE_TOOL, DRIVE_TOOL } from "../../core/wink/storage/bridge.js";
import { attachPool } from "../../core/wink/storage/pool.js";

const [mode, ...rest] = process.argv.slice(2);
const opt = k => { const i = rest.indexOf(`--${k}`); return i >= 0 ? rest[i + 1] : undefined; };
const out = o => console.log(JSON.stringify(o));
const b64 = b => Buffer.from(b).toString("base64url");
const unb = s => Buffer.from(s, "base64url");
const SPACE = "harlow", OFFER = "sto_bridgeproof1", DRIVE_DEVICE = "dev_minidrive", HOME_DEVICE = "dev_harlowhome";

if (mode === "init") {
  const box = keyPair(), dev = keyPair(), route = newRouteKey();
  const pair = { space: SPACE, boxId: "box-" + crypto.randomBytes(4).toString("hex"), deviceId: HOME_DEVICE,
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
const mount = path.resolve(String(opt("mount")));

/** A file vault: the stand-in for the real one in this proof. */
function fileVault(file) {
  const read = () => { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return {}; } };
  const write = o => fs.writeFileSync(file, JSON.stringify(o), { mode: 0o600 });
  return { put: async ({ name, fields }) => { const o = read(); o[name] = fields; write(o); }, fetch: async (n, f) => { const v = read()[n]; if (!v) throw new Error("none"); return v[f]; }, remove: async n => { const o = read(); delete o[n]; write(o); } };
}
const secrets = createBridgeSecrets({ vault: fileVault(path.join(root, "vault.json")) });

if (mode === "drive") {
  const { createBridge } = await eng("bridge.js");
  const { createRelay } = await import("../../relay/node/server.js");
  const { relayLink } = await import("../../core/relay/link.js");
  const { bridge } = await import("../../core/relay/bridge.js");
  fs.mkdirSync(mount, { recursive: true });
  const endpoint = createBridgeEndpoint({ createBridge, secrets, log: m => out({ ev: "log", m }) });
  const drive = acceptDrive({ endpoint, secrets, home: () => HOME_DEVICE, roots: [mount] });
  const host = createHost({ root: path.join(root, "node"), forwarderBin: String(opt("fwd")), log: m => out({ ev: "log", m }) });
  host.addSpace({ id: pair.space, controlUrl: String(opt("control")), authKey: opt("key"), hostname: "proof-drive", box: pair.boxId, peerPort: 8443 });
  const up = await host.start(pair.space);
  const boxPriv = unb(pair.box.priv), devPub = unb(pair.device.pub);
  const enrolled = new Map();
  const serve = async (caller, tool, input) => {
    if (tool === BRIDGE_TOOL) return endpoint.handle(caller, input);
    if (tool === DRIVE_TOOL) return drive(caller, input);
    throw Object.assign(new Error("not a tool of this device"), { code: "denied" });
  };
  await host.serveHome(pair.space, { serve, shared: (d, nk) => {
    if (d !== pair.deviceId) return null;
    if (enrolled.has(d) && enrolled.get(d) !== nk) return null;
    enrolled.set(d, nk);
    return dh(boxPriv, devPub);
  } });
  const relay = createRelay();
  const relayUrl = await relay.listen(Number(opt("relay-port")), String(opt("relay-host")));
  const link = relayLink({ url: relayUrl, route: pair.route.id, routeKey: { pub: unb(pair.route.pub), priv: unb(pair.route.priv) }, boxKey: { pub: unb(pair.box.pub), priv: boxPriv },
    admit: async devicePub => { if (!devicePub.equals(devPub)) throw new Error("not a paired device"); return { device: pair.deviceId }; },
    onchannel: (channel, { reply }) => bridge(channel, { handler: (req, res) => { res.statusCode = 404; res.end(); }, caller: `device:${reply.device}`, peer: {},
      peers: { space: pair.space, allow: () => true, accept: host.acceptRelay(pair.space) } }),
    log: m => out({ ev: "log", m }) });
  await link.ready(10_000);
  const info = { peerAddr: `${up.ips[0]}:8443`, nodeKey: up.nodeKey, relay: relayUrl };
  fs.writeFileSync(path.join(root, "drive.json"), JSON.stringify(info));
  out({ ev: "drive-ready", ...info });
  const quit = async () => { link.stop(); await relay.close(); await host.stopAll(); process.exit(0); };
  process.on("SIGTERM", quit); process.on("SIGINT", quit);
  setInterval(() => {}, 1 << 30);
} else if (mode === "home") {
  const driveInfo = JSON.parse(fs.readFileSync(String(opt("drive")), "utf8"));
  const label = String(opt("label")), MB = 1 << 20, mb = Number(opt("mb") || 16);
  const { Pool } = await eng("pool.js");
  const { backendFor } = await eng("devices.js");
  const { dirBackend } = await eng("backends.js");
  const devPriv = unb(pair.device.priv), boxPub = unb(pair.box.pub);
  const rp = relayPeer({ deviceSide, url: driveInfo.relay, route: pair.route.id, box: boxPub, keys: { priv: devPriv, pub: unb(pair.device.pub) } });
  const host = createHost({ root: path.join(root, `node-${label}`), forwarderBin: String(opt("fwd")), log: m => out({ ev: "log", m }),
    device: { id: pair.deviceId, shared: () => dh(devPriv, boxPub) }, relayPeer: space => rp.open(space) });
  host.addSpace({ id: pair.space, controlUrl: String(opt("control")), authKey: opt("key"), hostname: `proof-home-${label}`, box: pair.boxId, peerAddr: driveInfo.peerAddr });
  const t0 = performance.now();
  const up = await host.start(pair.space);
  out({ ev: "node-up", label, ms: Math.round(performance.now() - t0), nodeKey: up.nodeKey.slice(0, 16) + "..." });
  const link = host.connect(pair.space);
  await link.ready(60_000);
  if (label === "direct") {
    const d0 = performance.now();
    while (link.status().path !== "direct" && performance.now() - d0 < 300_000) await new Promise(r => setTimeout(r, 250));
  }
  out({ ev: "connected", label, path: link.status().path, ms: Math.round(performance.now() - t0), status: link.status() });
  const linkTo = d => { if (d !== DRIVE_DEVICE) throw new Error("not a device this home knows"); return link; };

  // 1. pairing: the home makes the secret and hands it to the device, which keeps it and starts serving
  const p0 = performance.now();
  await pairFromHome({ secrets, linkTo }, { offer: OFFER, device: DRIVE_DEVICE, kind: "smb", location: { mount, share: "Office" }, capacity: 200 * MB });
  out({ ev: "paired", label, ms: Math.round(performance.now() - p0), secretInVault: Boolean(await secrets.get(OFFER)) });
  // a frame with a bad signature must be refused by the engine on the device
  const bad = await link.call(BRIDGE_TOOL, { offer: OFFER, op: "ping", key: "", ts: Date.now(), sig: "forged" });
  out({ ev: "forged-frame", label, status: bad.status });
  const none = await link.call(BRIDGE_TOOL, { offer: "sto_unknown", op: "ping", ts: Date.now(), sig: "x" }).then(() => "ALLOWED", e => `${e.code}`);
  out({ ev: "unknown-offer", label, result: none });

  // sizes: a call that carries a body, answered 401 by the engine (bad signature), to find where a call stops fitting through the path
  for (const kb of [16, 64, 256, 512, 1400]) {
    const t = performance.now();
    const r = await link.call(BRIDGE_TOOL, { offer: OFFER, op: "put", key: "x", ts: Date.now(), sig: "forged", body: Buffer.alloc(kb * 1024).toString("base64") }, { timeoutMs: 15_000 }).then(x => `status ${x.status}`, e => `${e.code}`);
    out({ ev: "size-probe", label, path: link.status().path, kb, result: r, ms: Math.round(performance.now() - t) });
  }
  // 2. the pool: its own home copy and the bridged drive added through the adapter
  const poolDir = path.join(root, `pool-${label}`); fs.rmSync(poolDir, { recursive: true, force: true });
  const pool = new Pool({ dir: poolDir, key: crypto.randomBytes(32), chunk: MB });
  const homeBe = dirBackend(path.join(poolDir, "home-chunks"));
  pool.addNode({ id: "home", backend: homeBe, home: true, offered: 500 * MB });
  const storage = { poolOffers: () => [{ id: OFFER, kind: "smb", location: { host: "nas", share: "Office" }, storage: { capacity: 200 * MB, class: ["cold", "backup"] }, seenFrom: DRIVE_DEVICE }], setUsed() {}, drainRequests: () => [] };
  const sync = await attachPool({ storage, pool, by: () => ({ kind: "person", id: "alex" }), log: m => out({ ev: "log", m }), makeBackend: bridgeMakeBackend({ backendFor, secrets, linkTo }) }).sync();
  out({ ev: "pool", label, added: sync.added, skipped: sync.skipped });
  await pool.probe();
  const office = pool.nodes.get(OFFER);
  out({ ev: "office-free", label, free: pool.free(office) });
  for (const k of ["put", "get", "del", "ping"]) { const f = office.backend[k].bind(office.backend); office.backend[k] = async (...a) => { try { return await f(...a); } catch (e) { out({ ev: "backend-error", op: k, code: e.code, message: String(e.message).slice(0, 200) }); throw e; } }; }

  // 3. write: 16 MB cold (two copies: home and the drive) and 4 MB backup (the drive only)
  const data = crypto.randomBytes(mb * MB + 123), data2 = crypto.randomBytes(4 * MB);
  const w0 = performance.now();
  const w = await pool.put(data, { class: "cold" });
  const w1 = performance.now();
  const b = await pool.put(data2, { class: "backup" });
  const w2 = performance.now();
  const chunks = Object.values(pool.ix.chunks), onDrive = chunks.filter(c => c.nodes.includes(OFFER)).length;
  out({ ev: "write", label, path: link.status().path, cold_bytes: data.length, cold_ms: Math.round(w1 - w0), cold_mbit_s: +((data.length * 8) / ((w1 - w0) / 1000) / 1e6).toFixed(1), backup_bytes: data2.length, backup_ms: Math.round(w2 - w1),
    chunks_total: chunks.length, chunks_on_drive: onDrive, atRisk: w.atRisk || b.atRisk });

  // 4. the home loses its own copies; reads must come from the drive alone
  let removed = 0;
  for (const [cid, c] of Object.entries(pool.ix.chunks)) if (c.nodes.includes("home")) { await homeBe.del(`c/${cid}`); removed++; }
  const left = fs.existsSync(path.join(poolDir, "home-chunks")) ? fs.readdirSync(path.join(poolDir, "home-chunks"), { recursive: true }).filter(f => !fs.statSync(path.join(poolDir, "home-chunks", String(f))).isDirectory()).length : 0;
  const r0 = performance.now();
  const got = await pool.get(w.id), r1 = performance.now();
  const got2 = await pool.get(b.id), r2 = performance.now();
  const same = crypto.createHash("sha256").update(got).digest("hex") === crypto.createHash("sha256").update(data).digest("hex") && Buffer.compare(got2, data2) === 0;
  out({ ev: "read-back", label, path: link.status().path, home_copies_removed: removed, home_files_left: left, cold_ms: Math.round(r1 - r0), cold_mbit_s: +((data.length * 8) / ((r1 - r0) / 1000) / 1e6).toFixed(1), backup_ms: Math.round(r2 - r1), identical: same });
  if (!same) { out({ ev: "FAIL", why: "bytes differ" }); process.exitCode = 1; }
  // 5. the wire never carried the secret or anything readable
  const secret = await secrets.get(OFFER);
  const leaked = ["pool-" + label].some(d => { const walk = p => fs.statSync(p).isDirectory() ? fs.readdirSync(p).some(f => walk(path.join(p, f))) : fs.readFileSync(p).includes(secret); return walk(path.join(root, d)); });
  out({ ev: "secret-outside-vault", label, found: leaked });
  link.close(); rp.close();
  await host.stopAll();
  process.exit(process.exitCode || 0);
} else { console.error("usage: bridge-proof.mjs init|drive|home"); process.exit(2); }
