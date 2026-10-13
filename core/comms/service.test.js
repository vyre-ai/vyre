// @ts-check
// Comms over the firm's sending service: a Flow's email is held at the Gate with the final words, goes out only when the Gate releases it, through the service the Space connected, and the key
// never leaves the Vault. The service, the Gate and the Vault are stand-ins; nothing reaches a real provider.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { registerComms, SENDER_SERVICE } from "./index.js";

const KEY = "re_live_THE_SECRET_KEY_9999";
const FIELDS = { service: "resend", api_key: KEY, from: "Harlow Law <hello@harlow.example>", domain: "harlow.example" };
function rig({ fields = /** @type {Record<string, string> | null} */ (FIELDS), held = { id: "gi_9" }, status = 200, answer = /** @type {any} */ ({ id: "re_msg_1" }) } = {}) {
  /** @type {Map<string, any>} */ const tools = new Map();
  /** @type {any[]} */ const calls = [], posted = [], events = [];
  const ctx = { config: {}, log: () => {}, tool: (/** @type {string} */ n, /** @type {any} */ d) => tools.set(n, d),
    events: { emit: (/** @type {string} */ t, /** @type {any} */ p) => events.push([t, p]) },
    vault: { fetch: async (/** @type {string} */ id, /** @type {any} */ o) => { if (id !== "comms-sending" || !fields) throw new Error("no item named sending"); if (!(o.field in fields)) throw new Error("no field " + o.field); return fields[o.field]; } },
    call: async (/** @type {string} */ tool, /** @type {any} */ input) => {
      calls.push([tool, input]);
      if (tool === "gate.offer") return { data: { ok: true } };
      if (tool === "gate.request") return { data: held };
      if (tool === "gate.get") return { data: { state: "sending", via: SENDER_SERVICE } };
      return { error: { code: "no_such_tool", message: tool } };
    } };
  const http = async (/** @type {string} */ url, /** @type {any} */ init) => { posted.push([url, init]); return new Response(JSON.stringify(answer), { status }); };
  registerComms(ctx, { http });
  return { run: (/** @type {string} */ n, /** @type {any} */ i, /** @type {any} */ meta = { caller: "cli" }) => tools.get(n).run(i, meta), calls, posted, events, tools };
}
const fails = (/** @type {Promise<any>} */ p) => p.then(() => null, e => e);

test("a Flow with no sending service refuses in words and names the next step; nothing is held or sent", async () => {
  const r = rig({ fields: null });
  const e = await fails(r.run("comms.email", { to: "dana@northwind-bakery.example", subject: "Hi", text: "Hello" }));
  assert.equal(e.code, "needs_setup");
  assert.match(e.message, /no sending service/i);
  assert.match(e.message, /Settings, Connections, Add a sending service/);
  assert.match(e.message, /owner or an admin/);
  assert.deepEqual(r.calls.map(c => c[0]), []);
  assert.equal(r.posted.length, 0);
});

test("an incomplete service (no key, or no from address) says which part is missing", async () => {
  const noKey = await fails(rig({ fields: { service: "resend", from: "hello@harlow.example" } }).run("comms.email", { to: "a@x.example", text: "Hi" }));
  assert.equal(noKey.code, "needs_setup"); assert.match(noKey.message, /key/);
  const noFrom = await fails(rig({ fields: { service: "resend", api_key: KEY } }).run("comms.email", { to: "a@x.example", text: "Hi" }));
  assert.equal(noFrom.code, "needs_setup"); assert.match(noFrom.message, /from address/);
  assert.ok(!noKey.message.includes(KEY) && !noFrom.message.includes(KEY));
});

test("comms.email holds the final words at the Gate and sends nothing", async () => {
  const r = rig();
  const out = await r.run("comms.email", { to: ["dana@northwind-bakery.example"], subject: "Your hearing moved", html: "<p>Tuesday at 10.</p>", why: "client update" }, { caller: "mcp agent:kit", thread: "t-1" });
  assert.equal(out.held, "gi_9");
  assert.equal(out.via, SENDER_SERVICE);
  assert.match(out.message, /Nothing was sent/);
  assert.deepEqual(r.calls.map(c => c[0]), ["gate.offer", "gate.request"]);
  const [, req] = r.calls[1];
  assert.equal(req.kind, "send"); assert.equal(req.via, SENDER_SERVICE); assert.deepEqual(req.to, ["dana@northwind-bakery.example"]);
  assert.equal(req.content.subject, "Your hearing moved"); assert.equal(req.content.text, "Tuesday at 10."); assert.match(req.content.html, /Tuesday at 10/);
  assert.equal(req.content.from, "Harlow Law <hello@harlow.example>");
  assert.equal(req.thread, "t-1");
  assert.equal(r.posted.length, 0);
  assert.ok(!JSON.stringify(r.calls).includes(KEY), "the key is not in anything handed to the Gate");
  assert.deepEqual(r.events.map(e => e[0]), ["comms.held"]);
});

