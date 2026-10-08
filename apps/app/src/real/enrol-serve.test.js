// @ts-check
// The computer app serving a phone's enrolment (src/real/enrol-serve.js, wired by enrol-phone.ts): when the server says a phone waits to be added, THIS app signs the list change with the name's key,
// the directory list then holds the phone, and the server is told. The signing is the real enrolDevice and the real chain; only the directory is a small stand-in.
import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import * as C from "../../../../kernel/identity/chain.js";
import { enrolDevice } from "../identity/enrol-device.js";
import { serveEnrolWith } from "./enrol-serve.js";

const raw = pub => pub.export({ format: "der", type: "spki" }).subarray(-32);
const sigOf = key => async m => crypto.sign(null, Buffer.from(m), key);

/** A name with one device key and one recovery code, and a directory stand-in that holds its list. */
async function owner() {
  const dev = crypto.generateKeyPairSync("ed25519"), code = crypto.generateKeyPairSync("ed25519");
  const devPub = C.b64u(raw(dev.publicKey)), codePub = C.b64u(raw(code.publicKey));
  const eid = await C.eidOf(devPub);
  const ts = Date.now() - 3 * 86_400_000;
  const genesis = await C.makeGenesis({ kind: "person", entry: { eid, kind: "device", pub: devPub }, code: { eid: await C.eidOf(codePub), kind: "code", pub: codePub }, nonce: "n".repeat(16), ts, sign: sigOf(dev.privateKey) });
  const state = await C.verifyChain([genesis], { now: ts + 1 });
  /** @type {any[]} */ const list = [genesis];
  const fetch = async (url, init) => {
    const u = new URL(url);
    if (u.pathname === "/v1/ids/resolve") return new Response(JSON.stringify({ data: { name: "alex", id: state.id, kind: "person", ops: list } }), { status: 200 });
    if (u.pathname === "/v1/ids/append") { list.push(...JSON.parse(init.body).ops); return new Response(JSON.stringify({ data: { ok: true } }), { status: 200 }); }
    return new Response("{}", { status: 404 });
  };
  const mine = { name: "alex", id: state.id, eid, ops: [genesis], pin: C.pinOf(state), key: { sign: sigOf(dev.privateKey) } };
  return { mine, list, fetch };
}

const phoneKey = () => C.b64u(raw(crypto.generateKeyPairSync("ed25519").publicKey));

function deps(o, extra = {}) {
  const calls = [];
  const saved = [];
  const ask = { enrol: { device: "dev1", name: "Sam's phone", entry: { publicKey: o.phone, label: "Sam's phone" }, until: Date.now() + 1e5 } };
  return { calls, saved, d: {
    call: async (tool, input) => { calls.push([tool, input]); return tool === "wink.phone.pairing" ? ask : { ok: true }; },
    identity: async () => o.mine, held: async () => false, signers: async mine => ({ sign: mine.key.sign }),
    enrol: x => enrolDevice({ ...x, fetch: o.fetch }), save: async i => { saved.push(i); }, base: "http://dir.test", ...extra } };
}

test("a phone is waiting: this app signs the list change, the directory list holds the phone's key, the longer chain is kept, and the server is told", async () => {
  const o = await owner(); o.phone = phoneKey();
  const { calls, saved, d } = deps(o);
  assert.equal(await serveEnrolWith(d), true);
  const state = await C.verifyChain(o.list, { now: Date.now() + C.SKEW_MS });
  assert.ok(state.entries.some(e => e.pub === o.phone), "the phone's key is on the list the directory holds");
  assert.equal(o.list.at(-1).by, o.mine.eid, "signed by this app's key");
  assert.equal(saved.length, 1);
  assert.equal(saved[0].ops.length, 2, "the longer chain is kept");
  assert.equal(saved[0].pin.seq, 1);
  const told = calls.find(c => c[0] === "wink.phone.enrolled")[1];
  assert.deepEqual(told, { device: "dev1", ok: true, identity: { id: o.mine.id, vyre: "alex" } });
});

test("nothing waiting: nothing is signed and nothing is said; a request already being served is not served twice", async () => {
  const o = await owner(); o.phone = phoneKey();
  const calls = [];
  assert.equal(await serveEnrolWith({ ...deps(o).d, call: async t => { calls.push(t); return { asking: false }; } }), false);
  assert.deepEqual(calls, ["wink.phone.pairing"]);
  assert.equal(o.list.length, 1);
  let release; const gate = new Promise(r => { release = r; });
  const { d, calls: c2 } = deps(o, { signers: async mine => { await gate; return { sign: mine.key.sign }; } });
  const first = serveEnrolWith(d);
  assert.equal(await serveEnrolWith(d), false, "the same device is already in hand");
  release();
  assert.equal(await first, true);
  assert.equal(c2.filter(c => c[0] === "wink.phone.enrolled").length, 1);
});

test("this app cannot sign (a held key, no name here, the directory refuses): the phone is told why, in words, and nothing is kept", async () => {
  const o = await owner(); o.phone = phoneKey();
  const cases = [
    [{ held: async () => true }, /cannot add a device to your name\. Add it from your phone/],
    [{ identity: async () => null }, /does not hold your Vyre name/],
    [{ enrol: async () => { throw new Error("Cannot reach the names directory right now."); } }, /Cannot reach the names directory/],
  ];
  for (const [extra, say] of cases) {
    const { calls, saved, d } = deps(o, extra);
    assert.equal(await serveEnrolWith(d), true);
    const told = calls.find(c => c[0] === "wink.phone.enrolled")[1];
    assert.equal(told.ok, false);
    assert.match(told.reason, say);
    assert.equal(saved.length, 0);
  }
  assert.equal(o.list.length, 1, "the list was never changed");
});

test("the wiring: the card on Now and the Devices screen both ask for the request, and enrol-phone hands the real signers to the same function", () => {
  const read = p => fs.readFileSync(new URL(p, import.meta.url), "utf8");
  const cards = read("../../screens/pairing/PairingCards.tsx"), source = read("../../screens/pairing/source.ts"), add = read("../../screens/devices/RealAdd.tsx"), phone = read("./enrol-phone.ts");
  assert.match(cards, /void source\.serveEnrol\(\)/, "the card on Now asks on mount and on every wink event (load)");
  assert.match(source, /serveEnrol: async \(\) => \{[^}]*import\("\.\.\/\.\.\/src\/real\/enrol-phone"\)/);
  assert.match(add, /setInterval\(run, 2000\)/);
  assert.match(add, /import\("\.\.\/\.\.\/src\/real\/enrol-phone"\)\.then\(\(m\) => m\.serveEnrol\(\)\)/);
  assert.match(phone, /serveEnrolWith\(\{/);
  assert.match(phone, /enrol: enrolDevice/);
  assert.match(phone, /listChangeSigners\("Add a device to your Vyre name"\)/);
});
