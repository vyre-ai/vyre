// @ts-check
// The test switch VYRE_TEST_UNGATED_RING makes a ring ticket (relay.pair.ticket) pair in one step, with nobody confirming. It is only a test switch: a release build, or one carrying a release signature,
// must keep the ring gated whatever the environment says (kernel/devbuild.js devSwitch). kernel/devbuild.test.js proves devSwitch itself; this proves the RELAY uses it, on a real vyred and relay with the
// switch set to "1": a development build pairs the redeemer in one step (the control, so the test can tell the switch from a broken harness), and a packaged build makes the redeemer a waiting pairing with
// no device row and no device.paired event.
import "../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { start } from "../core/daemon/index.js";
import { seams } from "../core/relay/index.js";
import { HUMAN_ONLY } from "../core/presence/index.js";
import { createRelay } from "../relay/node/server.js";
import { pairTicket } from "../relay/client/client.js";
import { nodeCrypto, fileKeyStore } from "../relay/client/nodecrypto.js";
import { fromBase64url } from "../relay/client/bytes.js";
import { tempHome } from "./helpers.js";
import { macCore } from "./fake-core-keys.js";

process.env.VYRE_TEST_UNGATED_RING = "1";

/** Takes any presence proof: this test is about the ring gate, not about who may call. */
const lenient = {
  required: (/** @type {string} */ tool, /** @type {any} */ def, /** @type {any} */ input) => HUMAN_ONLY.has(tool) || Boolean(def && def.presence && (typeof def.presence.when !== "function" || input === undefined || def.presence.when(input))),
  verify: async (/** @type {any} */ { proof }) => (proof ? { ok: true, method: "passkey", keyId: proof.key || "k1" } : { ok: false, message: "needs a person", methods: ["passkey"] }),
  challenge: async () => ({ error: { code: "bad_input", message: "no challenges here" } }),
  summary: async () => "",
  covered: () => false,
  coverage: () => ({ covered: false, since: null, expires: null }),
  enrolled: /** @type {any[]} */ ([]),
  enroll(/** @type {any} */ k) { this.enrolled.push(k); return { id: `kh${this.enrolled.length}`, kind: k.kind, name: k.name }; },
};
const PROOF = { proof: { method: "passkey", id: "x" } };

/** A fixture package folder of a kind, as kernel/devbuild.test.js makes them. @param {string} stamp @param {boolean} [signed] */
function packageRoot(stamp, signed = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ring-switch-"));
  fs.mkdirSync(path.join(root, "lib"));
  fs.writeFileSync(path.join(root, "lib", "build-kind.js"), `export const BUILD_KIND = "${stamp}";\n`);
  if (signed) fs.writeFileSync(path.join(root, "SHA256SUMS.sig"), "x");
  return root;
}

/** @param {import("node:test").TestContext} t @param {string} buildRoot */
async function world(t, buildRoot) {
  const relay = createRelay();
  const url = await relay.listen();
  t.after(() => relay.close());
  t.after(() => fs.rmSync(buildRoot, { recursive: true, force: true }));
  const root = tempHome(t);
  seams.set(root, { buildRoot, pendingMs: 3000 });
  t.after(() => seams.delete(root));
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ role: "box", name: "alex", transcripts: [], network: { name: "alex" }, relay: { enabled: true, url }, modules: { disable: ["names", "onboard"] } }));
  const d = await start({ presence: lenient, root, log: () => {}, coreKeys: macCore(), kernelPresence: { check: async () => null } });
  t.after(() => d.stop());
  /** @type {any[]} */ const events = [];
  d.events.on("*", (/** @type {any} */ e) => events.push([e.type, e.payload]));
  const status = (await d.registry.call("relay.status", {}, "cli", PROOF)).data;
  return { d, events, status };
}

/** Mint a ring ticket and redeem it as a phone would. */
async function redeemRing(/** @type {import("node:test").TestContext} */ t, /** @type {any} */ w) {
  const minted = await w.d.registry.call("relay.pair.ticket", {}, "cli", PROOF);
  assert.ok(minted.data && minted.data.ticket, JSON.stringify(minted.error));
  const presenceKey = { public_key: crypto.generateKeyPairSync("ec", { namedCurve: "P-256" }).publicKey.export({ format: "der", type: "spki" }).toString("base64url"), alg: -7 };
  const ks = fileKeyStore(path.join(tempHome(t), "k.json"));
  return pairTicket(fromBase64url(minted.data.ticket), { relay: w.status.url, name: "A ring redeemer", crypto: nodeCrypto(), keyStore: ks, presenceKey });
}
const listed = async (/** @type {any} */ w, /** @type {string} */ id) => ((await w.d.registry.call("relay.devices.list", {}, "cli", PROOF)).data.devices || []).some((/** @type {any} */ x) => x.id === id);

test("with VYRE_TEST_UNGATED_RING=1 a development build pairs a ring redeemer in one step (the control for the cases below)", { timeout: 120_000 }, async t => {
  const w = await world(t, packageRoot("development"));
  const paired = await redeemRing(t, w);
  assert.ok(paired.device && !paired.pending, JSON.stringify(paired));
  assert.equal(await listed(w, paired.device), true, "the redeemer is a device row at once");
});

for (const [what, stamp, signed] of /** @type {[string, string, boolean][]} */ ([
  ["a release build", "release", false],
  ["a development tree that carries a release signature", "development", true],
])) {
  test(`with VYRE_TEST_UNGATED_RING=1 ${what} keeps the ring gated: the redeemer is a waiting pairing, with no device row and no device.paired`, { timeout: 120_000 }, async t => {
    const w = await world(t, packageRoot(stamp, signed));
    const enrolled = lenient.enrolled.length;
    const paired = await redeemRing(t, w);
    assert.equal(paired.pending, true, `the switch must not open the gate in ${what}: ${JSON.stringify(paired)}`);
    assert.equal(await listed(w, paired.device), false, "no relay device row");
    assert.equal(w.events.some((/** @type {any} */ e) => e[0] === "device.paired"), false, "no device.paired event");
    assert.equal(lenient.enrolled.length, enrolled, "no presence key was enrolled for it");
  });
}
