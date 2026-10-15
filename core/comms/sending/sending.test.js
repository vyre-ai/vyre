// @ts-check
// The sending-service senders: one send() over Resend, Mailgun, Postmark, SendGrid and SMTP. Every provider is a fake; nothing here reaches a real service.
import "../../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { PROVIDERS, shape, send, check } from "./index.js";

const KEY = "key_live_NEVER_SHOWN_123";
const msg = { from: "Harlow Law <hello@harlow.example>", to: ["dana@northwind-bakery.example"], subject: "Your appointment", html: "<p>Tuesday at 10.</p>", text: "Tuesday at 10.", replyTo: "front-desk@harlow.example" };
const conn = (/** @type {string} */ provider, extra = {}) => ({ provider, apiKey: KEY, from: "hello@harlow.example", domain: "harlow.example", ...extra });
const json = (/** @type {any} */ r) => JSON.parse(r.body);

test("the five providers are named", () => assert.deepEqual([...PROVIDERS], ["resend", "mailgun", "postmark", "sendgrid", "smtp"]));

test("resend: POST /emails with a bearer key, JSON body, an idempotency key", () => {
  const r = shape(conn("resend"), msg, { idem: "run1:mail" });
  assert.equal(r.url, "https://api.resend.com/emails");
  assert.equal(r.method, "POST");
  assert.equal(r.headers.authorization, `Bearer ${KEY}`);
  assert.equal(r.headers["idempotency-key"], "run1:mail");
  assert.deepEqual(json(r), { from: msg.from, to: msg.to, subject: msg.subject, html: msg.html, text: msg.text, reply_to: msg.replyTo });
});

test("mailgun: form body to /v3/<domain>/messages with basic auth, the EU host when asked", () => {
  const r = shape(conn("mailgun"), msg);
  assert.equal(r.url, "https://api.mailgun.net/v3/harlow.example/messages");
  assert.equal(r.headers.authorization, `Basic ${Buffer.from(`api:${KEY}`).toString("base64")}`);
  assert.match(r.headers["content-type"], /x-www-form-urlencoded/);
  const f = new URLSearchParams(r.body);
  assert.equal(f.get("from"), msg.from); assert.equal(f.get("to"), msg.to[0]); assert.equal(f.get("subject"), msg.subject);
  assert.equal(f.get("html"), msg.html); assert.equal(f.get("text"), msg.text); assert.equal(f.get("h:Reply-To"), msg.replyTo);
  assert.equal(shape(conn("mailgun", { region: "eu" }), msg).url, "https://api.eu.mailgun.net/v3/harlow.example/messages");
});

test("postmark: server token header and the capitalised JSON body", () => {
  const r = shape(conn("postmark"), msg);
  assert.equal(r.url, "https://api.postmarkapp.com/email");
  assert.equal(r.headers["x-postmark-server-token"], KEY);
  assert.equal(r.headers.authorization, undefined);
  assert.deepEqual(json(r), { From: msg.from, To: msg.to[0], Subject: msg.subject, HtmlBody: msg.html, TextBody: msg.text, ReplyTo: msg.replyTo, MessageStream: "outbound" });
});

test("sendgrid: bearer key, personalizations, text part before html part", () => {
  const r = shape(conn("sendgrid"), msg);
  assert.equal(r.url, "https://api.sendgrid.com/v3/mail/send");
  assert.equal(r.headers.authorization, `Bearer ${KEY}`);
  assert.deepEqual(json(r), {
    personalizations: [{ to: [{ email: msg.to[0] }] }], from: { email: "hello@harlow.example", name: "Harlow Law" }, subject: msg.subject,
    content: [{ type: "text/plain", value: msg.text }, { type: "text/html", value: msg.html }], reply_to: { email: msg.replyTo },
  });
});

test("several recipients: each provider takes them in its own shape, at most 50", () => {
  const to = ["a@x.example", "b@x.example"];
  assert.deepEqual(json(shape(conn("resend"), { ...msg, to })).to, to);
  assert.equal(new URLSearchParams(shape(conn("mailgun"), { ...msg, to }).body).get("to"), "a@x.example,b@x.example");
  assert.equal(json(shape(conn("postmark"), { ...msg, to })).To, "a@x.example,b@x.example");
  assert.deepEqual(json(shape(conn("sendgrid"), { ...msg, to })).personalizations[0].to, [{ email: "a@x.example" }, { email: "b@x.example" }]);
  assert.throws(() => check(conn("resend"), { ...msg, to: Array.from({ length: 51 }, (_, i) => `p${i}@x.example`) }), /at most 50/);
});

