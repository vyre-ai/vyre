// @ts-check
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { holds } from "./testkit.js";

test("holds finds a value, never a random id or a timestamp that happens to contain the digits", () => {
  // the three kinds of hit the whole-log substring search made in 500 runs of chat-kernel.test.js: a frame uuid, a message uuid, a kernel message id; and a millisecond time
  const noise = [{ v: 1, id: "f3dfe8de-f0e2-41da-9e72-4e7e85420052", cur: 3, time: 1791728894200, message: "842001fd-9916-4702-9d2b-aae9c6cc10ad", data: { kid: "msg_01a12b5d-873b-4ddb-924d-56035634200e", rid: "0a42-4200-b1", n: 14200 } }];
  assert.equal(JSON.stringify(noise).includes("4200"), true, "the substring search is fooled");
  assert.equal(holds(noise, 4200), false);
  assert.equal(holds([{ data: { blocks: [{ block: "field", value: { amount: 4200, currency: "USD" } }] } }], 4200), true, "a number as a value");
  assert.equal(holds({ text: "the fee is 4200 USD" }, 4200), true, "a whole word in a string");
  assert.equal(holds({ text: "the fee is 42000" }, 4200), false);
  assert.equal(holds({ amount: "4200" }, 4200), true, "a string holding exactly the number");
  assert.equal(holds(null, 4200), false);
});
