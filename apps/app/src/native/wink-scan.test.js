import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { generated, workerSource } from "../../scripts/build-wink-scan.mjs";
import * as payload from "../../../../lib/wink-code/payload.js";

const sandbox = () => {
  const posted = [];
  const self = { postMessage: (m) => posted.push(m) };
  const ctx = vm.createContext({ self, Math, Array, Uint8Array, Float64Array, Number, Object, Set, Map, console });
  vm.runInContext(workerSource() + "\nthis.__t = { ticketFromLevels, decodeFrame };", ctx);
  return { ctx, self, posted };
};
const id8 = [...createHash("sha256").update("wink-scan-test").digest()].slice(0, 8);
/** The mark levels a drawn code of this ticket carries (two bits per mark, the renderer's own order). */
const levelsOf = (id) => { const bits = payload.bytesToBits(payload.buildCodeword(id)), out = []; for (let i = 0; i < bits.length; i += 2) out.push((bits[i] << 1) | bits[i + 1]); return out; };

test("the generated page is what the Deck's decoder sources make", () => {
  const have = readFileSync(new URL("./wink-scan-page.generated.js", import.meta.url), "utf8");
  assert.equal(have, generated(), "run node scripts/build-wink-scan.mjs");
});

test("the worker turns the mark levels of a drawn code back into its ticket, and refuses damaged ones", () => {
  const { ctx } = sandbox();
  assert.equal(JSON.stringify(ctx.__t.ticketFromLevels(levelsOf(id8))), JSON.stringify(id8));
  const damaged = levelsOf(id8);
  for (let i = 0; i < 3; i++) damaged[i * 11] = (damaged[i * 11] + 1) % 4; // three wrong marks, in three different bytes: Reed-Solomon corrects up to four
  assert.equal(JSON.stringify(ctx.__t.ticketFromLevels(damaged)), JSON.stringify(id8));
  const junk = levelsOf(id8).map((l, i) => (i % 2 ? (l + 2) % 4 : (l + 1) % 4)); // far past what it can correct
  assert.equal(ctx.__t.ticketFromLevels(junk), null);
});

test("a frame with no code in it gives no ticket, and the worker answers over postMessage", () => {
  const { ctx, self, posted } = sandbox();
  const w = 48, h = 48, data = new Uint8ClampedArray(w * h * 4).fill(127);
  assert.equal(ctx.__t.decodeFrame(data, w, h), null);
  self.onmessage({ data: { data, width: w, height: h } });
  assert.equal(JSON.stringify(posted), JSON.stringify([{ ticket: null }]));
});

test("the page opens the back camera, tells the app only the ticket, and says plainly when the camera is refused", () => {
  const html = readFileSync(new URL("./wink-scan-page.generated.js", import.meta.url), "utf8");
  for (const piece of ["facingMode", "getUserMedia", "ReactNativeWebView.postMessage", "NotAllowedError", "type: \\\"ticket\\\"", "stream.getTracks().forEach"]) assert.ok(html.includes(piece), piece);
  assert.ok(!/console\.log|localStorage|sessionStorage/.test(html), "the ticket is never logged or kept");
});

import { readScanMessage, SCAN_SAY } from "./wink-scan-model.ts";

test("the app reads only the page's four messages, and only a ticket of exactly eight bytes", () => {
  assert.deepEqual(readScanMessage(JSON.stringify({ type: "ready" })), { type: "ready" });
  assert.deepEqual(readScanMessage(JSON.stringify({ type: "slow" })), { type: "slow" });
  const t = readScanMessage(JSON.stringify({ type: "ticket", ticket: [1, 2, 3, 4, 5, 6, 7, 255] }));
  assert.equal(t?.type, "ticket");
  assert.ok(t?.type === "ticket" && t.ticket instanceof Uint8Array && t.ticket.length === 8);
  for (const bad of [[1, 2, 3], [1, 2, 3, 4, 5, 6, 7, 256], [1, 2, 3, 4, 5, 6, 7, "x"], "no", null]) assert.equal(readScanMessage(JSON.stringify({ type: "ticket", ticket: bad })), null);
  assert.equal(readScanMessage("not json"), null);
  assert.equal(readScanMessage(JSON.stringify({ type: "something else" })), null);
  assert.equal(readScanMessage(42), null);
});

test("an error says one of three plain things, and every failure has words for the person", () => {
  assert.equal(readScanMessage(JSON.stringify({ type: "error", code: "denied", message: "x" }))?.code, "denied");
  assert.equal(readScanMessage(JSON.stringify({ type: "error", code: "weird" }))?.code, "no_camera");
  for (const k of ["denied", "no_camera", "scan_worker", "slow"]) assert.ok(SCAN_SAY[k].length > 10 && !/—/.test(SCAN_SAY[k]), k);
});

test("the component loads the generated page from a secure origin and keeps the ticket to one event", async () => {
  const src = readFileSync(new URL("./WinkScan.native.tsx", import.meta.url), "utf8");
  assert.match(src, /baseUrl: "https:\/\/vyre\.run\/"/);
  assert.match(src, /if \(e\.type === "ticket"\) done\.current = true/);
  assert.match(src, /mediaCapturePermissionGrantType="grant"/);
});
