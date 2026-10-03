// net-proof.mjs: the Wink embedded node host proven on two real machines (team/0.3, wink-net).
//   node scripts/spike-wink/net-proof.mjs init  PAIR.json            throwaway keys for one run
//   node scripts/spike-wink/net-proof.mjs home  --pair F --root D --fwd BIN --control URL --key K --relay-host IP --relay-port N
//        a real vyred (temp home), a Wink node for the space with a peer door, a relay, and the relay box side
//   node scripts/spike-wink/net-proof.mjs server --pair F --root D --fwd BIN --control URL [--key K] --home HOME.json --relay URL --label direct|blocked [--n 200]
//        a paired server: connect(space), real registry calls through the home's daemon, latency numbers as JSON lines
// Everything runs under --root (a dedicated directory), stops only what it started, and prints no key.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { keyPair, dh } from "../../core/relay/noise.js";
import { newRouteKey, routeId } from "../../core/relay/wire.js";
import { createHost } from "../../core/wink/node/host.js";
import { relayPeer } from "../../core/wink/node/relay-peer.js";
import { deviceSide } from "../../core/relay/channel.js";

const [mode, ...rest] = process.argv.slice(2);
const opt = k => { const i = rest.indexOf(`--${k}`); return i >= 0 ? rest[i + 1] : undefined; };
const out = o => console.log(JSON.stringify(o));
const b64 = b => Buffer.from(b).toString("base64url");
const unb = s => Buffer.from(s, "base64url");
const SPACE = "harlow";

if (mode === "init") {
  const box = keyPair(), dev = keyPair(), route = newRouteKey();
  const pair = { space: SPACE, boxId: "box-" + crypto.randomBytes(4).toString("hex"), deviceId: "srv1",
    box: { priv: b64(box.priv), pub: b64(box.pub) }, device: { priv: b64(dev.priv), pub: b64(dev.pub) }, route: { priv: b64(route.priv), pub: b64(route.pub), id: routeId(route.pub) } };
  fs.writeFileSync(rest[0], JSON.stringify(pair), { mode: 0o600 });
  out({ ev: "init", route: pair.route.id });
  process.exit(0);
}

const pair = JSON.parse(fs.readFileSync(String(opt("pair")), "utf8"));
const root = path.resolve(String(opt("root")));
fs.mkdirSync(root, { recursive: true, mode: 0o700 });