test("check: a bad address, a header break, an empty body or a from outside the firm's domain is refused in words", () => {
  const c = conn("resend");
  assert.throws(() => check(c, { ...msg, to: ["not an address"] }), /not an email address/);
  assert.throws(() => check(c, { ...msg, to: [] }), /who to send to/);
  assert.throws(() => check(c, { ...msg, subject: "hi\r\nBcc: boss@evil.example" }), /one line/);
  assert.throws(() => check(c, { ...msg, replyTo: "a@x.example\nBcc: b@x.example" }), /not an email address/);
  assert.throws(() => check(c, { ...msg, html: undefined, text: "  " }), /nothing to say/);
  assert.throws(() => check(c, { ...msg, from: "ceo@bank.example" }), /harlow\.example/);
  assert.equal(check(c, { ...msg, from: undefined }).from, "hello@harlow.example");
  assert.equal(check(c, { ...msg, from: "Front Desk <desk@harlow.example>" }).from, "Front Desk <desk@harlow.example>");
});

test("text only or html only: the other part is made, never left empty", () => {
  assert.equal(json(shape(conn("resend"), { ...msg, text: undefined })).text, "Tuesday at 10.");
  assert.match(json(shape(conn("resend"), { ...msg, html: undefined })).html, /Tuesday at 10\./);
  assert.equal(check(conn("resend"), { ...msg, html: "<p>a &amp; b</p><script>x()</script>", text: undefined }).text, "a & b");
});

/** @param {number} status @param {any} body @param {Record<string,string>} [headers] */
const answer = (status, body, headers = {}) => async (/** @type {string} */ _u, /** @type {any} */ init) => { answer.last = init; return new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers }); };
/** @type {any} */ answer.last = null;

test("send: each provider's good answer becomes { id, provider } and the key rides only in the request", async () => {
  assert.deepEqual(await send(conn("resend"), msg, { http: answer(200, { id: "re_1" }) }), { id: "re_1", provider: "resend" });
  assert.deepEqual(await send(conn("mailgun"), msg, { http: answer(200, { id: "<mg.1@harlow.example>", message: "Queued. Thank you." }) }), { id: "<mg.1@harlow.example>", provider: "mailgun" });
  assert.deepEqual(await send(conn("postmark"), msg, { http: answer(200, { MessageID: "pm-1", ErrorCode: 0 }) }), { id: "pm-1", provider: "postmark" });
  assert.deepEqual(await send(conn("sendgrid"), msg, { http: answer(202, "", { "x-message-id": "sg-1" }) }), { id: "sg-1", provider: "sendgrid" });
});

test("send: a refusal says what happened and what to do, never the key", async () => {
  for (const p of ["resend", "mailgun", "postmark", "sendgrid"]) {
    const e = await send(conn(p), msg, { http: answer(401, { message: `bad key ${KEY}` }) }).then(() => null, x => x);
    assert.equal(e.code, "auth", p);
    assert.match(e.message, /refused the key/);
    assert.match(e.message, /Settings, Connections/);
    assert.ok(!e.message.includes(KEY), p);
  }
  const r429 = await send(conn("resend"), msg, { http: answer(429, { message: "slow down" }) }).then(() => null, x => x);
  assert.equal(r429.code, "rate");
  const bad = await send(conn("postmark"), msg, { http: answer(422, { ErrorCode: 406, Message: `inactive recipient ${KEY}` }) }).then(() => null, x => x);
  assert.equal(bad.code, "refused");
  assert.match(bad.message, /inactive recipient/);
  assert.ok(!bad.message.includes(KEY));
  const down = await send(conn("sendgrid"), msg, { http: async () => { throw new Error(`connect failed ${KEY}`); } }).then(() => null, x => x);
  assert.equal(down.code, "network");
  assert.ok(!down.message.includes(KEY));
});

test("send: postmark answers 200 with an ErrorCode when it refuses; that is a failure", async () => {
  const e = await send(conn("postmark"), msg, { http: answer(200, { ErrorCode: 300, Message: "Invalid email request" }) }).then(() => null, x => x);
  assert.equal(e.code, "refused");
});

