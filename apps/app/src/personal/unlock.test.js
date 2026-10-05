// @ts-check
// The phone answers a REAL server request: memory's IdentityHome mints it (beginUnlock, signed with the server's own key), this phone answers with its agree key, and the home opens with the answer.
import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { IdentityHome, FileBackend, newServerKey, signAsk } from "../../../../core/memory/identity/home.js";
import { newDeviceKey, ecdhFrom, fingerprint } from "../../../../lib/keywrap.js";
import { answerUnlock, askSignedBy } from "./unlock.js";

function world(/** @type {any} */ t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vyre-unlock-")); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const phone = newDeviceKey(), server = { name: "the team server", ...newServerKey() };
  const home = new IdentityHome({ id: "per_alex", backend: new FileBackend(dir) });
  home.create({ devices: [{ label: "phone", publicJwk: phone.publicJwk }], snapshot: { v: 1, tables: { memory_me_facts: [{ id: 1, text: "likes tea" }] }, state: {} } });
  const agree = { holder: fingerprint(phone.publicJwk), ecdh: ecdhFrom(phone.privateJwk) };
  const granted = new Map([[fingerprint(server.publicJwk), server.publicJwk]]);
  return { home, phone, server, agree, granted };
}

test("unlock: a signed request from a granted server is answered, and the home opens with the answer", async (t) => {
  const w = world(t);
  const { ask, secret } = w.home.beginUnlock(w.server);
  assert.ok(askSignedBy(ask, w.server.publicJwk), "the signature node made checks with noble");
  const answer = await answerUnlock(ask, w.agree, w.granted);
  const lease = await w.home.finishUnlock(ask, secret, answer);
  assert.ok(lease.open, "the server holds the key");
  assert.deepEqual(w.home.load(lease).tables.memory_me_facts, [{ id: 1, text: "likes tea" }]);
});

test("unlock: a server the person did not say yes to, a forged signature and a device with no wrap are refused", async (t) => {
  const w = world(t);
  const { ask } = w.home.beginUnlock(w.server);
  await assert.rejects(() => answerUnlock(ask, w.agree, new Map()), { code: "needs_yes" });
  const impostor = { name: "the team server", ...newServerKey() };
  const forged = { ...ask, sig: signAsk(ask, impostor.privateJwk) };
  await assert.rejects(() => answerUnlock(forged, w.agree, w.granted), { code: "bad_signature" });
  const tampered = { ...ask, request: "other" };
  await assert.rejects(() => answerUnlock(tampered, w.agree, w.granted), { code: "bad_signature" });
  const stranger = newDeviceKey();
  await assert.rejects(() => answerUnlock(ask, { holder: fingerprint(stranger.publicJwk), ecdh: ecdhFrom(stranger.privateJwk) }, w.granted), { code: "unknown_key" });
});

test("unlock: an answer is for one request; another request's secret does not open it", async (t) => {
  const w = world(t);
  const one = w.home.beginUnlock(w.server), two = w.home.beginUnlock(w.server);
  const answer = await answerUnlock(one.ask, w.agree, w.granted);
  await assert.rejects(() => w.home.finishUnlock(two.ask, two.secret, answer), { code: "cannot_open" });
});

test("unlock: the signature holds when the request's fields arrive in another order", async (t) => {
  const w = world(t);
  const { ask } = w.home.beginUnlock(w.server);
  const shuffled = { sig: ask.sig, server: ask.server, rev: ask.rev, wraps: ask.wraps, sessionPub: { y: ask.sessionPub.y, x: ask.sessionPub.x, crv: ask.sessionPub.crv, kty: ask.sessionPub.kty }, request: ask.request, home: ask.home, id: ask.id };
  assert.ok(askSignedBy(shuffled, w.server.publicJwk));
});
