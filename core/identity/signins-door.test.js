// @ts-check
// The new-device sign-in card for a TEAM MEMBER, through the member door on a real vyred. A member has no session of their own on the team's server, so the three sign-in tools must be door rows (core/work/member-tools.js):
// a member signs in on a new device (the real sign-in service, real sessions), their other device asks the door and sees the card, "Not me" ends that device and "It was me" closes the card, and the person is always the door's
// authenticated chain: a member never reaches another member's devices, a name in the input changes nothing, and a stranger is told nothing. Run it on a test box, never on a person's Mac.
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { start } from "../daemon/index.js";
import { tempHome } from "../../test/helpers.js";
import { createMemberTools } from "../work/member-tools.js";
import { setLoginService } from "../../lib/login-door.js";
import { TEST_KDF } from "../../kernel/identity/master.js";
import { aesWrap } from "../../kernel/identity/wrap.js";
import { bundleHash, createLoginService, deriveLogin, loginMessage, registerMessage } from "../../kernel/identity/space-login.js";

process.env.VYRE_KERNEL ??= "1"; process.env.VYRE_KERNEL_PATH_RULE ??= "1"; process.env.VYRE_SEAL_DEV ??= "1";
const ANA = "per_" + "bcdefghijklmnopqrstuvwxyza", BEN = "per_" + "cdefghijklmnopqrstuvwxyzab", ZED = "per_" + "defghijklmnopqrstuvwxyzabc";
const PASSWORD = "correct horse battery";
const proof = () => ({ op: "stand-in", fields: {}, n: Math.random() });
const keyPair = () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  return { pub: Buffer.from(publicKey.export({ format: "der", type: "spki" }).subarray(-32)).toString("base64url"), sign: (/** @type {Buffer} */ m) => crypto.sign(null, m, privateKey).toString("base64url") };
};

test("a team member's new-device card works through the member door: the other device sees it, Not me signs the device out, It was me closes it, and it is only ever their own", { timeout: 120_000 }, async (t) => {
  const root = tempHome(t);
  const d = await start({ root, log: () => {}, kernel: true, kernelPresence: { check: async () => null } });
  t.after(() => { setLoginService(null); return d.stop(); });
  const OWNER = d.kernel.id.owner, SPACE = d.kernel.id.space;
  const oc = d.kernel.chains.fromFacts({ kind: "device", device_key_id: "d-owner", person: OWNER, path: "direct", session: "s" });
  for (const person of [ANA, BEN]) await d.kernel.gateway.grants.setRole(oc, { person, role: "member" }, { presence: proof() });

  // the real sign-in service, ringing the real event bus the identity module listens on
  const keys = { ana: keyPair(), ben: keyPair() }, people = { ana: ANA, ben: BEN };
  const store = new Map();
  const svc = createLoginService({
    space: SPACE, store: { get: (k) => store.get(k), set: (k, v) => { store.set(k, v); }, keys: () => [...store.keys()] },
    verifyIdentity: async (person, pub) => Object.entries(people).some(([n, p]) => p === person && /** @type {any} */ (keys)[n].pub === pub), isMember: async () => true,
    onNewDevice: (e) => d.events.emit("identity", "signin.new-device", { device: e.device, at: e.at }),
  });
  setLoginService(svc);
  for (const name of ["ana", "ben"]) {
    const salt = crypto.randomBytes(16).toString("base64url"), login = deriveLogin(PASSWORD, salt, TEST_KDF), bundle = { v: 1, username: name, id: /** @type {any} */ (people)[name], passwordWrap: aesWrap(login.K, crypto.randomBytes(32), "vyre:master:password:v1") };
    const ts = Date.now(), k = /** @type {any} */ (keys)[name];
    await svc.register({ username: name, person: /** @type {any} */ (people)[name], pub: k.pub, ts, sig: k.sign(registerMessage(SPACE, name, login.loginPub, bundleHash(bundle), ts)), salt, loginPub: login.loginPub, bundle });
  }
  let n = 0;
  const signIn = async (/** @type {string} */ name, /** @type {string} */ id, /** @type {string} */ label) => {
    const address = `203.0.113.${(++n % 200) + 1}`, b = svc.begin({ username: name }, address), dk = deriveLogin(PASSWORD, b.salt, TEST_KDF);
    const r = await svc.finish({ username: name, challenge: b.challenge, sig: dk.sign(loginMessage(SPACE, name, b.challenge)), device: { id, label } }, address);
    assert.equal(r.ok, true, JSON.stringify(r.error));
  };

  const door = createMemberTools({ space: SPACE, kernel: d.kernel, registry: d.registry }).identity;
  assert.deepEqual(Object.keys(door).sort(), ["ack", "revoke", "signins"], "the member door carries the three sign-in calls");
  const chain = (/** @type {string} */ person, /** @type {string} */ dev = "d1") => d.kernel.chains.fromFacts({ kind: "device", device_key_id: `${dev}-${person.slice(4, 10)}`, person, path: "relay" });
  const cards = async (/** @type {string} */ person, /** @type {any} */ input = {}) => (await door.signins(chain(person, "other"), input)).devices.map((/** @type {any} */ x) => x.device);
  const OLD = "browser-aaaaaaaa", NEW = "browser-bbbbbbbb";

  // Ana's usual browser signs in and she says it was her; then a new device signs in as Ana
  await signIn("ana", OLD, "Ana's usual browser");
  assert.deepEqual(await cards(ANA), [OLD], "the first sign-in rang the notice");
  assert.deepEqual(await door.ack(chain(ANA), { device: OLD }), { acknowledged: true });
  assert.deepEqual(await cards(ANA), [], "it was her: nothing waits");
  await signIn("ana", NEW, "A phone in a cafe");
  assert.deepEqual(await cards(ANA), [NEW], "her other device sees the new device's card, through the door");
  assert.equal((await door.signins(chain(ANA, "other"), {})).devices[0].label, "A phone in a cafe");

  // it is only ever hers: another member sees none of it, a person named in the input changes nothing, and neither can sign her device out
  assert.deepEqual(await cards(BEN), [], "Ben sees none of Ana's devices");
  assert.deepEqual(await cards(BEN, { person: ANA }), [], "a person named in the input is not the caller");
  const nope = await door.revoke(chain(BEN), { device: NEW, person: ANA });
  assert.equal(nope.revoked, false, "Ben cannot sign Ana's device out");
  assert.deepEqual(await cards(ANA), [NEW], "and her card is still there");
  assert.equal(svc.sessionsOfPerson(ANA).some((/** @type {any} */ s) => s.device === NEW), true, "her session is still live");

  // Not me: the device is signed out for real, the card goes, and its next sign-in is a new device again
  const r = await door.revoke(chain(ANA, "other"), { device: NEW });
  assert.equal(r.revoked, true);
  assert.equal(svc.sessionsOfPerson(ANA).some((/** @type {any} */ s) => s.device === NEW), false, "the new device's session ended");
  assert.deepEqual(await cards(ANA), [], "the card closes");
  assert.equal((await door.revoke(chain(ANA), { device: NEW })).revoked, false, "a second Not me says it was already signed out");
  await signIn("ana", NEW, "A phone in a cafe");
  assert.deepEqual(await cards(ANA), [NEW], "its next sign-in rings again");

  // a bad device id is refused, and a person who is not a member is told nothing
  await assert.rejects(door.revoke(chain(ANA), { device: "x" }), /device id/);
  await assert.rejects(door.signins(chain(ZED), {}), /not found/);
  await assert.rejects(door.revoke(chain(ZED), { device: NEW }), /not found/);
});
