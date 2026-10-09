// @ts-check
// PW-1 and PS-1, the registry half: the one strength rule (kernel/seal/strength.js) by method on a RELEASE-kind registry (softwareOk false, the default), and on a development-kind one (softwareOk true).
// A `device` proof (a file key a daemon or browser can use with nobody there) is session-only: refused for every presence-required act with software_key on release, accepted marked software on dev,
// (0.3.1: presence sessions and the terminal window are gone; this verifier now answers only sign-in and a 0.3.0 client's old header). Touch ID, a passkey with user verification and the terminal code keep working.
import "../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import path from "node:path";
import { Presence, inputHash } from "../core/presence/index.js";
import { open } from "../core/store/index.js";
import { Events } from "../kernel/bus.js";
import { tempHome } from "./helpers.js";

/** @param {any} t @param {any} [opts] */
function setup(t, opts = {}) {
  const home = tempHome(t);
  const db = open(path.join(home, "vyre.db"));
  t.after(() => db.close());
  let clock = 1_000_000;
  const events = new Events(db);
  const seen = /** @type {any[]} */ ([]);
  const emit = events.emit.bind(events); events.emit = (/** @type {any} */ ...a) => { seen.push(a); return emit(...a); };
  const written = /** @type {any[]} */ ([]);
  const p = new Presence({ db, events, platform: "darwin", webauthn: null, who: async () => ["ttys003"], statTty: () => ({ uid: typeof process.getuid === "function" ? process.getuid() : 0, isCharacterDevice: () => true }),
    writeTty: (/** @type {string} */ f, /** @type {string} */ x) => { written.push({ f, x }); }, now: () => clock, touchid: { available: async () => true, authenticate: async () => ({ ok: true }) }, ...opts });
  return { p, db, events, written, seen, now: () => clock, tick: (/** @type {number} */ ms) => { clock += ms; } };
}
/** an enrolled P-256 device key and a signer for one call */
function deviceKey(/** @type {any} */ p, /** @type {() => number} */ now) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
  const k = p.enroll({ kind: "device", name: "wink-computer", public_key: publicKey.export({ format: "der", type: "spki" }).toString("base64url"), alg: -7 });
  return (/** @type {string} */ tool, /** @type {any} */ input) => { const ts = String(now()), nonce = crypto.randomBytes(12).toString("base64url");
    return { method: "device", key: k.id, ts, nonce, sig: crypto.sign("sha256", Buffer.from(`vyre-presence-v1\n${tool}\n${inputHash(input)}\n${ts}\n${nonce}`), { key: privateKey, dsaEncoding: "der" }).toString("base64url") }; };
}
const ACTS = [["vault.reveal", { name: "bank" }], ["wink.server.release", { id: "x" }], ["grants.inviteCreate", { role: "member" }], ["spaces.host-here", { name: "n" }]];

test("PW-1 release: a device proof is refused with software_key for vault.reveal, wink.server.release, an invite and spaces.host-here", async t => {
  const { p, now } = setup(t);
  const sign = deviceKey(p, now);
  for (const [tool, input] of ACTS) {
    const r = /** @type {any} */ (await p.verify({ tool: String(tool), input, caller: "capsule", proof: sign(String(tool), input) }));
    assert.equal(r.ok, false, String(tool)); assert.equal(r.code, "software_key", String(tool));
  }
});

test("PW-1 dev: the same proofs are accepted behind the dev switch and marked software", async t => {
  const { p, now, seen } = setup(t, { softwareOk: () => true });
  const sign = deviceKey(p, now);
  for (const [tool, input] of ACTS) {
    const r = /** @type {any} */ (await p.verify({ tool: String(tool), input, caller: "capsule", proof: sign(String(tool), input) }));
    assert.equal(r.ok, true, String(tool)); assert.equal(r.method, "device");
  }
  const proved = seen.filter(a => a[1] === "presence.proved");
  assert.equal(proved.length, ACTS.length); assert.ok(proved.every(a => a[2].method === "device" && a[2].strength === "software"), "every use is marked software in the log");
});

test("PW-1: a packaged (release-kind) registry takes no stand-in, and the terminal code still proves", async t => {
  const { p, written } = setup(t, { platform: "linux", touchid: null });
  const r = /** @type {any} */ (await p.verify({ tool: "vault.reveal", input: { name: "b" }, caller: "cli", proof: { method: "stand-in" } }));
  assert.equal(r.ok, false);
  const r2 = /** @type {any} */ (await p.verify({ tool: "vault.reveal", input: { name: "b" }, caller: "cli", proof: null }));
  assert.equal(r2.ok, false, "no proof at all is not a stand-in either");
  const input = { id: "a1" };
  const c = /** @type {any} */ (await p.challenge({ tool: "gate.approve", input, method: "tty", tty: "/dev/ttys003" }));
  const code = /ran the command: ([A-Z0-9]{6})/.exec(written[written.length - 1].x)?.[1];
  const ok = /** @type {any} */ (await p.verify({ tool: "gate.approve", input, caller: "cli", proof: { method: "tty", id: c.challenge, code } }));
  assert.equal(ok.ok, true);
});

test("PW-1 release: Touch ID proves vault.reveal, wink.server.release, an invite and spaces.host-here (the Mac Capsule's own presence is not a software key)", async t => {
  const { p, seen } = setup(t);
  for (const [tool, input] of ACTS) {
    const r = /** @type {any} */ (await p.verify({ tool: String(tool), input, caller: "capsule", proof: { method: "touchid" } }));
    assert.equal(r.ok, true, `${tool}: ${r.message || ""}`); assert.equal(r.method, "touchid");
  }
  assert.ok(seen.filter(a => a[1] === "presence.proved").every(a => a[2].strength === undefined), "a gesture method is never marked software");
});