if (mode === "home") {
  const { start } = await import("../../core/daemon/index.js");
  const { createRelay } = await import("../../relay/node/server.js");
  const { relayLink } = await import("../../core/relay/link.js");
  const { bridge } = await import("../../core/relay/bridge.js");
  const daemon = await start({ root: path.join(root, "vyre-home") });
  out({ ev: "daemon", tools: daemon.registry.tools.size });
  const host = createHost({ root: path.join(root, "node"), forwarderBin: String(opt("fwd")), log: m => out({ ev: "log", m }) });
  host.addSpace({ id: pair.space, controlUrl: String(opt("control")), authKey: opt("key"), hostname: "proof-home", box: pair.boxId, peerPort: 8443 });
  const up = await host.start(pair.space);
  const boxPriv = unb(pair.box.priv), devPub = unb(pair.device.pub);
  const enrolled = new Map(); // the first node key seen for a device is bound to it (the module's registry does this in the product)
  const serve = async (caller, tool, input) => {
    if (tool === "proof.bulk") return { pad: "x".repeat(Number(input.bytes) || 0) };
    const r = await daemon.registry.call(tool, input, caller);
    if (r.error) throw Object.assign(new Error(r.error.message), { code: r.error.code });
    return r.data;
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
  fs.writeFileSync(path.join(root, "home.json"), JSON.stringify(info));
  out({ ev: "home-ready", ...info });
  const quit = async () => { link.stop(); await relay.close(); await host.stopAll(); await daemon.stop(); process.exit(0); };
  process.on("SIGTERM", quit); process.on("SIGINT", quit);
  setInterval(() => {}, 1 << 30);
} else if (mode === "server") {
  const homeInfo = JSON.parse(fs.readFileSync(String(opt("home")), "utf8"));
  const devPriv = unb(pair.device.priv), boxPub = unb(pair.box.pub);
  const rp = relayPeer({ deviceSide, url: String(opt("relay")), route: pair.route.id, box: boxPub, keys: { priv: devPriv, pub: unb(pair.device.pub) } });
  const host = createHost({ root: path.join(root, "node"), forwarderBin: String(opt("fwd")), log: m => out({ ev: "log", m }),
    device: { id: pair.deviceId, shared: () => dh(devPriv, boxPub) }, relayPeer: space => rp.open(space) });
  host.addSpace({ id: pair.space, controlUrl: String(opt("control")), authKey: opt("key"), hostname: "proof-server", box: pair.boxId, peerAddr: homeInfo.peerAddr });
  const label = String(opt("label"));
  const n = Number(opt("n") || 200);
  const t0 = performance.now();
  const up = await host.start(pair.space);
  out({ ev: "node-up", label, ms: Math.round(performance.now() - t0), nodeKey: up.nodeKey.slice(0, 16) + "..." });
  const pct = (a, p) => +a.slice().sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(a.length * p))].toFixed(2);
  const link = host.connect(pair.space);
  const c0 = performance.now();
  const TOOL = "appearance.presets"; // a real registry tool that device callers may use; about.text is refused to them (checked below)
  const first = await link.call(TOOL, {}, { timeoutMs: 60_000 });
  out({ ev: "first-call", label, tool: TOOL, ms: Math.round(performance.now() - c0), path: link.status().path, status: link.status(), result: JSON.stringify(first).slice(0, 80) });
  if (label === "direct") {
    // the relay may have carried the first call while the node found its way; wait for the direct path and use only that
    const d0 = performance.now();
    while (link.status().path !== "direct" && performance.now() - d0 < 120_000) await new Promise(r => setTimeout(r, 250));
    out({ ev: "direct-up", ms: Math.round(performance.now() - c0), path: link.status().path });
  }
  const refused = await link.call("about.text", {}).then(() => "ALLOWED", e => `${e.code}: ${e.message}`);
  out({ ev: "kernel-refusal", label, tool: "about.text", result: refused });
  const pings = [];
  for (let i = 0; i < n; i++) pings.push(await link.ping());
  out({ ev: "ping-ms", label, path: link.status().path, n, p50: pct(pings, 0.5), p95: pct(pings, 0.95), max: +Math.max(...pings).toFixed(2) });
  const calls = [];
  for (let i = 0; i < n; i++) { const t = performance.now(); await link.call(TOOL, {}); calls.push(performance.now() - t); }
  out({ ev: "kernel-call-ms", label, path: link.status().path, tool: TOOL, n, p50: pct(calls, 0.5), p95: pct(calls, 0.95), max: +Math.max(...calls).toFixed(2) });
  // fair queueing on the real path: a ping and a small call while an 8 MB result is on the wire
  const bulkBytes = 8 * 1024 * 1024;
  const b0 = performance.now();
  const bulk = link.call("proof.bulk", { bytes: bulkBytes }, { timeoutMs: 120_000 });
  await new Promise(r => setTimeout(r, 30));
  const p0 = performance.now();
  const pingBusy = await link.ping(10_000);
  const small = performance.now();
  await link.call(TOOL, {});
  const smallMs = performance.now() - small;
  const got = await bulk;
  const secs = (performance.now() - b0) / 1000;
  out({ ev: "bulk", label, path: link.status().path, bytes: got.pad.length, mbit_s: +((got.pad.length * 8) / secs / 1e6).toFixed(1), ping_during_bulk_ms: pingBusy, small_call_during_bulk_ms: Math.round(smallMs), waited_ms: Math.round(performance.now() - p0) });
  link.close(); rp.close();
  await host.stopAll();
  process.exit(0);
} else { console.error("usage: net-proof.mjs init|home|server"); process.exit(2); }
