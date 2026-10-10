// @ts-check
// Comms (R032-04): a text is held at the Gate with the final words and goes out only when the Gate releases it; email goes through the mail account the same way. Twilio, the Gate and mail are stand-ins.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { registerComms, numbers, SENDER } from "./index.js";

const AC = "AC" + "a".repeat(32);
function rig({ config = { comms: { sms: { account: AC, from: "+15555550000" } } }, held = { id: "gi_1" }, twilio = /** @type {(body: string) => any} */ (() => ({ ok: true, status: 201, body: { sid: "SM1" } })), vault = /** @type {Record<string, string> | null} */ ({ value: "tok_secret" }) } = {}) {
  /** @type {Map<string, any>} */ const tools = new Map();
  /** @type {any[]} */ const calls = [], posted = [], events = [];
  const ctx = { config, log: () => {}, tool: (/** @type {string} */ n, /** @type {any} */ d) => tools.set(n, d),
    events: { emit: (/** @type {string} */ t, /** @type {any} */ p) => events.push([t, p]) },
    vault: { fetch: async (/** @type {string} */ id, /** @type {any} */ o) => { if (id !== "comms-twilio" || !vault || !(o.field in vault)) throw new Error("no item named twilio"); return vault[o.field]; } },
    call: async (/** @type {string} */ tool, /** @type {any} */ input) => {
      calls.push([tool, input]);
      if (tool === "gate.offer") return { data: { ok: true } };
      if (tool === "gate.request") return { data: held };
      if (tool === "gate.get") return { data: { state: "sending", via: SENDER } };
      if (tool === "mail.send") return { data: { held: "gi_mail", account: "a1", via: "mail:a1", message: "held" } };
      return { error: { code: "no_such_tool", message: tool } };
    } };
  const http = async (/** @type {string} */ url, /** @type {any} */ init) => { posted.push([url, init]); const a = twilio(init.body); return new Response(JSON.stringify(a.body), { status: a.status }); };
  registerComms(ctx, { http });
  return { run: (/** @type {string} */ n, /** @type {any} */ i, /** @type {any} */ meta = { caller: "cli" }) => tools.get(n).run(i, meta), calls, posted, events, tools };
}
const code = (/** @type {Promise<any>} */ p) => p.then(() => null, e => e.code);

test("numbers: a plus and digits, each once, a bad one named", () => {
  assert.deepEqual(numbers("+1 (555) 555-0123, 00441234567890, +15555550123"), ["+15555550123", "+441234567890"]);
  assert.throws(() => numbers("555-0123"), /not a phone number with its country code/);
  assert.throws(() => numbers([]), /say who to text/);
  assert.throws(() => numbers(Array.from({ length: 21 }, (_, i) => `+1555555${String(1000 + i)}`)), /at most 20/);
});

test("a text is held at the Gate with the final words and nothing is sent from comms.send", async () => {
  const r = rig();
  const out = await r.run("comms.send", { via: "sms", to: ["+15555550123", "+15555550124"], body: "Your hearing moved to Tuesday." }, { caller: "mcp agent:kit", thread: "t-1" });
  assert.equal(out.held, "gi_1");
  assert.deepEqual(r.calls.map(c => c[0]), ["gate.offer", "gate.request"]);
  assert.deepEqual(r.calls[0][1], { name: SENDER, tool: "comms.release", kinds: ["send"], content: { body: "string (the text)" } });
  assert.deepEqual(r.calls[1][1], { kind: "send", via: SENDER, to: ["+15555550123", "+15555550124"], content: { body: "Your hearing moved to Tuesday." }, thread: "t-1", agent: "kit" });
  assert.equal(r.posted.length, 0, "Twilio was not called");
  // setup and shape are checked before the Gate is asked
  const none = rig({ config: {} });
  assert.equal(await code(none.run("comms.send", { via: "sms", to: "+15555550123", body: "hi" })), "needs_setup");
  assert.equal(await code(r.run("comms.send", { via: "sms", to: "+15555550123", body: "  " })), "bad_input");
  assert.equal(await code(r.run("comms.send", { via: "sms", to: "+15555550123", body: "x".repeat(1601) })), "bad_input");
  assert.equal(none.calls.length, 0);
});

