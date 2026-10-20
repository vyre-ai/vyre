// @ts-check
// The registry's `own` presence method (the `session` signer class at the tool level, v0.6.5): the person's own identity key signs the call, checked against the owner's published device keys, taken only while presence is silent.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import path from "node:path";
import { Presence, inputHash, parse } from "./index.js";
import { ownerKeyCheck } from "./own-key.js";
import { open } from "../store/index.js";
import { Events } from "../../kernel/bus.js";
import { tempHome } from "../../test/helpers.js";

const TOOL = { tool: "gate.approve", input: { id: "a1" } };
const ed = () => { const k = crypto.generateKeyPairSync("ed25519"); return { k, pub: k.publicKey.export({ type: "spki", format: "der" }).subarray(-32).toString("base64url") }; };

function setup(t, opts = {}) {
  const db = open(path.join(tempHome(t), "vyre.db")); t.after(() => db.close());
  let clock = 1_000_000;
  const mine = ed();
  // softwareOk false: a release server, where a software device key would be refused
  const p = new Presence({ db, events: new Events(db), platform: "linux", touchid: null, webauthn: null, who: async () => [], now: () => clock, softwareOk: () => false, ownerKey: async pub => pub === mine.pub, silentOk: () => true, ...opts });
  const proof = (tool = TOOL.tool, input = TOOL.input, o = {}) => {
    const ts = String(clock), nonce = crypto.randomBytes(12).toString("base64url");
    const sig = crypto.sign(null, Buffer.from(`vyre-presence-v1\n${tool}\n${inputHash(input)}\n${ts}\n${nonce}`), (o.key || mine.k).privateKey).toString("base64url");
    return { method: "own", pub: o.pub || mine.pub, ts, nonce, sig };
  };
  return { p, mine, proof, tick: ms => { clock += ms; } };
}

test("own: the owner's listed identity key is the person's yes for exactly that tool and input, once, on a release server", async t => {
  const { p, proof } = setup(t);
  const good = proof();
  assert.equal((await p.verify({ ...TOOL, caller: "device:abcdefgh", proof: good })).ok, true);
  assert.equal((await p.verify({ ...TOOL, caller: "device:abcdefgh", proof: good })).ok, false, "a nonce is spent once");
  assert.equal((await p.verify({ tool: "gate.approve", input: { id: "other" }, caller: "device:abcdefgh", proof: proof("gate.approve", { id: "other" }) })).ok, true, "a fresh proof for another input is its own yes");
  assert.equal((await p.verify({ tool: "gate.approve", input: { id: "a2" }, caller: "device:abcdefgh", proof: proof("gate.approve", { id: "a1" }) })).ok, false, "a proof for another input is no yes");
  assert.equal((await p.verify({ tool: "vault.put", input: TOOL.input, caller: "device:abcdefgh", proof: proof() })).ok, false, "or for another tool");
});

test("own: refused for a key that is not the owner's, a bad signature, an old one, a malformed one, and while presence is prompt", async t => {
  const a = setup(t);
  const stranger = ed();
  assert.equal((await a.p.verify({ ...TOOL, caller: "cli", proof: a.proof(TOOL.tool, TOOL.input, { key: stranger.k, pub: stranger.pub }) })).ok, false, "a key the owner's list does not hold");
  const forged = a.proof(); forged.sig = crypto.sign(null, Buffer.from("anything"), stranger.k.privateKey).toString("base64url");
  assert.equal((await a.p.verify({ ...TOOL, caller: "cli", proof: forged })).ok, false, "signed by another key");
  const old = a.proof(); a.tick(10 * 60_000);
  assert.equal((await a.p.verify({ ...TOOL, caller: "cli", proof: old })).ok, false, "too old");
  assert.equal((await a.p.verify({ ...TOOL, caller: "cli", proof: { ...a.proof(), pub: "short" } })).ok, false, "not a key");
  const b = setup(t, { silentOk: () => false });
  const r = await b.p.verify({ ...TOOL, caller: "cli", proof: b.proof() });
  assert.equal(r.ok, false); assert.match(String(r.message), /hardware key/);
  const c = setup(t, { ownerKey: async () => { throw new Error("directory down"); } });
  assert.equal((await c.p.verify({ ...TOOL, caller: "cli", proof: c.proof() })).ok, false, "a directory that cannot be asked is a refusal");
});

test("own: the header parses, and the owner check asks the identity list for a full device key of the owner only", async () => {
  assert.equal(parse("own pub=abc ts=1 nonce=n sig=s").method, "own");
  const asked = [];
  const dir = { resolveById: async id => { asked.push(id); return null; } };
  assert.equal(await ownerKeyCheck({ owner: () => null, directory: () => dir })("x"), false, "no owner, no key");
  assert.equal(await ownerKeyCheck({ owner: () => "per_" + "a".repeat(26), directory: () => dir })("x"), false, "a list that does not hold it");
  assert.deepEqual(asked.length, 1);
});
