// @ts-check
// comms: delivery (R032-04). Flows orchestrate, Documents generates and files, Comms delivers: an email through the person's own mail account, a text message through their own Twilio account.
// Everything here is outward, so it waits for the person's yes at the Gate with the final words in front of them (one yes for a whole batch to several numbers), and nothing is sent from this
// module until the Gate releases it. Once sent, the message is logged on the client it went to by the daemon's sent-mail log (core/daemon/sent-mail-log.js), email and text alike.
import { normalizePhone } from "../../records/comms/log.js";
import { agentClaim } from "../modules/index.js";
import { httpFetch } from "../../lib/http.js";

const obj = (/** @type {any} */ props = {}, /** @type {string[]} */ required = []) => ({ type: "object", properties: props, ...(required.length ? { required } : {}) });
const str = { type: "string" };
const fail = (/** @type {string} */ message, /** @type {string} */ code = "failed", /** @type {any} */ detail) => Object.assign(new Error(message), { code, ...(detail ? { detail } : {}) });
const CALLERS = ["cli", "local", "deck", "capsule", "mobile", "device", "module", "mcp", "harness"];
/** A text message is one Twilio message up to this long (they split it into segments themselves). */
export const SMS_MAX = 1600;
/** The most numbers one yes covers. */
export const SMS_BATCH = 20;
export const SENDER = "comms:sms";
/** The Vault item the Twilio need is kept in (needs.credentials id twilio, as the Vault names a module's single need). */
const TWILIO_ITEM = "comms-twilio";
const CONTENT = { body: "string (the text)" };

/** E.164 numbers from what was given, each once; a number that is not one is refused by name. @param {unknown} to */
export function numbers(to) {
  const list = (Array.isArray(to) ? to : typeof to === "string" ? to.split(/[,;]/) : []).map(x => String(x).trim()).filter(Boolean);
  if (!list.length) throw fail("say who to text: to is a phone number with its country code, such as +15555550123", "bad_input");
  const out = [];
  for (const raw of list) {
    const n = normalizePhone(raw);
    if (!/^\+[1-9]\d{7,14}$/.test(n)) throw fail(`${raw.slice(0, 30)} is not a phone number with its country code (such as +15555550123)`, "bad_input");
    if (!out.includes(n)) out.push(n);
  }
  if (out.length > SMS_BATCH) throw fail(`one yes covers at most ${SMS_BATCH} numbers`, "bad_input");
  return out;
}

