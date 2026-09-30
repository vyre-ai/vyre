// @ts-check
import { test } from "node:test";
import assert from "node:assert/strict";
import { install, text, $, $$, everything } from "../../test/fake-dom.js";

const doc = /** @type {any} */ (install());
doc.importNode = n => n;
doc.createDocumentFragment = () => new /** @type {any} */ (globalThis).Element("fragment");
Object.assign(globalThis, {
  DOMParser: class { parseFromString() { const E = /** @type {any} */ (globalThis).Element; const svg = new E("svg"); svg.append(new E("circle")); return { documentElement: svg }; } },
  CustomEvent: class extends /** @type {any} */ (globalThis).Event { constructor(t, o) { super(t); this.detail = o?.detail; } },
  dispatchEvent: () => true,
  PublicKeyCredential: function PublicKeyCredential() {},
});
const buf = () => new Uint8Array([1, 2, 3]).buffer;
Object.defineProperty(globalThis, "navigator", { configurable: true, writable: true,
  value: { userAgent: "Macintosh", maxTouchPoints: 0, credentials: { get: async () => ({ rawId: buf(), response: { authenticatorData: buf(), clientDataJSON: buf(), signature: buf() } }) } } });

/** A fake vyred: tools by name, every call recorded with whether it carried a presence proof. */
function vyred(answers = {}) {
  const calls = [];
  globalThis.fetch = /** @type {any} */ (async (url, o) => {
    if (String(url).includes("/v1/presence/challenge")) return { status: 200, json: async () => ({ data: { challenge: "ch1", webauthn: { challenge: "AAAA", rpId: "localhost" } } }) };
    const tool = decodeURIComponent(String(url).split("/v1/tools/")[1]);
    const input = JSON.parse(o.body);
    calls.push({ tool, input, presence: !!o.headers["x-vyre-presence"] });
    const a0 = tool in answers ? answers[tool] : { ok: true };
    const a = typeof a0 === "function" ? a0(input) : a0;
    if (a && a.$error) return { status: 409, statusText: "", json: async () => ({ error: a.$error }) };
    return { status: 200, statusText: "", json: async () => ({ data: a }) };
  });
  return { calls, of: t => calls.filter(c => c.tool === t) };
}
const settle = () => new Promise(r => setTimeout(r, 5));

const { calendarEvent, timeRange, responseWord } = await import("./calendar-event.js");
const NOW = Date.parse("2026-10-02T16:00:00Z");
const ev = (o = {}) => ({ id: "ev-1", title: "Northwind pricing review", start: "2026-10-02T17:00:00Z", end: "2026-10-02T17:30:00Z", place: "Video call",
  join: "https://meet.example.test/abc", attendees: [{ name: "Sam Reyes", response: "accepted" }, { name: "Jo Park", response: "declined" }, { name: "Kit", response: "tentative" }, { name: "Ana", response: "needsAction" }],
  response: "needsAction", ...o });
const ctx = (o = {}) => ({ now: () => NOW, ...o });

test("calendar event: title, date, time and place, people stack, and three answers", () => {
  const c = calendarEvent(ev(), ctx());
  assert.equal(c.getAttribute("aria-label"), "Calendar event");
  assert.match(text($(c, ".cv-card-head")), /Northwind pricing review/);
  assert.match(text($(c, ".cv-ce-when")), /\d\d:\d\d\u2013\d\d:\d\d.* \u00b7 Video call/);
  assert.equal($(c, ".cv-ce-avs").getAttribute("aria-hidden"), "true");
  assert.equal($$(c, ".cv-ce-av").length, 4);
  assert.deepEqual($$(c, ".cv-ce-foot .btn").map(b => text(b)), ["Accept", "Maybe", "Decline"]);
});

test("calendar event: the join link shows only within 15 minutes of the start and never on a past event", () => {
  assert.equal($(calendarEvent(ev(), ctx({ now: () => NOW - 3600_000 })), "[data-act=join]"), null, "an hour early");
  const opened = [];
  const c = calendarEvent(ev(), ctx({ now: () => Date.parse("2026-10-02T16:50:00Z"), open: h => opened.push(h) }));
  $(c, "[data-act=join]").click();
  assert.deepEqual(opened, ["https://meet.example.test/abc"]);
  const past = calendarEvent(ev(), ctx({ now: () => Date.parse("2026-10-03T00:00:00Z") }));
  assert.equal($(past, "[data-act=join]"), null);
  assert.equal($$(past, ".cv-ce-foot").length, 0, "no footer on a past event");
});