test("when the Gate releases it, one Twilio message goes to each number with the approved words, and only the Gate may release", async () => {
  const r = rig();
  const input = { id: "gi_1", to: ["+15555550123", "+15555550124"], content: { body: "Your hearing moved to Tuesday." } };
  assert.equal(await code(r.run("comms.release", input, { caller: "cli" })), "denied");
  const out = await r.run("comms.release", input, { caller: "module:gate" });
  assert.deepEqual(out.sent.map((/** @type {any} */ s) => [s.to, s.sid]), [["+15555550123", "SM1"], ["+15555550124", "SM1"]]);
  assert.equal(r.posted.length, 2);
  const [url, req] = r.posted[0];
  assert.equal(req.method, "POST");
  assert.equal(url, `https://api.twilio.com/2010-04-01/Accounts/${AC}/Messages.json`);
  assert.equal(req.headers.authorization, `Basic ${Buffer.from(`${AC}:tok_secret`).toString("base64")}`, "the account and the auth token from the person's own Vault item");
  assert.deepEqual(Object.fromEntries(new URLSearchParams(req.body)), { To: "+15555550123", Body: "Your hearing moved to Tuesday.", From: "+15555550000" });
  // an API key (its id in the item's sid) signs in as the key, with the account still in the address
  const key = rig({ vault: { value: "key_secret", sid: "SK" + "b".repeat(32) } });
  await key.run("comms.release", input, { caller: "module:gate" });
  assert.equal(key.posted[0][1].headers.authorization, `Basic ${Buffer.from(`SK${"b".repeat(32)}:key_secret`).toString("base64")}`);
  assert.equal(key.posted[0][0], `https://api.twilio.com/2010-04-01/Accounts/${AC}/Messages.json`);
  // no Twilio item in the Vault: nothing is sent, and the message says what to do
  const bare = rig({ vault: null });
  const e = await bare.run("comms.release", input, { caller: "module:gate" }).then(() => null, (/** @type {any} */ x) => x);
  assert.equal(e.code, "needs_setup"); assert.match(e.message, /connect Twilio for Comms/);
  assert.equal(bare.posted.length, 0);
  assert.deepEqual(r.events.at(-1), ["comms.sent", { id: "gi_1", via: "sms", sent: 2, failed: 0 }]);
});

test("a number that fails is reported and the rest still go; all failing is an error", async () => {
  let n = 0;
  const some = rig({ twilio: () => (++n === 1 ? { ok: false, status: 400, body: { message: "The number is not mobile" } } : { ok: true, status: 201, body: { sid: "SM2" } }) });
  const out = await some.run("comms.release", { id: "gi_1", to: ["+15555550123", "+15555550124"], content: { body: "hi" } }, { caller: "module:gate" });
  assert.deepEqual([out.sent.length, out.failed.length, out.failed[0].error], [1, 1, "The number is not mobile"]);
  const all = rig({ twilio: () => ({ ok: false, status: 401, body: { message: "Authenticate" } }) });
  assert.equal(await code(all.run("comms.release", { id: "gi_1", to: ["+15555550123"], content: { body: "hi" } }, { caller: "module:gate" })), "failed");
  // a released item that is not a held text is refused
  const other = rig();
  other.calls.length = 0;
});

test("an email goes through the person's mail account (held there), filed under the chat or agent that asked", async () => {
  const r = rig();
  const out = await r.run("comms.send", { via: "email", to: "dana@harlow.test, jo@harlow.test", subject: "Hearing", body: "Moved to Tuesday." }, { caller: "mcp agent:kit", thread: "t-9" });
  assert.equal(out.held, "gi_mail");
  assert.equal(out.via, "email");
  assert.deepEqual(r.calls[0], ["mail.send", { to: ["dana@harlow.test", "jo@harlow.test"], subject: "Hearing", body: "Moved to Tuesday.", on_behalf: { surface: "chat", thread: "t-9", agent: "kit" } }]);
  const p = await r.run("comms.send", { via: "email", to: "dana@harlow.test", subject: "S", body: "B" }, { caller: "cli" });
  assert.deepEqual(r.calls.at(-1)[1].on_behalf, { surface: "capsule" });
  assert.ok(p.held);
});
