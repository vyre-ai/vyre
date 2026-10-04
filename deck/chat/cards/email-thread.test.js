// @ts-check
import "../../../scripts/mac-test-guard.mjs";
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

const { emailThread, splitQuote, person } = await import("./email-thread.js");
const MSGS = [
  { from: "Sam Reyes <sam@northwind.test>", to: ["alex@harlow.test"], at: "2026-09-28T09:00:00Z", snippet: "Following up on the October numbers", body: "Following up on the October numbers.\n\nCan you check the totals?" },
  { from: "alex@harlow.test", to: ["sam@northwind.test"], at: "2026-09-29T09:00:00Z", snippet: "Totals attached", body: "Totals attached.", attachments: [{ name: "totals.xlsx", size: 412000 }] },
  { from: "Sam Reyes <sam@northwind.test>", to: ["alex@harlow.test"], at: "2026-09-30T09:00:00Z",
    body: "Thanks, see https://northwind.test/invoice/7 and <img src=x onerror=boom()>\n\nSecond paragraph.\n\nOn Tue, 29 Sep 2026, alex wrote:\n> Totals attached.\n> Regards" },
];
const data = () => ({ subject: "October numbers", messages: MSGS.map(m => ({ ...m })), link: "https://mail.example.test/t/1" });

test("email thread: newest first and open, older folded to a line, count in the header", () => {
  const c = emailThread(data(), {});
  assert.equal(c.getAttribute("aria-label"), "Email thread");
  assert.match(text($(c, ".cv-card-head")), /October numbers.*3 messages/);
  const rows = $$(c, ".cv-et-msg");
  assert.equal(rows.length, 3);
  assert.match(text(rows[0]), /Second paragraph/);
  assert.equal($$(c, ".cv-et-folded").length, 2);
  assert.match(text(rows[1]), /Totals attached/);
  assert.equal($(rows[1], "button").getAttribute("aria-expanded"), "false");
});

test("email thread: a folded row opens in place and folds again; the attachment is a file row", async () => {
  const c = emailThread(data(), {});
  await $(c, ".cv-et-folded button").click();
  assert.equal($$(c, ".cv-et-folded").length, 1);
  assert.match(text($(c, ".cv-et-att")), /totals\.xlsx\s*402 KB/);
  await $$(c, ".cv-et-msg")[1].querySelector("button").click();
  assert.equal($$(c, ".cv-et-folded").length, 2);
});

test("email thread: a body is text only, quoted text is folded, and a link opens only through ctx.open", async () => {
  const opened = [];
  const c = emailThread(data(), { open: h => opened.push(h) });
  assert.equal($$(c, "img").length, 0);
  assert.match(everything(c), /<img src=x onerror=boom\(\)>/, "markup stays as words");
  assert.equal($$(c, "a").length, 0, "no anchor to follow");
  assert.doesNotMatch(text($(c, ".cv-et-latest")), /Regards/);
  assert.equal($(c, ".cv-et-qbtn").getAttribute("aria-expanded"), "false");
  await $(c, ".cv-et-qbtn").click();
  assert.match(text($(c, ".cv-et-qtext")), /> Totals attached/);
  await $(c, ".cv-et-link").click();
  assert.deepEqual(opened, ["https://northwind.test/invoice/7"]);
});

test("email thread: Reply and Open in Mail go through ctx.open; only an https link is offered", async () => {
  const opened = [];
  const c = emailThread(data(), { open: h => opened.push(h) });
  await $(c, "[data-act=reply]").click();
  assert.match(opened[0], /^compose:reply\?to=Sam%20Reyes.*&subject=Re%3A%20October%20numbers$/);
  await $(c, "[data-act=mail]").click();
  assert.equal(opened[1], "https://mail.example.test/t/1");
  const d = data(); d.link = "javascript:alert(1)";
  assert.equal($(emailThread(d, {}), "[data-act=mail]"), null);
});

test("email thread: a single message has no count and no folding; loading and error states; update redraws", () => {
  const one = emailThread({ subject: "Hello", messages: [MSGS[1]] }, {});
  assert.doesNotMatch(text($(one, ".cv-card-head")), /message/);
  assert.equal($$(one, ".cv-et-folded").length, 0);
  assert.ok($(emailThread({ subject: "S", loading: true }, {}), ".cv-et-skel"));
  const e = emailThread({ subject: "S", error: true }, { retry() {} });
  assert.match(text(e), /Couldn't read this thread/);
  assert.ok($(e, ".btn"));
  const c = emailThread(data(), {});
  c.update({ subject: "New", messages: MSGS.slice(0, 2) });
  assert.match(text($(c, ".cv-card-head")), /New.*2 messages/);
});

test("email thread: a phone caps the newest message at 12 lines with Show all", async () => {
  const body = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join("\n");
  const c = emailThread({ subject: "Long", messages: [{ from: "sam@northwind.test", at: "2026-09-30T09:00:00Z", body }, { from: "alex@harlow.test", at: "2026-09-29T09:00:00Z", body: "x" }] }, { phone: true });
  assert.doesNotMatch(text(c), /line 13/);
  await $(c, ".cv-et-more").click();
  assert.match(text(c), /line 20/);
});

test("email thread helpers: person and splitQuote", () => {
  assert.deepEqual(person('"Sam Reyes" <sam@northwind.test>'), { name: "Sam Reyes", addr: "sam@northwind.test" });
  assert.deepEqual(person("kit@harlow.test"), { name: "kit", addr: "kit@harlow.test" });
  assert.deepEqual(splitQuote("Hi\n> old"), { text: "Hi", quoted: "> old" });
  assert.equal(splitQuote("plain").quoted, "");
});
