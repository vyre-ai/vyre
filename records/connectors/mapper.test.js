import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { get, addresses, transform, mapItem, MAPPER_SOURCE } from "./mapper.js";

const msg = { id: "m1", threadId: "t1", snippet: "Hello there", internalDate: "1791000060000", payload: { headers: [
  { name: "From", value: "Jane Doe <Jane.Doe@Harlow.Test>" }, { name: "To", value: "Alex <alex@harlow.test>, bob@y.test" }, { name: "Subject", value: "Trust signing" }] } };

test("get: dotted paths, list positions and [key=value] picks, never prototype names", () => {
  assert.equal(get(msg, "id"), "m1");
  assert.equal(get(msg, "payload.headers[0].name"), "From");
  assert.equal(get(msg, "payload.headers[name=subject].value"), "Trust signing", "the key's value is matched without regard to case");
  assert.equal(get(msg, "payload.headers[name=Nope].value"), undefined);
  assert.equal(get(msg, "payload.nothing.deeper"), undefined);
  assert.equal(get(msg, "__proto__.x"), undefined);
  assert.equal(get({ a: [1, 2] }, "a[5]"), undefined);
});

test("transforms: addresses, iso, truncate, and an unknown one is an error", () => {
  assert.deepEqual(addresses("Jane <A@b.test>, c@d.test, A@B.test"), ["a@b.test", "c@d.test"]);
  assert.deepEqual(addresses([{ email: "X@y.test" }, { email: "x@y.test" }, "z@w.test"]), ["x@y.test", "z@w.test"]);
  assert.equal(transform("1791000060000", "iso"), "2026-10-03T04:01:00.000Z");
  assert.equal(transform(1791000060, "iso"), "2026-10-03T04:01:00.000Z", "seconds are read as seconds");
  assert.equal(transform("2026-10-09", "iso"), "2026-10-09T00:00:00.000Z");
  assert.equal(transform("abcdef", "truncate:3"), "abc");
  assert.throws(() => transform("x", "shout"), /no transform/);
});

test("mapItem: a Gmail message becomes the item the logging Flow files; fields with no value are left out", () => {
  const map = {
    kind: { const: "email" }, source_key: { template: "gmail:{$mailbox}:{id}" }, mailbox: "$mailbox",
    direction: { direction: { from: "payload.headers[name=From].value", mine: "$mailbox" } },
    at: "internalDate|iso", subject: "payload.headers[name=Subject].value|truncate:5", excerpt: "snippet", missing: "no.such.path",
    people: { people: [{ path: "payload.headers[name=From].value", how: "from" }, { path: "payload.headers[name=To].value", how: "to" }, { path: "payload.headers[name=Cc].value", how: "cc" }] },
  };
  const a = mapItem(msg, map, { mailbox: "alex@harlow.test" });
  assert.deepEqual(a, { kind: "email", source_key: "gmail:alex@harlow.test:m1", mailbox: "alex@harlow.test", direction: "inbound", at: "2026-10-03T04:01:00.000Z", subject: "Trust", excerpt: "Hello there",
    people: [{ address: "jane.doe@harlow.test", how: "from" }, { address: "alex@harlow.test", how: "to" }, { address: "bob@y.test", how: "to" }],
    from: "jane.doe@harlow.test", to: "alex@harlow.test, bob@y.test" }, "who was on it, as written, by role (the Communication's own text fields)");
  assert.equal(mapItem(msg, map, { mailbox: "jane.doe@harlow.test" }).direction, "outbound", "from the mailbox's own address is outbound");
  assert.equal(mapItem(msg, { source_key: { template: "x:{$mailbox}" } }, {}).source_key, undefined, "a template with a missing part is not made up");
  assert.equal(mapItem({ start: { date: "2026-10-09" } }, { at: "start.dateTime ?? start.date|iso" }).at, "2026-10-09T00:00:00.000Z", "?? takes the first path that has a value");
  assert.equal(mapItem({ start: { dateTime: "2026-10-08T09:00:00-07:00" } }, { at: "start.dateTime ?? start.date|iso" }).at, "2026-10-08T16:00:00.000Z", "the pipes apply to whichever path won");
  assert.throws(() => mapItem(msg, { x: 5 }), /mapped field/);
});

test("MAPPER_SOURCE is the same mapper, for a sandbox that cannot import it", () => {
  const M = (0, eval)(MAPPER_SOURCE);
  assert.deepEqual(M.mapItem(msg, { id: "id", t: "payload.headers[name=Subject].value" }), mapItem(msg, { id: "id", t: "payload.headers[name=Subject].value" }));
  assert.ok(!/\bimport\b|\brequire\b/.test(MAPPER_SOURCE));
});
