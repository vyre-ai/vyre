// @ts-check
import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { originRows, openOriginRows, sampleAllowed } from "./origin-history.js";
import { sealUserMessage } from "./private-text.js";

let cur = 0;
const f = (/** @type {string} */ type, /** @type {any} */ data, /** @type {string} */ message = String(data.message)) => ({ cur: ++cur, type: "chat." + type, message, data });
const frames = () => {
  cur = 0;
  return [
    f("user-message", { message: "u1", text: "Fix the date check" }),
    f("text-delta", { message: "a1", text: "I will " }),
    f("text-delta", { message: "a1", text: "look." }),
    f("text-done", { message: "a1" }),
    f("user-message", { message: "u2", text: "Now the form" }),
    f("text-delta", { message: "a2", text: "Done." }),
    f("text-done", { message: "a2" }),
    f("user-message", { message: "u3", text: "After the fork point" }),
  ];
};

test("the original up to the forked reply: nothing after it", () => {
  const r = originRows(frames(), "a1");
  assert.equal(r.found, true);
  assert.deepEqual(r.rows.map((x) => [x.role, x.text]), [["user", "Fix the date check"], ["agent", "I will look."]]);
});

test("the cut can sit later, and a reply that never finished is not the cut", () => {
  assert.equal(originRows(frames(), "a2").rows.length, 4);
  const open = frames().slice(0, 6);
  assert.equal(originRows(open, "a2").found, false);
});

test("a reply that is not in the frames gives no history", () => {
  const r = originRows(frames(), "nope");
  assert.deepEqual(r, { found: false, rows: [] });
});

test("queued, cancelled, thinking and notice frames are not history", () => {
  cur = 0;
  const r = originRows([
    f("user-message", { message: "q", text: "later", state: "queued" }),
    f("user-message", { message: "c", text: "gone", state: "cancelled" }),
    f("text-delta", { message: "a1", text: "hmm", reasoning: true }),
    f("text-delta", { message: "a1", text: "a notice", notice: true }),
    f("text-delta", { message: "a1", text: "Answer" }),
    f("text-done", { message: "a1" }),
  ], "a1");
  assert.deepEqual(r.rows.map((x) => x.text), ["Answer"]);
});

test("a private message is opened with the origin's key; a device without the ring shows no history", async () => {
  cur = 0;
  const key = new Uint8Array(32).fill(7);
  const enc = sealUserMessage("k1", key, "Secret ask");
  const raw = originRows([f("user-message", { message: "u1", enc }), f("text-delta", { message: "a1", text: "Reply" }), f("text-done", { message: "a1" })], "a1");
  const open = await openOriginRows(raw.rows, async (kid) => (kid === "k1" ? key : null));
  assert.deepEqual(open?.map((x) => x.text), ["Secret ask", "Reply"]);
  assert.equal(await openOriginRows(raw.rows, async () => null), null);
});

test("the sample origin (a fixed key) is only for the mock world: never reached in the real app", () => {
  assert.equal(sampleAllowed(true, true), true);
  assert.equal(sampleAllowed(true, false), false);
  assert.equal(sampleAllowed(false, true), false);
  assert.equal(sampleAllowed(undefined, false), false);
});
