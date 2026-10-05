// @ts-check
// The one yes, the standing answers and the revoke, against memory's real IdentityHome behind the memory.identity.* tools (the tools here are thin: the home is the real one).
import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { IdentityHome, FileBackend, newServerKey } from "../../../../core/memory/identity/home.js";
import { newDeviceKey, ecdhFrom, fingerprint } from "../../../../lib/keywrap.js";
import { payloadHash } from "../real/payload-hash.js";
import { signOf } from "../../../../lib/one-yes.js";
import { grantServer, answerAsk, revokeServer, yesRequest, grantLine } from "./grant.js";

function world(/** @type {any} */ t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vyre-grant-")); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const phone = newDeviceKey(), server = { name: "the team server", ...newServerKey() };
  const home = new IdentityHome({ id: "per_alex", backend: new FileBackend(dir) });
  home.create({ devices: [{ publicJwk: phone.publicJwk }], snapshot: { v: 1, tables: {}, state: {} } });
  /** @type {Map<string, any>} */ const asks = new Map();
  let unlocked = false; const seen = { signed: /** @type {any[]} */ ([]) };
  /** The tools as the server answers them, over the real home. */
  const call = async (/** @type {string} */ tool, /** @type {any} */ i = {}) => {
    if (tool === "memory.identity.status") return { id: home.id, space: "spc_host", server: fingerprint(server.publicJwk), server_key: server.publicJwk, granted: home.grants() };
    if (tool === "memory.identity.grant") {
      if (!i.proof || i.proof.signed !== true) throw Object.assign(new Error("denied"), { code: "denied" });
      home.addGrant({ server: server.name, fp: fingerprint(server.publicJwk) }); return { granted: home.grants() };
    }
    if (tool === "memory.identity.unlock.begin") { const { ask, secret } = home.beginUnlock(server); asks.set(ask.request, { ask, secret }); return { ask }; }
    if (tool === "memory.identity.unlock.finish") { const a = asks.get(i.request); if (!a || !home.grants().length) throw Object.assign(new Error("denied"), { code: "denied" }); await home.finishUnlock(a.ask, a.secret, i.answer); unlocked = true; return { unlocked }; }
    if (tool === "memory.identity.revoke") { home.removeGrant(); unlocked = false; return { unlocked }; }
    throw new Error(`no tool ${tool}`);
  };
  const signer = { signPresence: async (/** @type {any} */ req) => { seen.signed.push(req); return { signed: true, payload_hash: req.payload_hash }; } };
  const agree = { holder: fingerprint(phone.publicJwk), ecdh: ecdhFrom(phone.privateJwk) };
  /** @type {Map<string, any>} */ const pinned = new Map();
  const pins = { set: (/** @type {string} */ fp, /** @type {any} */ jwk) => { pinned.set(fp, jwk); }, delete: (/** @type {string} */ fp) => { pinned.delete(fp); } };
  return { home, server, call, signer, agree, pins, pinned, seen, get unlocked() { return unlocked; } };
}

test("grant: one yes signs the vault moment for this identity and server, pins the server's key, and the grant is recorded", async (t) => {
  const w = world(t);
  const r = await grantServer({ call: w.call, signer: w.signer, person: "per_alex", space: "spc_team", name: "Juniper Studio", pins: w.pins });
  assert.equal(r.fp, fingerprint(w.server.publicJwk));
  assert.deepEqual(w.pinned.get(r.fp), { x: w.server.publicJwk.x, y: w.server.publicJwk.y });
  const req = w.seen.signed[0];
  const want = yesRequest({ id: "per_alex", server: r.fp });
  assert.equal(req.op, "task.vault_use");
  assert.deepEqual(req.fields, want.fields);
  assert.equal(req.space, "spc_host", "signed over the Space the server names, not the one the screen showed");
  assert.equal(req.payload_hash, payloadHash(req.op, "spc_host", req.fields), "the hash is over exactly what is shown");
  assert.equal(req.prompt, grantLine("Juniper Studio"));
  assert.equal(w.home.grants().length, 1);
});

test("grant: no signer, a server key that does not match its name, or a refused yes grants and pins nothing", async (t) => {
  const w = world(t);
  await assert.rejects(() => grantServer({ call: w.call, signer: null, person: "p", space: "s", name: "n", pins: w.pins }), { code: "no_signer" });
  const liar = async (/** @type {string} */ tool, /** @type {any} */ i) => (tool === "memory.identity.status" ? { ...(await w.call(tool, i)), server_key: newDeviceKey().publicJwk } : w.call(tool, i));
  await assert.rejects(() => grantServer({ call: liar, signer: w.signer, person: "p", space: "s", name: "n", pins: w.pins }), { code: "bad_key" });
  const refuser = { signPresence: async () => ({ signed: false }) };
  await assert.rejects(() => grantServer({ call: w.call, signer: refuser, person: "p", space: "s", name: "n", pins: w.pins }), { code: "denied" });
  assert.equal(w.pinned.size, 0);
  assert.equal(w.home.grants().length, 0);
});

test("answer: after the yes the phone answers a server's request by itself and the server unlocks; before it, no", async (t) => {
  const w = world(t);
  await assert.rejects(() => answerAsk({ call: w.call, agree: w.agree, granted: w.pinned }), { code: "needs_yes" });
  await grantServer({ call: w.call, signer: w.signer, person: "per_alex", space: "spc_team", name: "n", pins: w.pins });
  const r = await answerAsk({ call: w.call, agree: w.agree, granted: w.pinned });
  assert.equal(r.server.name, "the team server");
  assert.equal(w.unlocked, true);
});

test("revoke: the server locks, the pin goes, and nothing is answered again", async (t) => {
  const w = world(t);
  const { fp } = await grantServer({ call: w.call, signer: w.signer, person: "per_alex", space: "spc_team", name: "n", pins: w.pins });
  await answerAsk({ call: w.call, agree: w.agree, granted: w.pinned });
  await revokeServer({ call: w.call, fp, pins: w.pins });
  assert.equal(w.unlocked, false);
  assert.equal(w.pinned.size, 0);
  assert.equal(w.home.grants().length, 0);
  await assert.rejects(() => answerAsk({ call: w.call, agree: w.agree, granted: w.pinned }), { code: "needs_yes" });
});

test("grant: the request this phone signs is exactly what the server's one-yes verifier expects", () => {
  const status = { id: "per_alex", server: "0123456789abcdef" };
  assert.deepEqual(yesRequest(status), signOf("vault", { op: "memory.identity.unlock", fields: { identity: status.id, server: status.server } }));
});
