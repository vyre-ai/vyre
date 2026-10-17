// @ts-check
import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";

const strip = Boolean(/** @type {any} */ (process.features).typescript);
const LONG = "vyre://wink/2?t=SGVsbG9TYW1wbGVTZWNyZQ&r=wss%3A%2F%2Frelay.example";

test("a long code is read for a server, and one marked for a phone is not a code", { skip: !strip }, async () => {
  const { parseWinkCode } = await import("./wink-code.ts");
  assert.deepEqual(parseWinkCode(`  ${LONG}\n`), { ok: true, kind: "ticket", ticket: "SGVsbG9TYW1wbGVTZWNyZQ", relay: "wss://relay.example", for: "server" });
  const p = parseWinkCode(`${LONG}&k=phone`);
  assert.ok(!p.ok && p.reason === "not_a_code");
});

test("the old bearer offer is refused, in every wrapping, with the next step", { skip: !strip }, async () => {
  const { parseWinkCode, SAY } = await import("./wink-code.ts");
  const offer = "https://vyre.run/pair#eyJhIjoxfQ";
  for (const t of [offer, `vyre://pair?offer=${encodeURIComponent(offer)}`, `https://h.example/app/pair?offer=${encodeURIComponent(offer)}`, `vyre://pair?offer=${offer}`, encodeURIComponent(offer)]) {
    const r = parseWinkCode(t);
    assert.equal(r.ok, false, t);
    assert.equal(!r.ok && r.reason, "old_offer", t);
    assert.equal(!r.ok && r.say, SAY.old_offer);
  }
  assert.match(SAY.old_offer, /install line/);
  assert.equal(parseWinkCode("https://example.com/pair").ok, false);
  assert.equal(!parseWinkCode("https://example.com/pair").ok && parseWinkCode("https://example.com/pair").reason, "not_a_code");
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
  assert.equal(readCode("hello")?.kind, "other");
  const seen = [];
  let t = 0;
  const once = onceEach((c) => seen.push(c), 1500, () => t);
  once(LONG); once(LONG); t = 100; once(LONG);
  assert.equal(seen.length, 1);
  t = 5000; once(LONG);
  assert.equal(seen.length, 2);
});
