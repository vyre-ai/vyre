// @ts-check
import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { askPhoneForSession, SESSION_ASK, SESSION_STATUS, sessionEndLine } from "./phone-session.js";

const FAST = { sleep: async () => {}, pollMs: 0 };
/** @param {any[]} states */
const box = (states) => { const calls = /** @type {string[]} */ ([]); let i = 0; return { calls, call: async (/** @type {string} */ t) => { calls.push(t); if (t === SESSION_ASK) return { data: { id: "ps_1" } }; const s = states[Math.min(i++, states.length - 1)]; return s.error ? s : { data: { state: s } }; } }; };

test("the phone approves: the ask is filed, then polled until approved", async () => {
  const b = box(["waiting", "waiting", "approved"]); let waited = 0;
  assert.deepEqual(await askPhoneForSession(b.call, { ...FAST, onWaiting: () => { waited++; } }), { approved: true });
  assert.deepEqual(b.calls, [SESSION_ASK, SESSION_STATUS, SESSION_STATUS, SESSION_STATUS]); assert.equal(waited, 1);
});

test("a no, a closed ask and a timeout each end it with their own words", async () => {
  assert.deepEqual(await askPhoneForSession(box(["refused"]).call, FAST), { ended: "refused" });
  assert.deepEqual(await askPhoneForSession(box(["none"]).call, FAST), { ended: "none" });
  let t = 0;
  assert.deepEqual(await askPhoneForSession(box(["waiting"]).call, { ...FAST, now: () => (t += 200_000), limitMs: 300_000 }), { ended: "timeout" });
  assert.match(sessionEndLine("refused"), /said no on your phone/);
});

test("stopping the wait ends it, and a server without the tools says to update", async () => {
  assert.deepEqual(await askPhoneForSession(box(["waiting"]).call, { ...FAST, signal: { stopped: true } }), { ended: "none" });
  await assert.rejects(askPhoneForSession(async () => ({ error: { code: "no_such_tool" } }), FAST), (/** @type {any} */ e) => e.code === "server_too_old" && /Update it/.test(e.message));
});
