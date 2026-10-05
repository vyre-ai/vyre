// relay-soak-vyred.mjs: the same question as relay-soak.mjs, asked of a REAL vyred (testbox only, never the Mac).
//
//   node scripts/relay-soak-vyred.mjs [--minutes 25] [--grace-ms 0]
//
// A real vyred (relay and wink modules on, 127.0.0.1) and the Node relay with the typed-code grace OFF. Every `relay.connected` and `relay.disconnected` event is logged with the time and the reason, so a
// flap shows itself. At the start, every 5 minutes and at the end a code is opened on the box (wink.code.open) and typed by a device (the real client, relay/client/join.js typeWinkCode): the first half
// of the join, which is exactly what answers "That is not a Vyre code" when the relay no longer holds the box's code. Prints one JSON line per event and PASS/FAIL.
import "./mac-test-guard.mjs";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { start } from "../core/daemon/index.js";
import { HUMAN_ONLY } from "../core/presence/index.js";
import { createRelay } from "../relay/node/server.js";
import { typeWinkCode } from "../relay/client/join.js";
import { macCore } from "../test/fake-core-keys.js";

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : d; };
const MINUTES = Number(arg("minutes", 25));
const GRACE = Number(arg("grace-ms", 0));
const out = (ev, o = {}) => console.log(JSON.stringify({ t: new Date().toISOString(), ev, ...o }));
const sleep = ms => new Promise(r => setTimeout(r, ms));

const lenient = {
  required: (tool, def, input) => HUMAN_ONLY.has(tool) || Boolean(def && def.presence && (typeof def.presence.when !== "function" || input === undefined || def.presence.when(input))),
  verify: async ({ proof }) => (proof ? { ok: true, method: "passkey", keyId: "k1" } : { ok: false, message: "needs a person", methods: ["passkey"] }),
  challenge: async () => ({ error: { code: "bad_input", message: "no challenges here" } }), summary: async () => "", covered: () => false, coverage: () => ({ covered: false, since: null, expires: null }),
  enrolled: [], enroll(k) { this.enrolled.push(k); return { id: `kh${this.enrolled.length}`, kind: k.kind, name: k.name }; },
};
const PROOF = { proof: { method: "passkey", id: "x" } };
const SCREEN = "device:abcdefghijklmnop";
const A = { ...PROOF, peer: { stableId: "nodeA", node: "a" }, person: { id: "ps1" } };

const relay = createRelay({ code: { graceMs: GRACE } });
const url = await relay.listen();
out("relay", { url, graceMs: GRACE });
const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-soak-"));
fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ role: "box", name: "soak", transcripts: [], network: { name: "soak" }, relay: { enabled: true, url }, modules: { disable: ["names", "onboard"] } }));
const d = await start({ presence: lenient, root, log: m => { if (/relay/i.test(String(m))) out("log", { m: String(m).slice(0, 200) }); }, coreKeys: macCore() });
let since = Date.now(), drops = 0, ups = 0;
d.events.on("*", e => {
  if (e.type === "relay.connected") { ups++; since = Date.now(); out("link", { state: "connected" }); }
  if (e.type === "relay.disconnected") { drops++; out("link", { state: "disconnected", why: e.payload && e.payload.why, upForMs: Date.now() - since }); }
});
const call = (tool, input = {}) => d.registry.call(tool, input, SCREEN, A);
const status = (await d.registry.call("relay.status", {}, "cli", PROOF)).data;
out("boxup", { connected: status.connected });

let tries = 0, ok = 0;
async function redeem(label) {
  tries++;
  const open = await call("wink.code.open", { flow: "W2" });
  if (!open.data || !open.data.code) { out("redeem", { label, ok: false, why: `no code: ${JSON.stringify(open.error || {}).slice(0, 160)}` }); return; }
  const r = await typeWinkCode({ relay: status.url, input: open.data.code });
  if (r.ok) ok++;
  out("redeem", { label, ok: r.ok, reason: r.ok ? undefined : r.reason, upForMs: Date.now() - since, linkUp: (await d.registry.call("relay.status", {}, "cli", PROOF)).data.connected });
  await call("wink.cancel", { offer: open.data.offer }).catch(() => {});
}

await redeem("start");
const t0 = Date.now(), end = t0 + MINUTES * 60_000;
let next = t0 + 5 * 60_000;
while (Date.now() < end) {
  await sleep(Math.min(5000, end - Date.now()));
  if (Date.now() >= next && Date.now() < end) { await redeem(`t+${Math.round((Date.now() - t0) / 60_000)}min`); next += 5 * 60_000; }
}
await redeem(`end after ${MINUTES}min`);
const good = drops === 0 && ok === tries;
out(good ? "PASS" : "FAIL", { minutes: MINUTES, redeems: tries, answered: ok, drops, reconnects: Math.max(0, ups - 1) });
await d.stop();
await relay.close();
process.exit(good ? 0 : 1);
