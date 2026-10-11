// @ts-check
import "../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { holds, leaks } from "./holds.js";
import { prng } from "../core/stream/testkit.js";

// what a plain substring search over a log was fooled by: a frame uuid, a message uuid, a kernel message id, a millisecond time
const noise = () => [{ v: 1, id: "f3dfe8de-f0e2-41da-9e72-4e7e85420052", cur: 3, time: 1791728894200, message: "842001fd-9916-4702-9d2b-aae9c6cc10ad", data: { kid: "msg_01a12b5d-873b-4ddb-924d-56035634200e", rid: "0a42-4200-b1", n: 14200, hash: "ab".repeat(15) + "4200" + "cd".repeat(10) } }];

test("holds finds a value, never a random id or a timestamp that happens to contain the digits", () => {
  assert.equal(JSON.stringify(noise()).includes("4200"), true, "the substring search is fooled");
  assert.equal(holds(noise(), 4200), false);
  assert.equal(holds([{ data: { blocks: [{ block: "field", value: { amount: 4200, currency: "USD" } }] } }], 4200), true, "a number as a value");
  assert.equal(holds({ text: "the fee is 4200 USD" }, 4200), true, "a whole word in a string");
  assert.equal(holds({ text: "the fee is 42000" }, 4200), false);
  assert.equal(holds({ amount: "4200" }, 4200), true, "a string holding exactly the number");
  assert.equal(holds(null, 4200), false);
});

test("leaks passes only for the system's own random runs and fails for the secret anywhere else, as a value, a fragment or in a key", () => {
  const system = () => noise().map(({ id, cur, time, message, data: { kid, hash } }) => ({ id, cur, time, message, data: { kid, hash } })); // only what the system itself makes up
  assert.equal(JSON.stringify(system()).includes("4200"), true);
  assert.equal(leaks(system(), "4200"), false, "uuids, a message id, a 54-hex hash and a millisecond time are excused");
  assert.equal(leaks(system(), 4200), false);
  assert.equal(leaks({ ref: "seal_2514ebe75ecd748fa6f9289bc6c248" }, "6789"), false, "a prefixed random id is excused");
  assert.equal(leaks({ ref: "seal_2514ebe75ecd748fa6f9289bc6c248" }, "2514"), false);
  assert.equal(leaks(noise(), "4200"), true, "but a short dashed run and a number that are not the system's own are not");
  // a fragment of a sealed value, in every shape a leak takes
  for (const [what, v] of /** @type {[string, unknown][]} */ ([
    ["the fragment as a value", { last4: "6789" }], ["after a mask", { hint: "***6789" }], ["inside a longer word", { note: "ab4471zk9" }], ["with letters round it", { note: "x6789y" }],
    ["as a number", { n: 6789 }], ["in a key", { "6789": 1 }], ["in a list", ["a", ["b", "6789"]]], ["a whole card number", { card: "4111111111111111" }], ["a 12-digit run (not a time)", { n: "100000006789" }],
    ["a 13-digit run that is not a time", { n: "4000000006789" }], ["next to an id", { text: "6789 and f3dfe8de-f0e2-41da-9e72-4e7e85420052" }], ["a short hex word", { h: "deadbeef6789" }], ["a prefixed id too short to be random", { id: "seal_abcd6789" }],
  ])) {
    assert.equal(leaks(v, v && typeof v === "object" && !Array.isArray(v) && "card" in v ? "4111" : /4471/.test(JSON.stringify(v)) ? "4471" : "6789"), true, what);
  }
  assert.equal(leaks({ a: 1 }, "6789"), false);
  assert.equal(leaks(undefined, "6789"), false);
  assert.equal(leaks({ a: 1 }, ""), false);
});

test("leaks, 20000 random logs: never fooled by ids, hashes and times that contain the needle, always finds it planted anywhere else", () => {
  const rnd = prng(20261011);
  const pick = (/** @type {string} */ alphabet, /** @type {number} */ n) => Array.from({ length: n }, () => alphabet[Math.floor(rnd() * alphabet.length)]).join("");
  const hex = (/** @type {number} */ n) => pick("0123456789abcdef", n), dig = (/** @type {number} */ n) => pick("0123456789", n);
  const needles = ["4200", "6789", "4471", "4111", "4242", "4321", "1234", "321"];
  let fired = 0, missed = 0;
  for (let i = 0; i < 20000; i++) {
    const needle = needles[i % needles.length];
    // every random run of a log, with the needle sitting inside it
    const uuid = `${hex(8)}-${hex(4)}-${hex(4)}-${hex(4)}-${hex(12 - needle.length)}${needle}`;
    const hash = hex(30) + needle + hex(34 - needle.length);
    const time = Number("17" + dig(2) + needle + dig(13 - 4 - needle.length));
    const log = [{ v: 1, id: uuid, cur: 3, time, kid: `msg_${uuid}`, data: { hash, rid: uuid } }];
    assert.equal(String(time).length, 13);
    if (leaks(log, needle)) fired++;
    // the same log with the needle also in plain text, in a mask, or as a whole value
    for (const bad of [{ text: `card ${needle} on file` }, { hint: `***${needle}` }, { v: needle }, { note: `x${needle}y` }]) if (!leaks([...log, bad], needle)) missed++;
  }
  assert.equal(fired, 0, "ids, hashes and times that contain the needle are not a leak");
  assert.equal(missed, 0, "a needle planted anywhere else is always found");
});
