// @ts-check
// A browser with no box joins a person's identity from a phone's long code, over a REAL relay and a real daemon as the phone: relay/client/browserjoin.js joinFromPhone. Both sides show three words, the person
// at the phone picks the matching ones, and the entry that reaches spaces.identity.enrol carries the browser's key, its key-agreement point and held: "web". The short typed code and the avatar are not taken.
import "../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { start } from "../core/daemon/index.js";
import { HUMAN_ONLY } from "../core/presence/index.js";
import { createRelay } from "../relay/node/server.js";
import { nodeCrypto, fileKeyStore } from "../relay/client/nodecrypto.js";
import { joinFromPhone } from "../relay/client/browserjoin.js";
import { tempHome } from "./helpers.js";
import { macCore } from "./fake-core-keys.js";

delete process.env.VYRE_WINK_TYPED_CODE;   // the short typed code stays off
const lenient = {
  required: (tool, def, input) => HUMAN_ONLY.has(tool) || Boolean(def && def.presence && (typeof def.presence.when !== "function" || input === undefined || def.presence.when(input))),
  verify: async ({ proof }) => (proof ? { ok: true, method: "passkey", keyId: proof.key || "k1" } : { ok: false, message: "needs a person", methods: ["passkey"] }),
  challenge: async () => ({ error: { code: "bad_input", message: "no challenges here" } }),
  summary: async () => "", covered: () => false, coverage: () => ({ covered: false, since: null, expires: null }), enrolled: [], enroll(k) { return { id: "kh", kind: k.kind, name: k.name }; },
};
const PROOF = { proof: { method: "passkey", id: "x" } };
const SCREEN = "device:abcdefghijklmnop";
const A = { ...PROOF, peer: { stableId: "nodeA", node: "a" }, person: { id: "ps1" } };
const until = async (f, ms = 10000) => { const t0 = Date.now(); for (;;) { const v = await f(); if (v) return v; if (Date.now() - t0 > ms) throw new Error("timed out"); await new Promise(r => setTimeout(r, 25)); } };
const keystore = t => fileKeyStore(path.join(tempHome(t), "k.json"));

async function phone(t) {
  const relay = createRelay(); const url = await relay.listen(); t.after(() => relay.close());
  const root = tempHome(t);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ role: "box", name: "alex", transcripts: [], network: { name: "alex" }, relay: { enabled: true, url }, modules: { disable: ["names", "onboard"] } }));
  const d = await start({ presence: lenient, root, log: () => {}, coreKeys: macCore() });
  t.after(() => d.stop());
  /** @type {any[]} */ const enrols = [];
  const real = d.registry.call.bind(d.registry);
  d.registry.call = async (tool, input, ...rest) => { if (tool === "spaces.identity.enrol") { enrols.push(input); return { data: { eid: "e_browser" } }; } return real(tool, input, ...rest); };
  const call = (tool, input = {}, caller = SCREEN, meta = A) => d.registry.call(tool, input, caller, meta);
  const status = (await real("relay.status", {}, "cli", PROOF)).data;
  return { d, call, status, enrols };
}
const agreePoint = () => { const j = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" }).publicKey.export({ format: "jwk" }); return Buffer.concat([Buffer.from([4]), Buffer.from(String(j.x), "base64url"), Buffer.from(String(j.y), "base64url")]).toString("base64url"); };
const idKey = () => crypto.generateKeyPairSync("ed25519").publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("base64url");

test("a browser joins from the phone's long code: three words on both sides, the phone's yes, and the entry with its key, agree point and held:web reaches the identity list", async t => {
  const w = await phone(t);
  const open = (await w.call("wink.phone.open", {}, "cli", PROOF)).data;
  assert.ok(open && /^vyre:\/\/wink\/2\?/.test(open.qr), "the phone shows a long code");
  const key = { publicKey: idKey(), agree: agreePoint(), label: "Kit's browser" };
  let shown = "";
  const joining = joinFromPhone({ payload: open.qr, key, name: "Kit's browser", crypto: nodeCrypto(), keyStore: keystore(t), pollMs: 50, onWords: x => { shown = x; } });
  joining.catch(() => {});
  await until(() => shown);
  const q = await until(async () => { const x = (await w.call("wink.phone.pairing")).data; return x && x.asking ? x : null; });
  assert.ok(q.choices.includes(shown), "the phone offers the words the browser shows among its three");
  assert.equal((await w.call("wink.phone.pair.answer", { yes: true, pick: q.choices.indexOf(shown) + 1 })).data.yes, true);
  const r = await joining;
  assert.deepEqual([r.paired, r.enrolled], [true, true]);
  assert.equal(w.enrols.length, 1);
  assert.deepEqual([w.enrols[0].publicKey, w.enrols[0].agree, w.enrols[0].held, w.enrols[0].label], [key.publicKey, key.agree, "web", "Kit's browser"], "the entry carries the key, the agree point and held: web");
});

test("the wrong words are not a yes: the phone's pick of another set adds nothing", async t => {
  const w = await phone(t);
  const open = (await w.call("wink.phone.open", {}, "cli", PROOF)).data;
  let shown = "";
  const joining = joinFromPhone({ payload: open.qr, key: { publicKey: idKey(), agree: agreePoint() }, name: "Kit's browser", crypto: nodeCrypto(), keyStore: keystore(t), pollMs: 50, onWords: x => { shown = x; } });
  const outcome = joining.then(() => null, e => e);
  await until(() => shown);
  const q = await until(async () => { const x = (await w.call("wink.phone.pairing")).data; return x && x.asking ? x : null; });
  const wrong = q.choices.findIndex(c => c !== shown) + 1;
  assert.equal((await w.call("wink.phone.pair.answer", { yes: true, pick: wrong })).data.yes, false);
  const e = /** @type {any} */ (await outcome);
  assert.ok(e && e.code === "denied", `refused: ${e && e.code}`);
  assert.equal(w.enrols.length, 0, "nothing reached the identity list");
});

test("only the phone's long code is taken: the short typed code, an avatar, a server's code and a bare string are refused, and a key with no agree point of the right shape is refused", async t => {
  const base = { crypto: nodeCrypto(), keyStore: keystore(t), name: "Kit's browser" };
  const key = { publicKey: idKey(), agree: agreePoint() };
  const phoneCode = `vyre://wink/2?t=${Buffer.alloc(16, 3).toString("base64url")}&r=ws%3A%2F%2Frelay.test&k=phone`;
  await assert.rejects(joinFromPhone({ ...base, key, code: "WINK-K7QM-4P2X", relay: "ws://relay.test" }), e => e.code === "bad_code");
  await assert.rejects(joinFromPhone({ ...base, key, avatar: [1, 2, 3, 4, 5, 6, 7, 8] }), e => e.code === "bad_code");
  await assert.rejects(joinFromPhone({ ...base, key, payload: phoneCode.replace("k=phone", "k=server") }), e => e.code === "bad_code");
  await assert.rejects(joinFromPhone({ ...base, key, payload: "hello" }), e => e.code === "bad_code");
  for (const agree of [undefined, "", Buffer.alloc(33, 4).toString("base64url"), Buffer.concat([Buffer.from([2]), Buffer.alloc(64, 1)]).toString("base64url")])
    await assert.rejects(joinFromPhone({ ...base, key: { publicKey: key.publicKey, agree: /** @type {any} */ (agree) }, payload: phoneCode }), e => e.code === "bad_key", `agree ${String(agree).slice(0, 8)}`);
});
