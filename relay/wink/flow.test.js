// @ts-check
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { APP_ORIGIN, addressOf, inert, needsInstall, cardOf, cardId, b64url, handoffUrl, initial, step } from "./flow.js";

const sha = async (/** @type {Uint8Array} */ b) => new Uint8Array(crypto.createHash("sha256").update(b).digest());
const IOS = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148";

test("needsInstall: only an iPhone or iPad in a browser tab; installed, Android and desktop scan", () => {
  assert.equal(needsInstall({ userAgent: IOS }), true);
  assert.equal(needsInstall({ userAgent: IOS, standalone: true }), false);
  assert.equal(needsInstall({ userAgent: IOS }, true), false, "display-mode: standalone");
  assert.equal(needsInstall({ userAgent: "Mozilla/5.0 (Macintosh)", platform: "MacIntel", maxTouchPoints: 5 }), true, "iPadOS says it is a Mac with a touch screen");
  assert.equal(needsInstall({ userAgent: "Mozilla/5.0 (Macintosh)", platform: "MacIntel", maxTouchPoints: 0 }), false, "a real Mac");
  assert.equal(needsInstall({ userAgent: "Mozilla/5.0 (Linux; Android 14; Pixel 8)" }), false);
});

test("inert: control and bidi characters go, one line, 64 characters, a fallback for nothing", () => {
  assert.equal(inert("alex\u202Eexe.txt\u0007\nrow"), "alex exe.txt row");
  assert.equal(inert("x".repeat(200)).length, 64);
  assert.equal(inert("\u200b\u0000", "a Vyre server"), "a Vyre server");
  assert.equal(inert(null, "z"), "z");
  assert.equal(inert("<img src=x onerror=alert(1)>"), "<img src=x onerror=alert(1)>", "kept as TEXT: the page renders it as a text node, never as markup");
});

test("the card is built from the verified record, and a payload cannot write its own consent text", async () => {
  const r = { name: "Alex's Mac\u202E", fingerprint: "AB12 CD34" };
  const c = cardOf(r, "id1");
  assert.equal(c.who, "Alex's Mac");
  assert.match(c.note, /talk to Alex's Mac\./);
  assert.deepEqual([c.main, c.other, c.purpose], ["Pair", "Not now", "pair.device"]);
  // cardOf takes only the record's own name and fingerprint: there is no argument through which a scanned payload's text could reach the card.
  assert.equal(cardOf.length, 2);
});

test("a card is bound to the exact ticket and words shown: any difference is a different id", async () => {
  const t = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
  const a = await cardId(t, { name: "Alex's Mac", fingerprint: "AB12 CD34" }, sha);
  assert.match(a, /^[0-9a-f]{24}$/);
  assert.equal(await cardId(t, { name: "Alex's Mac", fingerprint: "AB12 CD34" }, sha), a, "stable");
  assert.notEqual(await cardId(t, { name: "Alex's Mac", fingerprint: "AB12 CD35" }, sha), a, "another fingerprint");
  assert.notEqual(await cardId(t, { name: "Alex's Mac2", fingerprint: "AB12 CD34" }, sha), a, "another name");
  assert.notEqual(await cardId(new Uint8Array([9, 2, 3, 4, 5, 6, 7, 8]), { name: "Alex's Mac", fingerprint: "AB12 CD34" }, sha), a, "another ticket");
});

test("handoff: the app origin is a constant in this page, the ticket rides in the fragment as base64url", () => {
  assert.equal(APP_ORIGIN, "https://app.vyre.run");
  assert.equal(b64url(new Uint8Array([251, 255, 254])), "-__-");
  const u = handoffUrl(new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7]));
  assert.match(u, /^https:\/\/app\.vyre\.run\/#pair=[A-Za-z0-9_-]{11}$/);
  assert.equal(new URL(u).search, "", "never a query, which a server would see");
});

test("step: search, seen, locked, card, then only the matching confirm hands off; Not now returns to the camera", async () => {
  const card = cardOf({ name: "Alex's Mac", fingerprint: "AB12" }, "id1");
  let s = initial({ install: false });
  assert.equal(s.kind, "idle");
  s = step(s, { type: "start" }); assert.equal(s.kind, "search");
  assert.equal(step(s, { type: "shown" }).kind, "search", "no card before a lock");
  s = step(s, { type: "seen" }); assert.equal(s.kind, "seen");
  s = step(s, { type: "locked", card }); assert.equal(s.kind, "locked");
  s = step(s, { type: "shown" }); assert.equal(s.kind, "card");
  assert.equal(step(s, { type: "confirm", id: "other" }).kind, "card", "a confirm for another card does nothing");
  assert.equal(step(s, { type: "notNow" }).kind, "search");
  assert.equal(step(s, { type: "confirm", id: "id1" }).kind, "handoff");
  assert.equal(step({ kind: "search" }, { type: "confirm", id: "id1" }).kind, "search", "a confirm with no card on screen does nothing");
});

test("step: errors are inert text and retry returns to the camera; an install page never becomes a scanner", () => {
  const e = step({ kind: "search" }, { type: "failed", code: "ticket_gone", message: "Gone\u202E\u0007" });
  assert.deepEqual(e, { kind: "error", code: "ticket_gone", message: "Gone", retryable: true });
  assert.equal(step(e, { type: "retry" }).kind, "search");
  const i = initial({ install: true });
  for (const ev of [{ type: "start" }, { type: "seen" }, { type: "retry" }]) assert.equal(step(i, /** @type {any} */ (ev)).kind, "install");
});

test("addressOf: a vyre.run name from a plain handle, and nothing for anything else (no host, IP, path or label with a dot)", () => {
  assert.equal(addressOf("alex"), "alex.vyre.run");
  assert.equal(addressOf("harlow-legal"), "harlow-legal.vyre.run");
  for (const bad of ["evil.example", "a.b", "10.0.0.1", "-x", "x-", "", "A", "alex/../x", "alex:8080", "alex@evil", null, undefined, 5, "x".repeat(64)]) assert.equal(addressOf(bad), "", String(bad));
  const card = cardOf({ name: "Alex's Mac", fingerprint: "AB12", handle: "alex" }, "id");
  assert.equal(card.address, "alex.vyre.run");
  assert.equal(cardOf({ name: "Alex's Mac", fingerprint: "AB12", handle: "evil.example" }, "id").address, "");
});
