// @ts-check
// A raw redeemer for the real-install runs (docs/work/tailnet.md, "Real install", seventh run): scans a server's QR or long code the way the app does,
// then shows what a waiting pairing can reach. It is the probe test/wink.test.js runs in process, here against a real box.
//
//   node scripts/install/redeemer.mjs --payload 'vyre://wink/2?t=...&r=wss://...' [--relay ws://host:port] [--name NAME] [--keys FILE] [--ask] [--hold SECONDS]
//
// Prints one JSON line per step. --ask also does what the app's adopt does (commit, reveal) so the person at the server is asked, and prints the three words this
// side computed and every answer the box gives while it waits. Without --ask it only redeems and probes. Never run on a person's Mac (it makes a device key file).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseServerQr } from "../../core/wink/pairing.js";
import { pairTicket, connect } from "../../relay/client/client.js";
import { nodeCrypto, fileKeyStore } from "../../relay/client/nodecrypto.js";
import { pairWords, nonceCommit, ticketTag, newNonce } from "../../relay/client/pairwords.js";

const arg = (/** @type {string} */ k, /** @type {string} */ d = "") => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const out = (/** @type {string} */ step, /** @type {any} */ v) => console.log(JSON.stringify({ step, ...(v && typeof v === "object" ? v : { v }) }));
const payload = arg("payload");
const scan = parseServerQr(payload);
if (!scan) { console.error("needs --payload vyre://wink/2?t=..."); process.exit(2); }
const relay = arg("relay") || scan.relay;
const name = arg("name", "Probe");
const keyFile = arg("keys") || path.join(fs.mkdtempSync(path.join(os.tmpdir(), "wink-redeemer-")), "key.json");
const ks = fileKeyStore(keyFile);
const ticket = Buffer.from(scan.seed).toString("base64url");

const paired = await pairTicket(scan.seed, { relay, name, crypto: nodeCrypto(), keyStore: ks }).catch((/** @type {any} */ e) => { out("redeem.failed", { error: String(e.message || e) }); process.exit(1); });
out("redeem", { pending: paired.pending === true, device: paired.device, route: paired.route, box: paired.box });
const c = connect({ relay, route: paired.route, box: paired.box, name, crypto: nodeCrypto(), keyStore: ks });
const call = async (/** @type {string} */ tool, /** @type {any} */ input = {}) => {
  try {
    const r = await Promise.race([c.fetch(`/v1/tools/${tool}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) }), new Promise((_, rej) => setTimeout(() => rej(new Error("no answer in 8s")), 8000))]);
    return { status: /** @type {any} */ (r).status, body: await /** @type {any} */ (r).json().catch(() => null) };
  } catch (e) { return { status: 0, body: null, error: String(/** @type {any} */ (e).message) }; }
};

const PROBED = ["relay.devices.list", "wink.access", "relay.status", "system.info", "wink.pair.targets", "threads.list", "term.list", "vault.list", "presence.person.start", "presence.enroll", "relay.devices.remove", "relay.devices.drop", "relay.pair.pending.confirm",
  "relay.pair.ticket", "relay.pair.window.open", "wink.phone.pair.answer", "wink.phone.pairing", "wink.phone.open", "wink.phone.wait", "wink.server.pair.answer", "wink.server.pairing", "wink.server.code", "wink.server.reset", "wink.server.release", "wink.server.retarget", "wink.remove",
  "wink.offer.set", "wink.pair.server", "wink.storage.remove", "wink.device.key", "wink.relay.apply", "about.text", "identity.sign"];
const bad = [];
for (const tool of PROBED) { const o = await call(tool); out("probe", { tool, status: o.status }); if (![404, 403, 0].includes(o.status)) bad.push(`${tool}=${o.status}`); }
for (const [method, p] of [["GET", "/v1/tools"], ["GET", "/v1/events"], ["GET", "/v1/state"], ["POST", "/v1/presence/challenge"], ["GET", "/v1/streams/glass/screen"]]) {
  const r = await Promise.race([c.fetch(p, { method, ...(method === "POST" ? { headers: { "content-type": "application/json" }, body: "{}" } : {}) }), new Promise(res => setTimeout(() => res({ status: 0 }), 5000))]).catch(() => ({ status: 0 }));
  out("probe.path", { method, path: p, status: /** @type {any} */ (r).status });
}
out("probe.summary", { reachable: bad });

if (process.argv.includes("--ask")) {
  const owner = { kind: "identity", id: arg("identity", "per_probe"), name };
  const na = newNonce(), commit = await nonceCommit(na), tag = await ticketTag(ticket);
  const base = { owner, identity: owner.id };
  const first = await call("wink.server.adopt", { ...base, pairing: { commit, tag } });
  out("adopt.commit", { status: first.status, body: first.body });
  const nb = first.body && first.body.data && first.body.data.nb;
  const mine = nb ? await pairWords(String(paired.box), String(paired.device), { ticket, nonceA: na, nonceB: String(nb) }) : "";
  out("words.mine", { words: mine });
  const until = Date.now() + Number(arg("hold", "60")) * 1000;
  let last = "";
  while (Date.now() < until) {
    const r = await call("wink.server.adopt", { ...base, pairing: { commit, tag, reveal: na } });
    const s = JSON.stringify(r.body && (r.body.data || r.body.error) || r);
    if (s !== last) { out("adopt.poll", { status: r.status, body: r.body && (r.body.data || r.body.error), error: r.error }); last = s; }
    if (r.status !== 200 || !(r.body && r.body.data && r.body.data.pending)) break;
    await new Promise(res => setTimeout(res, 1000));
  }
  const after = await call("wink.access");
  out("after", { accessStatus: after.status });
} else {
  await new Promise(res => setTimeout(res, Number(arg("hold", "0")) * 1000));
}
c.close();
process.exit(0);
