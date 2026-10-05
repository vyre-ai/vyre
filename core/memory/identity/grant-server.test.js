// @ts-check
// An unlock ask is signed over sorted-key canonical JSON (the order a field arrives in never decides validity), and a standing grant finishes only the ask of the server it was given to:
// a grant for server A never finishes an ask from server B.
import "../../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { MIGRATIONS } from "../schema.js";
import { tempHome } from "../../../test/helpers.js";
import { newDeviceKey } from "../../../lib/keywrap.js";
import { FileBackend, IdentityHome, Phone, newServerKey, askSignedBy } from "./home.js";
import { IdentityLive } from "./live.js";

const live = (root, name, serverKey, now) => {
  const db = new DatabaseSync(":memory:"); for (const m of MIGRATIONS) db.exec(m);
  return new IdentityLive({ db, id: "ident_alex", backend: new FileBackend(path.join(root, "home")), serverKey, serverName: name, now, autosaveMs: 3_600_000 });
};

test("the ask's signature does not depend on field order, and a grant for A cannot finish an ask from B", async t => {
  const root = tempHome(t);
  const now = () => 1_000_000;
  const phoneKey = newDeviceKey(), A = newServerKey(), B = newServerKey();
  new IdentityHome({ id: "ident_alex", backend: new FileBackend(path.join(root, "home")), now }).create({ devices: [{ label: "phone", publicJwk: phoneKey.publicJwk }], snapshot: { v: 1, tables: {}, state: {} } }).lock();
  const a = live(root, "server-a", A, now), b = live(root, "server-b", B, now);
  // the person grants server A only (the grant is recorded in the home's manifest, which both servers read)
  a.grant();
  // key order never decides validity: the same ask with its keys reversed still verifies
  const askA = a.begin().ask;
  const reversed = Object.fromEntries(Object.entries(askA).reverse());
  reversed.sessionPub = Object.fromEntries(Object.entries(askA.sessionPub).reverse());
  assert.ok(askSignedBy(askA, A.publicJwk));
  assert.ok(askSignedBy(reversed, A.publicJwk), "a reordered ask verifies");
  assert.ok(!askSignedBy(askA, B.publicJwk), "another server's key does not");
  // the phone answers A's ask; A finishes
  const phone = new Phone(phoneKey); phone.grant(A.publicJwk);
  assert.equal((await a.finish(askA.request, await phone.answer(askA))).unlocked, true);
  a.lock();
  // server B asks: the phone has not granted B, but even a phone that answers it (a bug or an attack) cannot finish it, because the standing grant is A's
  const askB = b.begin().ask;
  const phoneAll = new Phone(phoneKey); phoneAll.grant(B.publicJwk);
  const answerB = await phoneAll.answer(askB);
  await assert.rejects(() => b.finish(askB.request, answerB), { code: "denied" });
  assert.equal(b.unlocked, false);
  // once B is granted too, its own ask finishes
  b.grant();
  const askB2 = b.begin().ask;
  assert.equal((await b.finish(askB2.request, await phoneAll.answer(askB2))).unlocked, true);
});
