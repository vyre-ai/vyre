// @ts-check
import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";

const strip = Boolean(/** @type {any} */ (process.features).typescript);
const LONG = "vyre://wink/2?t=SGVsbG9TYW1wbGVTZWNyZQ&r=wss%3A%2F%2Frelay.example";

test("a long code is read, for a server or a phone", { skip: !strip }, async () => {
  const { parseWinkCode } = await import("./wink-code.ts");
  assert.deepEqual(parseWinkCode(`  ${LONG}\n`), { ok: true, kind: "ticket", ticket: "SGVsbG9TYW1wbGVTZWNyZQ", relay: "wss://relay.example", for: "server" });
  const p = parseWinkCode(`${LONG}&k=phone`);
  assert.ok(p.ok && p.kind === "ticket" && p.for === "phone");
  const offer = "https://vyre.run/pair#eyJhIjoxfQ";
  assert.deepEqual(parseWinkCode(offer), { ok: true, kind: "offer", offer });
});

test("a short typed code is refused in plain words", { skip: !strip }, async () => {
  const { parseWinkCode, SAY } = await import("./wink-code.ts");
  for (const t of ["WINK-7K4Q-M2XD", "wink7k4qm2xd", "vyre://wink/1?c=WINK-7K4Q-M2XD"]) {
    const r = parseWinkCode(t);
    assert.equal(r.ok, false);
    assert.equal(!r.ok && r.reason, "typed");
    assert.equal(!r.ok && r.say, SAY.typed);
  }
  assert.match(SAY.typed, /switched off in this release/);
});

test("nothing, a short secret and plain text are refused", { skip: !strip }, async () => {
  const { parseWinkCode } = await import("./wink-code.ts");
  assert.equal(parseWinkCode("   ").ok, false);
  assert.equal(parseWinkCode(null).ok, false);
  assert.equal(!parseWinkCode("vyre://wink/2?t=short").ok, true);
  const r = parseWinkCode("hello");
  assert.ok(!r.ok && r.reason === "not_a_code");
});

test("a scan reads a long code, and each code only once", { skip: !strip }, async () => {
  const { readCode, onceEach } = await import("./../native/scan-model.ts");
  assert.deepEqual(readCode(LONG), { kind: "wink", ticket: "SGVsbG9TYW1wbGVTZWNyZQ", relay: "wss://relay.example", for: "server" });
  assert.equal(readCode("WINK-7K4Q-M2XD")?.kind, "other");
  const seen = [];
  let t = 0;
  const once = onceEach((c) => seen.push(c), 1500, () => t);
  once(LONG); once(LONG); t = 100; once(LONG);
  assert.equal(seen.length, 1);
  t = 5000; once(LONG);
  assert.equal(seen.length, 2);
});

test("the mock session shows three words, confirms once and can be rejected", { skip: !strip }, async () => {
  const { parseWinkCode } = await import("./wink-code.ts");
  const { mockPairingSession } = await import("./pairing-session.ts");
  const c = parseWinkCode(LONG);
  assert.ok(c.ok);
  const s = mockPairingSession(c);
  assert.equal(s.words().length, 3);
  assert.deepEqual(s.words(), mockPairingSession(c).words());
  await s.confirm();
  const r = mockPairingSession(c);
  r.reject();
  await assert.rejects(r.confirm());
});

test("a pairing answer: the real set or all three typed words pair, anything else rejects for good", { skip: !strip }, async () => {
  const { parseWinkCode } = await import("./wink-code.ts");
  const { mockPairingSession } = await import("./pairing-session.ts");
  const c = parseWinkCode(LONG);
  assert.ok(c.ok);
  const w = mockPairingSession(c).words();
  const a = mockPairingSession(c);
  assert.equal(a.choices().length, 3);
  assert.ok(a.choices().some((x) => x.join(" ") === w.join(" ")));
  assert.equal(await a.answer(w), true);
  const b = mockPairingSession(c);
  assert.equal(await b.answer(["amber", "amber", "amber"]), false);
  assert.equal(await b.answer(w), false);
  assert.equal(await mockPairingSession(c).answer(w.map((x) => x.toUpperCase())), true);
});