test("calendar event: expanding lists everyone with the response as a word", async () => {
  const c = calendarEvent(ev({ attendees: Array.from({ length: 7 }, (_, i) => ({ name: `Guest ${i}`, response: i ? "accepted" : "declined" })) }), ctx());
  assert.equal($$(c, ".cv-ce-av").length, 5);
  assert.match(text($(c, ".cv-ce-more")), /\+2/);
  assert.equal($(c, ".cv-ce-list"), null);
  await $(c, ".cv-ce-stack").click();
  assert.equal($$(c, ".cv-ce-person").length, 7);
  assert.match(text($$(c, ".cv-ce-person")[0]), /Guest 0.*declined/);
  assert.equal(responseWord("tentative"), "maybe");
  assert.equal(responseWord(undefined), "no answer yet");
});

test("calendar event: Accept calls calendar.respond through the outbox, no passkey, then says You accepted with Change", async () => {
  const f = vyred();
  const c = calendarEvent(ev(), ctx());
  $(c, "[data-act=accepted]").click();
  assert.match(text($(c, "[data-act=accepted]")), /Accepting/);
  assert.equal($(c, "[data-act=declined]").disabled, true);
  await settle(); await settle();
  assert.deepEqual(f.of("calendar.respond").map(x => [x.input, x.presence]), [[{ event: "ev-1", response: "accepted", surface: "deck" }, false]]);
  assert.match(text($(c, ".cv-ce-done")), /You accepted\s*Change/);
  assert.equal($$(c, "[data-act=accepted]").length, 0);
  await $(c, ".cv-ce-change").click();
  assert.equal($$(c, ".cv-ce-btn").length, 3, "Change brings the three answers back");
  $(c, "[data-act=tentative]").click();
  await settle(); await settle();
  assert.equal(f.of("calendar.respond")[1].input.response, "tentative");
  assert.match(text(c), /You said maybe/);
});

test("calendar event: an invite already answered shows the answer; a refused answer says why and gives the buttons back", async () => {
  const c = calendarEvent(ev({ response: "declined" }), ctx());
  assert.match(text($(c, ".cv-ce-done")), /You declined/);
  vyred({ "calendar.respond": { $error: { code: "bad", message: "Calendar is not connected" } } });
  const d = calendarEvent(ev(), ctx());
  $(d, "[data-act=declined]").click();
  await settle(); await settle();
  assert.match(text($(d, ".cv-ce-err")), /Calendar is not connected/);
  assert.equal($(d, "[data-act=declined]").disabled, false);
});

test("calendar event: a recurring event asks This event or All events first and sends the scope", async () => {
  const f = vyred();
  const c = calendarEvent(ev({ recurring: true }), ctx());
  assert.match(text($(c, ".cv-card-head")), /repeats/);
  $(c, "[data-act=accepted]").click();
  assert.equal(f.of("calendar.respond").length, 0, "nothing sent before the choice");
  assert.deepEqual($$(c, ".cv-ce-scope .btn").map(b => text(b)), ["This event", "All events", "Back"]);
  $(c, "[data-scope=all]").click();
  await settle(); await settle();
  assert.deepEqual(f.of("calendar.respond")[0].input, { event: "ev-1", response: "accepted", scope: "all", surface: "deck" });
});

test("calendar event: a needsResponse false event has no footer; the organizer's clock shows when the zone differs", () => {
  assert.equal($$(calendarEvent(ev({ needsResponse: false, response: "" }), ctx()), ".cv-ce-foot").length, 0);
  const t = timeRange("2026-10-02T17:00:00Z", "2026-10-02T17:30:00Z", "Asia/Kolkata");
  assert.match(t, /organizer's time/);
  assert.doesNotMatch(timeRange("2026-10-02T17:00:00Z", "2026-10-02T17:30:00Z"), /organizer/);
});
