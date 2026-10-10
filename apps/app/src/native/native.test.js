// @ts-check
// The pure halves of src/native: what a scanned code is, how a failed prompt reads, how a notice
// is trimmed, and which path the app takes. No native module, no DOM.
import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";

import { test } from "node:test";
import assert from "node:assert/strict";

const strip = Boolean(/** @type {any} */ (process.features).typescript);
const OFFER = "https://vyre.run/pair#eyJhIjoxfQ";

test("readCode: a bare offer, a vyre:// link and plain text", { skip: !strip }, async () => {
  const { readCode, MAX_OTHER } = await import("./scan-model.ts");
  assert.deepEqual(readCode(OFFER), { kind: "pair", offer: OFFER });
  assert.deepEqual(readCode(`vyre://pair?offer=${encodeURIComponent(OFFER)}`), { kind: "pair", offer: OFFER });
  assert.deepEqual(readCode("  hello  "), { kind: "other", text: "hello" });
  assert.equal(readCode("   "), null);
  assert.equal(readCode(null), null);
  const long = readCode("x".repeat(5000));
  assert.equal(long?.kind === "other" && long.text.length, MAX_OTHER);
  const otp = "otpauth-migration://offline?data=" + "A".repeat(1500);
  assert.deepEqual(readCode(otp), { kind: "other", text: otp }, "a one-time-code address is read whole, not cut to the length kept for other codes");
  assert.equal(readCode("otpauth://totp/x?secret=" + "B".repeat(6000))?.text?.length, 4096);
});

test("onceEach: the same code inside the hold is read once, a different one at once", { skip: !strip }, async () => {
  const { onceEach } = await import("./scan-model.ts");
  let t = 0;
  const seen = [];
  const read = onceEach((c) => seen.push(c.kind === "pair" ? c.offer : c.text), 1000, () => t);
  read(OFFER); read(OFFER); t = 500; read(OFFER);
  assert.equal(seen.length, 1);
  read("other"); assert.equal(seen.length, 2);
  t = 2000; read("other"); assert.equal(seen.length, 3);
  read(""); assert.equal(seen.length, 3);
});

test("failFrom: the signer's codes become plain refusals", { skip: !strip }, async () => {
  const { failFrom, refusal, SAY, promptTitle, inHardware } = await import("./presence-model.ts");
  assert.equal(failFrom({ code: "ERR_CANCELED" }), "canceled");
  assert.equal(failFrom({ code: "ERR_KEY_INVALIDATED" }), "changed");
  assert.equal(failFrom({ code: "ERR_NO_BIOMETRICS" }), "no-biometrics");
  assert.equal(failFrom({ code: "ERR_SIGN" }), "failed");
  assert.equal(failFrom(new Error("x")), "failed");
  assert.equal(failFrom(null), "failed");
  assert.deepEqual(refusal("canceled"), { ok: false, reason: "canceled", say: SAY.canceled });
  for (const s of Object.values(SAY)) assert.ok(!/[—§]/.test(s), "no em dash or section sign");
  assert.equal(promptTitle("  "), "Approve with your fingerprint or face");
  assert.equal(promptTitle("a".repeat(100)).length, 60);
  assert.ok(inHardware("strongbox") && inHardware("secure-enclave") && !inHardware("software") && !inHardware("none"));
});

test("cleanNotice: trims, drops an empty one, keeps only app routes", { skip: !strip }, async () => {
  const { cleanNotice } = await import("./notify-model.ts");
  assert.equal(cleanNotice({ id: "a", title: "  " }), null);
  assert.equal(cleanNotice({ id: "", title: "Hi" }), null);
  const n = cleanNotice({ id: "a", title: "Send  the\nreply", body: "b".repeat(400), route: "/u/now" });
  assert.equal(n?.title, "Send the reply");
  assert.equal(n?.body?.length, 180);
  assert.equal(n?.route, "/u/now");
  assert.equal(cleanNotice({ id: "a", title: "x", route: "https://evil.example" })?.route, undefined);
  assert.equal(cleanNotice({ id: "a", title: "x", route: "//evil.example" })?.route, undefined);
});

test("nullTransport and nullLink do nothing and say so", { skip: !strip }, async () => {
  const { nullTransport } = await import("./notify-model.ts");
  const { nullLink, pickPath, OFF } = await import("./tailnet-model.ts");
  const stop = await nullTransport.start(() => assert.fail("a null transport delivers nothing"));
  stop();
  assert.equal((await nullLink.start({ control: "https://c.example", hostname: "p" })).state, "off");
  assert.equal(nullLink.status(), OFF);
  await nullLink.stop();
});

test("pickPath: the link when up, else the relay when paired, else direct", { skip: !strip }, async () => {
  const { pickPath, OFF } = await import("./tailnet-model.ts");
  const up = { state: /** @type {const} */ ("up"), say: "" };
  assert.equal(pickPath({ link: up, relayPaired: true }), "tailnet");
  assert.equal(pickPath({ link: OFF, relayPaired: true }), "relay");
  assert.equal(pickPath({ link: OFF, relayPaired: false }), "direct");
  assert.equal(pickPath({ link: { state: "starting", say: "" }, relayPaired: true }), "relay");
});

test("keyStorage: what the pairing hello reports about the key", { skip: !strip }, async () => {
  const { keyStorage } = await import("./presence-model.ts");
  assert.equal(keyStorage("secure-enclave"), "hardware");
  assert.equal(keyStorage("strongbox"), "hardware");
  assert.equal(keyStorage("tee"), "hardware");
  assert.equal(keyStorage("software"), "software");
  assert.equal(keyStorage("none"), undefined);
  assert.equal(keyStorage(undefined), undefined);
});

test("notices with the app closed: the connection is kept when notices are allowed and wanted, stopped when the person turns it off, and left alone otherwise; the row says what a tap does", { skip: !strip }, async () => {
  const { keepPlan, keepState, keepTap, KEEP_SAY } = await import("./keepalive-model.ts");
  const i = (/** @type {any} */ o) => ({ android: true, permission: "granted", wanted: true, ...o });
  assert.equal(keepPlan(i({})), "start");
  assert.equal(keepPlan(i({ wanted: false })), "stop");
  for (const permission of ["ask", "denied", "unavailable"]) assert.equal(keepPlan(i({ permission })), "nothing", `not allowed (${permission}): nothing is started`);
  assert.equal(keepPlan(i({ android: false })), "nothing", "no service off Android");
  assert.deepEqual(["on", "off", "ask", "denied"].map(s => keepState(i(s === "on" ? {} : s === "off" ? { wanted: false } : { permission: s }))), ["on", "off", "ask", "denied"]);
  assert.equal(keepState(i({ android: false })), "unavailable");
  assert.deepEqual(["on", "off", "ask", "denied", "unavailable"].map(s => keepTap(/** @type {any} */ (s))), ["turn-off", "turn-on", "ask", "open-settings", "nothing"]);
  for (const s of ["on", "off", "ask", "denied"]) assert.ok(KEEP_SAY[/** @type {"on"} */ (s)].line.length > 10 && !/push|token|Firebase|Google/i.test(KEEP_SAY[/** @type {"on"} */ (s)].line), `${s}: the line is plain and promises no push service`);
});