test("smtp: hands the message to the SMTP adapter with the saved login and the plain text", async () => {
  /** @type {any[]} */ const calls = [];
  const smtp = { send: async (/** @type {any} */ cfg, /** @type {any} */ pw, /** @type {any} */ c) => { calls.push([cfg, await pw(), c]); return { message_id: "<m1@harlow.example>" }; } };
  const c = { provider: "smtp", from: "hello@harlow.example", domain: "harlow.example", smtpHost: "smtp.harlow.example", smtpPort: 587, security: "starttls", username: "hello", apiKey: KEY };
  assert.deepEqual(await send(c, msg, { smtp }), { id: "<m1@harlow.example>", provider: "smtp" });
  assert.equal(calls[0][0].smtp.host, "smtp.harlow.example");
  assert.equal(calls[0][0].smtp.tls, "starttls");
  assert.equal(calls[0][0].address, "hello@harlow.example");
  assert.equal(calls[0][1], KEY);
  assert.deepEqual(calls[0][2].to, msg.to);
  assert.equal(calls[0][2].body, "Tuesday at 10.");
});

test("an unknown provider is refused by name", () => {
  assert.throws(() => shape({ provider: "carrier-pigeon", apiKey: KEY, from: "a@b.example" }, msg), /not a sending service Vyre knows/);
});

test("cc and bcc: each provider takes them in its own shape, they count toward the 50, and a bad one is refused by name", async () => {
  const m = { ...msg, cc: ["ops@northwind-bakery.example"], bcc: ["alex@harlow.example", "juno@harlow.example"] };
  assert.deepEqual([json(shape(conn("resend"), m)).cc, json(shape(conn("resend"), m)).bcc], [m.cc, m.bcc]);
  const f = new URLSearchParams(shape(conn("mailgun"), m).body);
  assert.deepEqual([f.get("cc"), f.get("bcc")], ["ops@northwind-bakery.example", "alex@harlow.example,juno@harlow.example"]);
  const p = json(shape(conn("postmark"), m));
  assert.deepEqual([p.Cc, p.Bcc], ["ops@northwind-bakery.example", "alex@harlow.example,juno@harlow.example"]);
  const s = json(shape(conn("sendgrid"), m)).personalizations[0];
  assert.deepEqual([s.cc, s.bcc], [[{ email: "ops@northwind-bakery.example" }], [{ email: "alex@harlow.example" }, { email: "juno@harlow.example" }]]);
  assert.equal(json(shape(conn("resend"), msg)).cc, undefined, "none given, none sent");
  assert.throws(() => check(conn("resend"), { ...msg, cc: ["not an address"] }), /not an email address/);
  assert.throws(() => check(conn("resend"), { ...msg, to: Array.from({ length: 30 }, (_, i) => `a${i}@x.example`), bcc: Array.from({ length: 30 }, (_, i) => `b${i}@x.example`) }), /at most 50/);
  /** @type {any} */ let seen;
  await send(conn("smtp", { smtpHost: "smtp.harlow.example" }), m, { smtp: { send: async (_c, _p, c) => { seen = c; return { message_id: "<1@x>" }; } } });
  assert.deepEqual([seen.cc, seen.bcc], [m.cc, m.bcc], "SMTP carries them too");
});

test("files: Resend, Postmark and SendGrid carry them as base64 in their own shape, SMTP hands them to the adapter, and Mailgun says it cannot", async () => {
  const files = [{ filename: "week1.pdf", contentType: "application/pdf", bytes: Buffer.from("PDF-1") }];
  const b64 = Buffer.from("PDF-1").toString("base64");
  const m = { ...msg, attachments: files };
  assert.deepEqual(json(shape(conn("resend"), m)).attachments, [{ filename: "week1.pdf", content: b64 }]);
  assert.deepEqual(json(shape(conn("postmark"), m)).Attachments, [{ Name: "week1.pdf", Content: b64, ContentType: "application/pdf" }]);
  assert.deepEqual(json(shape(conn("sendgrid"), m)).attachments, [{ content: b64, filename: "week1.pdf", type: "application/pdf", disposition: "attachment" }]);
  assert.throws(() => shape(conn("mailgun"), m), /Mailgun cannot carry files/);
  assert.equal(json(shape(conn("resend"), msg)).attachments, undefined, "none given, none sent");
  /** @type {any} */ let seen;
  await send(conn("smtp", { smtpHost: "smtp.harlow.example" }), m, { smtp: { send: async (_c, _p, c) => { seen = c; return { message_id: "<1@x>" }; } } });
  assert.equal(seen.attachments[0].filename, "week1.pdf");
});