test("comms.email refuses a bad message before it is held: an address, a from outside the firm's domain, an empty body", async () => {
  const r = rig();
  assert.match((await fails(r.run("comms.email", { to: "nobody", text: "Hi" }))).message, /not an email address/);
  assert.match((await fails(r.run("comms.email", { to: "a@x.example", text: "Hi", from: "ceo@bank.example" }))).message, /harlow\.example/);
  assert.match((await fails(r.run("comms.email", { to: "a@x.example", text: " " }))).message, /nothing to say/);
  assert.equal(r.calls.filter(c => c[0] === "gate.request").length, 0);
});

test("comms.release sends exactly the approved words through the service, only for the Gate", async () => {
  const r = rig();
  const content = { subject: "Your hearing moved", text: "Tuesday at 10.", html: "<p>Tuesday at 10.</p>", from: "Harlow Law <hello@harlow.example>" };
  assert.equal((await fails(r.run("comms.release", { id: "gi_9", to: ["dana@northwind-bakery.example"], content }, { caller: "cli" }))).code, "denied");
  const out = await r.run("comms.release", { id: "gi_9", to: ["dana@northwind-bakery.example"], content }, { caller: "module:gate" });
  assert.equal(r.posted.length, 1);
  const [url, init] = r.posted[0];
  assert.equal(url, "https://api.resend.com/emails");
  assert.equal(init.headers.authorization, `Bearer ${KEY}`);
  const body = JSON.parse(init.body);
  assert.deepEqual([body.to, body.subject, body.text, body.html], [["dana@northwind-bakery.example"], content.subject, content.text, content.html]);
  assert.deepEqual(out, { sent: [{ to: ["dana@northwind-bakery.example"], id: "re_msg_1" }], via: "resend" });
  assert.ok(!JSON.stringify(out).includes(KEY));
  assert.deepEqual(r.events.at(-1), ["comms.sent", { id: "gi_9", via: "service", provider: "resend", sent: 1 }]);
});

test("comms.release says in words what the service refused, without the key", async () => {
  const r = rig({ status: 401, answer: { message: `bad ${KEY}` } });
  const e = await fails(r.run("comms.release", { id: "gi_9", to: ["a@x.example"], content: { subject: "s", text: "t" } }, { caller: "module:gate" }));
  assert.equal(e.code, "auth");
  assert.match(e.message, /refused the key/);
  assert.ok(!e.message.includes(KEY));
});

test("comms.service.get shows which service and from address, and never the key or a field that holds it", async () => {
  const r = rig();
  const out = await r.run("comms.service.get", {}, { caller: "cli" });
  assert.deepEqual(out, { configured: true, provider: "resend", label: "Resend", from: "Harlow Law <hello@harlow.example>", domain: "harlow.example" });
  assert.ok(!JSON.stringify(out).includes(KEY));
  assert.ok(!/key|secret|token|password/i.test(Object.keys(out).join(" ")));
  const none = await rig({ fields: null }).run("comms.service.get", {}, { caller: "cli" });
  assert.equal(none.configured, false);
  assert.match(none.next, /Settings, Connections, Add a sending service/);
});

test("comms.service.test sends one email to the address it is given, from the firm's service, and says so", async () => {
  const r = rig();
  const out = await r.run("comms.service.test", { to: "admin@harlow.example" }, { caller: "cli" });
  assert.equal(r.posted.length, 1);
  const body = JSON.parse(r.posted[0][1].body);
  assert.deepEqual(body.to, ["admin@harlow.example"]);
  assert.match(body.subject, /test/i);
  assert.equal(out.ok, true); assert.equal(out.provider, "resend"); assert.equal(out.to, "admin@harlow.example");
  assert.ok(!JSON.stringify(out).includes(KEY));
  assert.equal((await fails(r.run("comms.service.test", { to: ["a@x.example", "b@x.example"] }, { caller: "cli" }))).code, "bad_input", "one address only");
  assert.equal((await fails(rig({ fields: null }).run("comms.service.test", { to: "a@x.example" }, { caller: "cli" }))).code, "needs_setup");
});

test("the three new tools are registered, comms.service.test asks for the person's presence", () => {
  const r = rig();
  for (const n of ["comms.email", "comms.service.get", "comms.service.test"]) assert.ok(r.tools.has(n), n);
  assert.equal(typeof r.tools.get("comms.service.test").presence?.summary, "function");
  assert.match(r.tools.get("comms.service.test").presence.summary({ to: "admin@harlow.example" }), /admin@harlow\.example/);
});

