// @ts-check
// comms: delivery (R032-04). Flows orchestrate, Documents generates and files, Comms delivers: an email through the person's own mail account, a text message through their own Twilio account.
// Everything here is outward, so it waits for the person's yes at the Gate with the final words in front of them (one yes for a whole batch to several numbers), and nothing is sent from this
// module until the Gate releases it. Once sent, the message is logged on the client it went to by the daemon's sent-mail log (core/daemon/sent-mail-log.js), email and text alike.
import { normalizePhone } from "../../records/comms/log.js";
import { agentClaim } from "../modules/index.js";
import { httpFetch } from "../../lib/http.js";
import { send as sendThrough, check as checkMessage, LABELS, PROVIDERS } from "./sending/index.js";
import { hold as holdFiles, release as releaseFiles } from "../../lib/connectors/attachments.js";

const obj = (/** @type {any} */ props = {}, /** @type {string[]} */ required = []) => ({ type: "object", properties: props, ...(required.length ? { required } : {}) });
const str = { type: "string" };
const fail = (/** @type {string} */ message, /** @type {string} */ code = "failed", /** @type {any} */ detail) => Object.assign(new Error(message), { code, ...(detail ? { detail } : {}) });
const CALLERS = ["cli", "local", "deck", "capsule", "mobile", "device", "module", "mcp", "harness"];
/** A text message is one Twilio message up to this long (they split it into segments themselves). */
export const SMS_MAX = 1600;
/** The most numbers one yes covers. */
export const SMS_BATCH = 20;
export const SENDER = "comms:sms";
/** The Gate sender for an email a Flow sends through the Space's sending service. */
export const SENDER_SERVICE = "comms:service";
/** The Vault item the sending service is kept in (needs.credentials id sending). */
const SENDING_ITEM = "comms-sending";
const NEXT_STEP = "An owner or an admin adds one in Settings, Connections, Add a sending service (Resend, Mailgun, Postmark, SendGrid or SMTP); then try again.";
const SERVICE_CONTENT = { subject: "string", text: "string (plain text)", html: "string (the same message as HTML)", from: "string (the firm's own address)", replyTo: "string (optional)", cc: "list of addresses (optional)", bcc: "list of addresses (optional)", attachments: "files by reference: path, name, size, sha256, by (optional)" };
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
  const offer = async (name = SENDER, content = CONTENT) => {
    if (offered.has(name)) return;
    const r = await ctx.call("gate.offer", { name, tool: "comms.release", kinds: ["send"], content });
    if (r.error) throw fail(`the Gate did not take the ${name} sender: ${r.error.message}`, "failed");
    offered.add(name);
  };

  /**
   * The Space's sending service, read from its Vault item for this one use: { provider, apiKey, from, domain, ... }. The key is held in this call and goes nowhere but the request to the service.
   * With none connected, or one half-filled, the words say which part and who can fix it.
   */
  const serviceConn = async () => {
    /** @param {string} f @returns {Promise<string>} */
    const field = async f => {
      try { return String(await ctx.vault.fetch(SENDING_ITEM, { field: f })); } catch (e) {
        const m = String(/** @type {any} */ (e)?.message || e);
        if (/locked/i.test(m)) throw fail("the Vault is locked; unlock it to send through the sending service", "locked");
        if (/no item named|is not granted to/i.test(m) && f === "service") throw fail(`This Space has no sending service, so nothing can be emailed from a Flow. ${NEXT_STEP}`, "needs_setup");
        return "";
      }
    };
    const provider = (await field("service")).toLowerCase();
    if (!PROVIDERS.includes(provider)) throw fail(`The sending service is set to ${provider.slice(0, 30) || "nothing"}, which Vyre does not know. ${NEXT_STEP}`, "needs_setup");
    const apiKey = await field("api_key"), from = await field("from");
    if (!apiKey) throw fail(`The sending service has no ${provider === "smtp" ? "password" : "key"}. ${NEXT_STEP}`, "needs_setup");
    if (!from) throw fail(`The sending service has no from address. ${NEXT_STEP}`, "needs_setup");
    const smtpPort = await field("smtp_port");
    return { provider, apiKey, from, domain: await field("domain"), region: await field("region"), smtpHost: await field("smtp_host"), ...(smtpPort ? { smtpPort } : {}), username: await field("username"), security: await field("security") };
  };

  /** The Twilio account, from number and messaging service: the vault item's own plain fields first, config.json (comms.sms) as the older home. */
  const twilioConf = async () => {
    const c = cfg().sms || {};
    /** @param {string} f */
    const f = async f => { try { return String(await ctx.vault.fetch(TWILIO_ITEM, { field: f })).trim(); } catch { return ""; } };
    return { account: (await f("account")) || String(c.account || ""), from: (await f("from")) || String(c.from || ""), service: (await f("service")) || String(c.service || "") };
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
    input: obj({ via: { type: "string", enum: ["email", "sms"] }, to: { anyOf: [str, { type: "array", items: str }] }, subject: str, body: str, cc: { anyOf: [str, { type: "array", items: str }] }, bcc: { anyOf: [str, { type: "array", items: str }] }, attachments: { type: "array", items: { type: "object", properties: { path: str, name: str }, required: ["path"] } }, account: str, why: str }, ["via", "to", "body"]),
    callers: CALLERS,
    run: async (/** @type {any} */ i, /** @type {any} */ meta = {}) => {
      const body = String(i.body ?? "");
      if (!body.trim()) throw fail("there is nothing to say: body is empty", "bad_input");
      if (i.via === "email") {
        const to = (Array.isArray(i.to) ? i.to : String(i.to).split(/[,;]/)).map((/** @type {any} */ x) => String(x).trim()).filter(Boolean);
        const r = await use("mail.send", { to, ...(i.cc ? { cc: i.cc } : {}), ...(i.bcc ? { bcc: i.bcc } : {}), ...(Array.isArray(i.attachments) && i.attachments.length ? { attachments: i.attachments } : {}), subject: String(i.subject ?? ""), body, ...(i.account ? { account: String(i.account) } : {}), ...(i.why ? { why: String(i.why) } : {}), on_behalf: onBehalf(meta) });
        return { ...r, via: "email" };
      }
      if (body.length > SMS_MAX) throw fail(`a text is at most ${SMS_MAX} characters; this one is ${body.length}`, "bad_input");
      const to = numbers(i.to);
      const c = await twilioConf();
      if (!/^AC[0-9a-f]{32}$/i.test(c.account) || !(c.from || c.service)) throw fail("texts need a Twilio account: connect Twilio for Comms in the Vault (Connections) with its account number (starts with AC), the number texts come from and the auth token", "needs_setup");
      await offer();
      const thread = typeof meta.thread === "string" ? meta.thread : undefined;
      const agent = agentClaim(String(meta.caller || "")) || undefined;
      const held = await use("gate.request", { kind: "send", via: SENDER, to, content: { body }, ...(i.why ? { why: String(i.why) } : {}), ...(thread ? { thread } : {}), ...(agent ? { agent } : {}) });
      if (!held || !held.id) throw fail("the Gate did not hold this text, so nothing was sent", "failed");
      ctx.events.emit("comms.held", { id: held.id, via: "sms", count: to.length }, thread ? { thread } : undefined);
      return { held: held.id, via: SENDER, message: `Held at the Gate: a text to ${to.join(", ")} goes out once the person approves it. Nothing was sent.` };
    },
  });

  ctx.tool("comms.email", {
    description: "Send an email from the Space's sending service, held for a person's yes: { to, subject, text or html, replyTo?, from? }.",
    input: obj({ to: { anyOf: [str, { type: "array", items: str }] }, cc: { anyOf: [str, { type: "array", items: str }] }, bcc: { anyOf: [str, { type: "array", items: str }] }, subject: str, text: str, html: str, body: str, replyTo: str, from: str, why: str, attachments: { type: "array", items: { type: "object", properties: { path: str, name: str }, required: ["path"] } } }, ["to"]),
    callers: CALLERS,
    run: async (/** @type {any} */ i, /** @type {any} */ meta = {}) => {
      const conn = await serviceConn();
      const text = i.text ?? (i.html === undefined ? i.body : undefined);
      const m = checkMessage(conn, { to: i.to, cc: i.cc, bcc: i.bcc, subject: i.subject, text, html: i.html, from: i.from, replyTo: i.replyTo });
      // files go by reference: their path, name, size and hash are held with the message (and approved with it); the bytes are read only when it is sent
      const files = await holdFiles(ctx, meta, i.attachments).catch((/** @type {any} */ e) => { throw fail(e.message, e.code || "bad_input"); });
      await offer(SENDER_SERVICE, SERVICE_CONTENT);
      const thread = typeof meta.thread === "string" ? meta.thread : undefined;
      const agent = agentClaim(String(meta.caller || "")) || undefined;
      const content = { subject: m.subject, text: m.text, html: m.html, from: m.from, ...(m.cc ? { cc: m.cc } : {}), ...(m.bcc ? { bcc: m.bcc } : {}), ...(m.replyTo ? { replyTo: m.replyTo } : {}), ...(files.length ? { attachments: files } : {}) };
      const held = await use("gate.request", { kind: "send", via: SENDER_SERVICE, to: m.to, content, ...(i.why ? { why: String(i.why) } : {}), ...(thread ? { thread } : {}), ...(agent ? { agent } : {}) });
      if (!held || !held.id) throw fail("the Gate did not hold this email, so nothing was sent", "failed");
      ctx.events.emit("comms.held", { id: held.id, via: "service", count: m.to.length }, thread ? { thread } : undefined);
      return { held: held.id, via: SENDER_SERVICE, message: `Held at the Gate: an email to ${m.to.join(", ")} goes out through ${(/** @type {any} */ (LABELS))[conn.provider]} once the person approves it. Nothing was sent.` };
    },
  });

  ctx.tool("comms.service.get", {
    description: "Which sending service this Space uses and the address it sends from. Never the key.",
    input: obj(),
    callers: CALLERS,
    run: async (/** @type {any} */ _i, /** @type {any} */ meta = {}) => {
      try {
        // A read: ask the connections list first (it audits nothing), so a Space with no service never reaches a Vault release, which writes an audit row.
        const rows = await use("vault.connections.list", { caller: String(meta.caller || "cli") }).catch(() => null);
        const list = rows ? (Array.isArray(rows) ? rows : rows.connections || []) : null;
        if (list && !list.some((/** @type {any} */ r) => r && (r.ref === SENDING_ITEM || r.provider === "sending-service"))) return { configured: false, next: NEXT_STEP };
        const c = await serviceConn();
        return { configured: true, provider: c.provider, label: (/** @type {any} */ (LABELS))[c.provider], from: c.from, domain: c.domain || String(c.from).replace(/^.*@|>$/g, "") };
      } catch (e) {
        const x = /** @type {any} */ (e);
        if (x.code === "needs_setup") return { configured: false, next: String(x.message) };
        throw e;
      }
    },
  });

  ctx.tool("comms.service.test", {
    description: "Send one test email to the person's own address to prove the sending key works: { to }. Needs their presence.",
    input: obj({ to: str }, ["to"]),
    callers: CALLERS,
    presence: { summary: (/** @type {any} */ i) => `Send a test email to ${String(i && i.to || "your address")} through your sending service` },
    run: async (/** @type {any} */ i) => {
      if (Array.isArray(i.to) || /[,;\s]/.test(String(i.to ?? "").trim())) throw fail("a test goes to one address", "bad_input");
      const conn = await serviceConn();
      const r = await sendThrough(conn, { to: [String(i.to).trim()], subject: "Test from your Vyre sending service", text: "This is a test. Your sending service works, and Flows can now send email through it.", html: "<p>This is a test. Your sending service works, and Flows can now send email through it.</p>" }, { http });
      return { ok: true, provider: r.provider, label: (/** @type {any} */ (LABELS))[r.provider], to: String(i.to).trim(), id: r.id };
    },
  });

  ctx.tool("comms.credentials", {
    description: "The credentials a Flow's Send step can use, by kind (email or sms): names and ids only, never a value.",
    input: obj({ kind: { type: "string", enum: ["email", "sms"] } }, ["kind"]),
    callers: CALLERS,
    run: async (/** @type {any} */ i, /** @type {any} */ meta = {}) => {
      const way = /** @type {Record<string, Record<string, string>>} */ ({
        email: { "sending-service": "comms.email", "imap-smtp": "comms.send", "google-oauth": "comms.send", "google-dwd": "comms.send", "google-apps-script": "comms.send" },
        sms: { twilio: "comms.send" } })[String(i.kind)];
      if (!way) throw fail("kind is email or sms", "bad_input");
      const rows = await use("vault.connections.list", { caller: String(meta.caller || "cli") });
      const list = Array.isArray(rows) ? rows : (rows && rows.connections) || [];
      return { credentials: list.filter((/** @type {any} */ r) => r && Object.hasOwn(way, String(r.provider))).map((/** @type {any} */ r) => ({ id: String(r.id), name: String(r.label || r.ref || r.id), provider: String(r.provider), ...(r.account ? { account: String(r.account) } : {}), step: way[String(r.provider)] })) };
    },
  });

  ctx.tool("comms.release", {
    internal: true,
    description: "The Gate's call once the person approved a held text or email: sends exactly the approved numbers and words through Twilio, one message each, or the approved email through the Space's sending service. Only the Gate.",
    input: obj({ id: str, to: { type: "array", items: str }, content: { type: "object" } }, ["id", "to", "content"]),
    run: async (/** @type {any} */ { id, to, content }, /** @type {any} */ { caller }) => {
      if (caller !== "module:gate") throw fail("only the Gate releases what goes out", "denied");
      const it = await use("gate.get", { id });
      if (!it || it.state !== "sending") throw fail(`${id} is not an approved item being sent`, "denied");
      if (it.via === SENDER_SERVICE) {
        const conn = await serviceConn();
        const c = content && typeof content === "object" ? content : {};
        const attachments = await releaseFiles(ctx, c.attachments).catch((/** @type {any} */ e) => { throw fail(e.message, e.code || "failed"); });
        const r = await sendThrough(conn, { to, cc: c.cc, bcc: c.bcc, ...(attachments.length ? { attachments } : {}), subject: c.subject, text: c.text, html: c.html, from: c.from, replyTo: c.replyTo }, { http, idem: String(id) });
        ctx.events.emit("comms.sent", { id, via: "service", provider: r.provider, sent: to.length, ...(c.cc ? { cc: c.cc.length } : {}), ...(c.bcc ? { bcc: c.bcc.length } : {}), ...(attachments.length ? { files: attachments.map(a => a.filename) } : {}) });
        return { sent: [{ to, id: r.id }], via: r.provider };
      }
      if (it.via !== SENDER) throw fail(`${id} is not a held text`, "denied");
      const dest = numbers(to), body = String(content && content.body || "");
      if (!body.trim() || body.length > SMS_MAX) throw fail("the approved text is empty or too long", "bad_input");
      const c = await twilioConf();
      if (!/^AC[0-9a-f]{32}$/i.test(c.account)) throw fail("texts need the Twilio account number: connect Twilio for Comms in the Vault (Connections)", "needs_setup");
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