/** @param {any} ctx @param {{ http?: typeof httpFetch }} [o] `http`: the guarded client (lib/http.js); a test hands in its own */
export function registerComms(ctx, o = {}) {
  const http = o.http || httpFetch;
  const cfg = () => (ctx.config && ctx.config.comms) || {};
  const use = async (/** @type {string} */ tool, /** @type {any} */ input) => {
    const r = await ctx.call(tool, input);
    if (r.error) throw fail(r.error.message, r.error.code || "failed", r.error.detail);
    return r.data;
  };
  const offered = new Set();
  const offer = async () => {
    if (offered.has(SENDER)) return;
    const r = await ctx.call("gate.offer", { name: SENDER, tool: "comms.release", kinds: ["send"], content: CONTENT });
    if (r.error) throw fail(`the Gate did not take the ${SENDER} sender: ${r.error.message}`, "failed");
    offered.add(SENDER);
  };

  /** Where a held item is filed: the chat or agent that asked, as mail files its own. @param {any} meta */
  const onBehalf = meta => {
    const agent = agentClaim(String(meta.caller || "")) || (typeof meta.agent === "string" ? meta.agent : "");
    if (meta.thread) return { surface: "chat", thread: String(meta.thread), ...(agent ? { agent } : {}) };
    if (agent) return { surface: "agent", agent };
    return { surface: "capsule" };
  };

  ctx.tool("comms.send", {
    description: "Send an email or text as the person, held at the Gate for their yes: { via: email | sms, to, body, subject? }.",
    input: obj({ via: { type: "string", enum: ["email", "sms"] }, to: { anyOf: [str, { type: "array", items: str }] }, subject: str, body: str, account: str, why: str }, ["via", "to", "body"]),
    callers: CALLERS,
    run: async (/** @type {any} */ i, /** @type {any} */ meta = {}) => {
      const body = String(i.body ?? "");
      if (!body.trim()) throw fail("there is nothing to say: body is empty", "bad_input");
      if (i.via === "email") {
        const to = (Array.isArray(i.to) ? i.to : String(i.to).split(/[,;]/)).map((/** @type {any} */ x) => String(x).trim()).filter(Boolean);
        const r = await use("mail.send", { to, subject: String(i.subject ?? ""), body, ...(i.account ? { account: String(i.account) } : {}), ...(i.why ? { why: String(i.why) } : {}), on_behalf: onBehalf(meta) });
        return { ...r, via: "email" };
      }
      if (body.length > SMS_MAX) throw fail(`a text is at most ${SMS_MAX} characters; this one is ${body.length}`, "bad_input");
      const to = numbers(i.to);
      const c = cfg().sms || {};
      if (!/^AC[0-9a-f]{32}$/i.test(String(c.account || "")) || !(c.from || c.service)) throw fail("texts need a Twilio account: set comms.sms in config.json to { account: \"AC…\", from: \"+1…\" } and connect your Twilio key in the Vault", "needs_setup");
      await offer();
      const thread = typeof meta.thread === "string" ? meta.thread : undefined;
      const agent = agentClaim(String(meta.caller || "")) || undefined;
      const held = await use("gate.request", { kind: "send", via: SENDER, to, content: { body }, ...(i.why ? { why: String(i.why) } : {}), ...(thread ? { thread } : {}), ...(agent ? { agent } : {}) });
      if (!held || !held.id) throw fail("the Gate did not hold this text, so nothing was sent", "failed");
      ctx.events.emit("comms.held", { id: held.id, via: "sms", count: to.length }, thread ? { thread } : undefined);
      return { held: held.id, via: SENDER, message: `Held at the Gate: a text to ${to.join(", ")} goes out once the person approves it. Nothing was sent.` };
    },
  });

  ctx.tool("comms.release", {
    internal: true,
    description: "The Gate's call once the person approved a held text: sends exactly the approved numbers and words through Twilio, one message each. Only the Gate.",
    input: obj({ id: str, to: { type: "array", items: str }, content: { type: "object" } }, ["id", "to", "content"]),
    run: async (/** @type {any} */ { id, to, content }, /** @type {any} */ { caller }) => {
      if (caller !== "module:gate") throw fail("only the Gate releases what goes out", "denied");
      const it = await use("gate.get", { id });
      if (!it || it.state !== "sending") throw fail(`${id} is not an approved item being sent`, "denied");
      if (it.via !== SENDER) throw fail(`${id} is not a held text`, "denied");
      const dest = numbers(to), body = String(content && content.body || "");
      if (!body.trim() || body.length > SMS_MAX) throw fail("the approved text is empty or too long", "bad_input");
      const c = cfg().sms || {};
      if (!/^AC[0-9a-f]{32}$/i.test(String(c.account || ""))) throw fail("texts need comms.sms.account in config.json", "needs_setup");
      // The Twilio key is the person's own item in the Vault, named twilio and handed to Comms: its `value` is the auth token (or an API key's secret, with that key's id in `sid`). It is held for this send only.
      /** @type {string} */ let auth;
      try {
        const secret = String(await ctx.vault.fetch(TWILIO_ITEM, { field: "value" }));
        let user = String(c.account);
        try { const sid = String(await ctx.vault.fetch(TWILIO_ITEM, { field: "sid" })); if (/^SK[0-9a-f]{32}$/i.test(sid)) user = sid; } catch { /* an auth token: the account is the user */ }
        auth = `Basic ${Buffer.from(`${user}:${secret}`).toString("base64")}`;
      } catch { throw fail("texts need your Twilio auth token in the Vault: open Vault, Connections, connect Twilio for Comms and paste the token", "needs_setup"); }
      /** @type {{ to: string, sid?: string, error?: string }[]} */ const results = [];
      for (const n of dest) {
        const form = new URLSearchParams({ To: n, Body: body, ...(c.service ? { MessagingServiceSid: String(c.service) } : { From: String(c.from) }) }).toString();
        try {
          const r = await http(`https://api.twilio.com/2010-04-01/Accounts/${String(c.account)}/Messages.json`, { method: "POST", headers: { authorization: auth, "content-type": "application/x-www-form-urlencoded", accept: "application/json" }, body: form, timeoutMs: 20_000, maxBytes: 256 * 1024 });
          const data = /** @type {any} */ (await r.json().catch(() => ({})));
          if (!r.ok) throw fail(String(data && data.message || `Twilio answered ${r.status}`), "failed");
          results.push({ to: n, sid: String(data && data.sid || "") });
        } catch (e) { results.push({ to: n, error: String(/** @type {Error} */ (e).message || e).slice(0, 160) }); }
      }
      const sent = results.filter(r => r.sid !== undefined);
      if (!sent.length) throw fail(`no text went out: ${results[0].error}`, "failed");
      ctx.events.emit("comms.sent", { id, via: "sms", sent: sent.length, failed: results.length - sent.length });
      return { sent, failed: results.filter(r => r.error) };
    },
  });
}

/** @type {{ start(ctx: any): Promise<{ stop(): Promise<void> }> }} */
export default { async start(ctx) { registerComms(ctx); return { async stop() {} }; } };