test("a member cannot reach the key: the three tools are the owner's on the member door, and the vault lets a member into no tool", async () => {
  const { MEMBER_MAY, OWNER_ONLY } = await import("../modules/door-lists.js");
  const { MEMBER_ALLOWED } = await import("../vault/member-gate.js");
  for (const n of ["comms.email", "comms.service.get", "comms.service.test"]) { assert.ok(OWNER_ONLY.has(n), `${n} is owner only`); assert.ok(!MEMBER_MAY.has(n), `${n} is not on a member's list`); }
  for (const n of ["vault.connect", "vault.delete", "vault.get", "vault.reveal"]) assert.ok(!MEMBER_ALLOWED.has(n), `${n} is refused to a member by the vault's own gate`);
});

// ---- SMS from the vault item, and the list a Flow's "Send with" picker shows ----
const SMS_FIELDS = { value: "tok_secret", account: "AC" + "a".repeat(32), from: "+15555550000" };
function smsRig(/** @type {any} */ fields, /** @type {any} */ rows = []) {
  /** @type {Map<string, any>} */ const tools = new Map(); /** @type {any[]} */ const posted = [], calls = [];
  const ctx = { config: {}, log: () => {}, tool: (/** @type {string} */ n, /** @type {any} */ d) => tools.set(n, d), events: { emit: () => {} },
    vault: { fetch: async (/** @type {string} */ id, /** @type {any} */ o) => { if (id !== "comms-twilio" || !fields || !(o.field in fields)) throw new Error("no item named twilio"); return fields[o.field]; } },
    call: async (/** @type {string} */ t, /** @type {any} */ i) => { calls.push([t, i]); if (t === "gate.offer") return { data: {} }; if (t === "gate.request") return { data: { id: "gi_s" } }; if (t === "gate.get") return { data: { state: "sending", via: "comms:sms" } }; if (t === "vault.connections.list") return { data: rows }; return { error: { code: "x", message: t } }; } };
  registerComms(ctx, { http: async (/** @type {string} */ u, /** @type {any} */ init) => { posted.push([u, init]); return new Response(JSON.stringify({ sid: "SM1" }), { status: 201 }); } });
  return { run: (/** @type {string} */ n, /** @type {any} */ i, m = { caller: "cli" }) => tools.get(n).run(i, m), posted, calls };
}

test("a text takes the account and the from number from the Twilio vault item, with no config.json", async () => {
  const r = smsRig(SMS_FIELDS);
  const held = await r.run("comms.send", { via: "sms", to: "+15555550123", body: "Hi" });
  assert.equal(held.held, "gi_s");
  await r.run("comms.release", { id: "gi_s", to: ["+15555550123"], content: { body: "Hi" } }, { caller: "module:gate" });
  assert.match(r.posted[0][0], new RegExp(`Accounts/AC${"a".repeat(32)}/Messages`));
  assert.equal(new URLSearchParams(r.posted[0][1].body).get("From"), "+15555550000");
});

test("a text with no account or from number anywhere says where to put them", async () => {
  const e = await fails(smsRig({ value: "tok" }).run("comms.send", { via: "sms", to: "+15555550123", body: "Hi" }));
  assert.equal(e.code, "needs_setup"); assert.match(e.message, /Twilio/);
});

test("comms.credentials lists the suitable credentials for email and for sms by name and id, never a value", async () => {
  const rows = [
    { id: "cn_1", provider: "sending-service", label: "Harlow Resend", account: "hello@harlow.example", ref: "comms-sending", secret: "LEAK" },
    { id: "cn_2", provider: "imap-smtp", label: "Alex mail", account: "alex@harlow.example", ref: "alex-mail" },
    { id: "cn_3", provider: "twilio", label: "Firm Twilio", account: "", ref: "comms-twilio" },
    { id: "cn_4", provider: "openai", label: "AI", account: "", ref: "oai" },
  ];
  const r = smsRig(SMS_FIELDS, rows);
  const email = await r.run("comms.credentials", { kind: "email" });
  assert.deepEqual(email.credentials.map((/** @type {any} */ c) => [c.id, c.provider, c.step]), [["cn_1", "sending-service", "comms.email"], ["cn_2", "imap-smtp", "comms.send"]]);
  const sms = await r.run("comms.credentials", { kind: "sms" });
  assert.deepEqual(sms.credentials.map((/** @type {any} */ c) => [c.id, c.provider, c.step]), [["cn_3", "twilio", "comms.send"]]);
  assert.ok(!JSON.stringify([email, sms]).includes("LEAK"));
  assert.equal((await fails(r.run("comms.credentials", { kind: "fax" }))).code, "bad_input");
});
