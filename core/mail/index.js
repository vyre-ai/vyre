// @ts-check
// mail: any mailbox over IMAP and SMTP (ADR 0028 decision 9c), for the accounts Google does not
// cover. No new dependency: smtp.js and imap.js speak the protocols over node:net and node:tls.
//
// An account is a vault env-set item whose details.provider is "imap-smtp", granted to mail, with
// the fields imap_host, imap_port, smtp_host, smtp_port, username, password and security ("tls"
// or "starttls"), as the provider catalog lists them; `from` is optional (the username, when that
// is an address), and so is tls_ca (a PEM certificate to trust, for a server with its
// own CA). Tools name the account by that item's name. Nothing runs in the background: every call
// connects, does its one thing and logs out.
//
// Before it acts on an account, the module asks the vault whether this caller's surface may use
// that connection (vault.connections.allowed), and refuses unless the answer is yes; a missing or
// failing check refuses too. A send is then always held at the Gate as mail:<account>, and the
// Gate calls mail.release with exactly what the person approved. Every result and error is
// scrubbed of the password, and events carry names only.

import { Imap } from "./imap.js";
import { readMessage } from "./mime.js";
import * as smtp from "./smtp.js";

const str = { type: "string" };
const int = { type: "integer" };
const emails = { anyOf: [str, { type: "array", items: str }], description: "an address, a comma list, or a list" };
const obj = (properties, required = []) => ({ type: "object", properties, required });
const PEOPLE = ["cli", "local", "deck", "capsule", "module"];
const account = { type: "string", description: "the account's vault item name, from mail.accounts" };
const PROVIDER = "imap-smtp";
const FIELDS = ["imap_host", "imap_port", "smtp_host", "smtp_port", "username", "password", "security"];
const OPTIONAL = ["from", "tls_ca"];

/** What a held item of a mail:<account> sender carries, for gate.senders. */
const CONTENT = {
  subject: "string", body: "string, plain text", cc: "email[]?",
  in_reply_to: "Message-ID? (a reply)", references: "Message-IDs? (a reply)",
};

const clamp = (v, lo, hi, dflt) => (Number.isInteger(v) ? Math.min(hi, Math.max(lo, v)) : dflt);
const named = v => (typeof v === "string" && v ? v : undefined);
const fail = (msg, code = "bad_input") => Object.assign(new Error(msg), { code });

/** An address, a comma list or a list, as a checked list. @param {unknown} v @param {string} what */
function addresses(v, what) {
  const list = (Array.isArray(v) ? v : v === undefined || v === null ? [] : String(v).split(","))
    .map(a => String(a).trim()).filter(Boolean)
    .map(a => /<([^<>]+)>\s*$/.exec(a)?.[1] || a);
  for (const a of list) {
    if (/[\r\n]/.test(a)) throw fail(`${what} has a line break in it, which could add headers; refused`);
    if (!smtp.EMAIL.test(a)) throw fail(`${a} in ${what} is not an email address`);
  }
  return list;
}

/** A message id from mail.search: "<mailbox>/<uid>". @param {string} id */
function parseId(id) {
  const m = /^(.+)\/(\d{1,10})$/.exec(String(id || ""));
  if (!m) throw fail("id is a message id from mail.search, such as INBOX/42");
  return { mailbox: m[1], uid: Number(m[2]) };
}

/**
 * May this caller use this connection? The vault's answer, and nothing else: a missing tool or
 * any error is a no. One place, so every tool asks the same way.
 * @param {(tool: string, input: any) => Promise<any>} call @param {string} ref @param {string} caller
 */
export async function allowed(call, ref, caller) {
  let r;
  try { r = await call("vault.connections.allowed", { source: "vault", ref, caller: String(caller || "") }); } catch (e) {
    r = { error: { message: String(/** @type {any} */ (e)?.message || e) } };
  }
  if (r && r.error) {
    throw fail(r.error.code === "no_such_tool"
      ? `the vault cannot say whether this surface may use ${ref} (vault.connections.allowed is not running), so nothing was done`
      : `could not check whether this surface may use ${ref}: ${r.error.message}`, "denied");
  }
  if (!r || !r.data || r.data.allowed !== true) throw fail(`${ref} is not granted to this surface; grant it in Vault, Connections`, "denied");
}

/** @type {{ start(ctx: any): Promise<{ stop(): Promise<void> }> }} */
export default {
  async start(ctx) {
    /** Every password (and its encodings on the wire) this module has fetched, never to leave. */
    const secrets = new Set();
    const scrub = s => {
      let out = String(s);
      for (const v of secrets) if (v && out.includes(v)) out = out.split(v).join("[redacted]");
      return out;
    };
    const scrubAll = v => {
      if (typeof v === "string") return scrub(v);
      if (Array.isArray(v)) return v.map(scrubAll);
      if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, scrubAll(x)]));
      return v;
    };
    const safe = fn => async (input, meta) => {
      try { return scrubAll(await fn(input, meta || {})); } catch (e) {
        const err = /** @type {any} */ (e);
        throw Object.assign(new Error(scrub(String(err?.message || err))), { code: typeof err?.code === "string" ? err.code : "failed" });
      }
    };

    /** The vault's items that are mail accounts. Names, fields and grants; never a value. */
    async function listed() {
      const r = await ctx.call("vault.list", { kind: "env-set" });
      if (r.error) throw fail(`the vault could not list its items: ${r.error.message}`, r.error.code || "vault");
      return (r.data?.items || []).filter(i => i.kind === "env-set" && i.details?.provider === PROVIDER);
    }
    const granted = item => (item.grants || []).some(g => g.module === "mail" && !g.watcher);

    /** One account's settings from the vault, checked. The password goes into the scrub set first. */
    async function settings(name) {
      const item = (await listed()).find(i => i.name === name);
      if (!item) throw fail(`no mail account named ${name}; mail.accounts lists them`, "no_account");
      const missing = FIELDS.filter(f => !(item.fields || []).includes(f));
      if (missing.length) throw fail(`${name} has no ${missing.join(", ")}; a mail account needs ${FIELDS.join(", ")}`);
      if (!granted(item)) throw fail(`${name} is not granted to mail · vyre vault grant ${name} mail`, "not_granted");
      const v = {};
      for (const f of [...FIELDS, ...OPTIONAL.filter(o => (item.fields || []).includes(o))]) {
        v[f] = String(await ctx.vault.fetch(name, { field: f }) ?? "");
        if (f === "password") {
          secrets.add(v.password);
          secrets.add(Buffer.from(v.password, "utf8").toString("base64"));
        }
      }
      secrets.add(Buffer.from(`\0${v.username}\0${v.password}`, "utf8").toString("base64"));
      const port = (k, dflt) => {
        const n = v[k] === "" ? dflt : Number(v[k]);
        if (!Number.isInteger(n) || n < 1 || n > 65535) throw fail(`${name}: ${k} must be a port number`);
        return n;
      };
      const security = String(v.security).trim().toLowerCase();
      if (security !== "tls" && security !== "starttls") throw fail(`${name}: security must be tls or starttls`);
      const from = String(v.from || v.username).trim();
      if (!smtp.EMAIL.test(from)) throw fail(`${name}: from must be an email address (it defaults to the username)`);
      const tls = /** @type {"tls"|"starttls"} */ (security);
      const common = { security: tls, username: v.username, password: v.password, ...(v.tls_ca ? { ca: v.tls_ca } : {}) };
      return {
        name, from,
        imap: { host: v.imap_host.trim(), port: port("imap_port", tls === "tls" ? 993 : 143), ...common },
        smtp: { host: v.smtp_host.trim(), port: port("smtp_port", tls === "tls" ? 465 : 587), ...common },
      };
    }

    /** Check the caller, then load the account. */
    async function use(name, meta) {
      if (!named(name)) throw fail("name the account (mail.accounts lists them)");
      await allowed((t, i) => ctx.call(t, i), name, meta.caller);
      return settings(name);
    }

    /** Open IMAP, run fn, always log out. */
    async function withImap(acct, fn) {
      const c = await Imap.open(acct.imap);
      try { return await fn(c); } finally { await c.logout(); }
    }

    const offer = async name => {
      const r = await ctx.call("gate.offer", { name: `mail:${name}`, tool: "mail.release", kinds: ["send"], content: CONTENT });
      if (r.error) ctx.log(`could not offer the mail:${name} sender: ${r.error.message}`);
      return !r.error;
    };
    // Held items outlive a restart; their sender must be there when the person approves.
    try { for (const i of await listed()) await offer(i.name); } catch (e) { ctx.log(`mail senders not offered yet: ${/** @type {any} */ (e).message}`); }

    ctx.tool("mail.accounts", {
      description: "The IMAP and SMTP mail accounts this surface may use: [{name, imap_host, imap_port, smtp_host, smtp_port, from}], or {name, granted: false} for one not yet granted to mail. Never a password.",
      input: obj({}),
      run: safe(async (_input, meta) => {
        const out = [];
        for (const item of await listed()) {
          try { await allowed((t, i) => ctx.call(t, i), item.name, meta.caller); } catch { continue; }
          if (!granted(item)) { out.push({ name: item.name, granted: false }); continue; }
          try {
            const a = await settings(item.name);
            out.push({ name: a.name, imap_host: a.imap.host, imap_port: a.imap.port, smtp_host: a.smtp.host, smtp_port: a.smtp.port, from: a.from });
          } catch (e) { out.push({ name: item.name, error: String(/** @type {any} */ (e).message) }); }
        }
        return out;
      }),
    });

    ctx.tool("mail.test", {
      description: "Check an account: log in to its IMAP and its SMTP server and log out again. Returns { account, imap: {ok, error?}, smtp: {ok, error?} }. Nothing is read or sent.",
      input: obj({ account }, ["account"]),
      callers: PEOPLE,
      run: safe(async ({ account: name }, meta) => {
        const acct = await use(name, meta);
        const side = async fn => { try { await fn(); return { ok: true }; } catch (e) { return { ok: false, error: String(/** @type {any} */ (e).message) }; } };
        const imap = await side(async () => { const c = await Imap.open(acct.imap); await c.logout(); });
        const out = await side(() => smtp.probe(acct.smtp));
        ctx.events.emit("mail.tested", { account: acct.name, ok: imap.ok && out.ok });
        return { account: acct.name, imap, smtp: out };
      }),
    });

    ctx.tool("mail.search", {
      description: "Messages in a mailbox (INBOX unless `mailbox` says otherwise), newest first. `query` takes from:dana, subject:\"engagement letter\", since:2026-09-01, unseen, and any other words as text; empty lists the newest. Returns { mailbox, total, messages: [{id, from, to, subject, date, unseen, message_id}] }; `id` is what mail.read takes.",
      input: obj({ account, query: str, mailbox: str, limit: int }, ["account"]),
      run: safe(async ({ account: name, query, mailbox, limit }, meta) => {
        const acct = await use(name, meta);
        const box = named(mailbox) || "INBOX";
        const n = clamp(limit, 1, 100, 20);
        return withImap(acct, async c => {
          await c.examine(box);
          const uids = (await c.search(query)).sort((a, b) => b - a);
          const rows = await c.envelopes(uids.slice(0, n));
          return {
            mailbox: box, total: uids.length,
            messages: rows.map(r => ({ id: `${box}/${r.uid}`, from: r.envelope.from.join(", "), to: r.envelope.to.join(", "), subject: r.envelope.subject,
              date: r.envelope.date, unseen: !r.flags.some(f => f.toLowerCase() === "\\seen"), message_id: r.envelope.message_id })),
          };
        });
      }),
    });

    /** One message, parsed. */
    const readOne = (acct, id) => {
      const { mailbox, uid } = parseId(id);
      return withImap(acct, async c => {
        await c.examine(mailbox);
        const raw = await c.body(uid);
        if (!raw) throw fail(`no message ${id}`, "not_found");
        return { id, ...readMessage(raw) };
      });
    };

    ctx.tool("mail.read", {
      description: "One message (`id` from mail.search) as plain text with its headers, without marking it read; bodies are capped near 20,000 characters. An html-only message is returned with its tags stripped.",
      input: obj({ account, id: str }, ["account", "id"]),
      run: safe(async ({ account: name, id }, meta) => readOne(await use(name, meta), id)),
    });

    ctx.tool("mail.send", {
      description: "Send an email from an IMAP and SMTP account. It is always held at the Gate until the user approves it (and may edit it); returns { held, message }. Nothing is sent from here. `reply_to_id` (an id from mail.search) makes it a reply in that thread.",
      input: obj({ account, to: emails, cc: emails, subject: str, body: { type: "string", description: "plain text" }, reply_to_id: str, why: str }, ["account", "to", "subject", "body"]),
      run: safe(async (input, meta) => {
        const acct = await use(input.account, meta);
        const to = addresses(input.to, "to");
        const cc = addresses(input.cc, "cc");
        /** @type {Record<string, any>} */
        const c = { subject: String(input.subject ?? ""), body: String(input.body ?? "") };
        if (cc.length) c.cc = cc;
        if (named(input.reply_to_id)) {
          const orig = await readOne(acct, input.reply_to_id);
          if (orig.message_id) {
            c.in_reply_to = orig.message_id;
            c.references = [orig.references, orig.message_id].filter(Boolean).join(" ");
          }
        }
        // Built once now so a bad header is refused before anything is held.
        smtp.buildMessage({ from: acct.from, to, ...c });
        await offer(acct.name);
        const r = await ctx.call("gate.request", { kind: "send", via: `mail:${acct.name}`, to, content: c,
          ...(named(input.why) ? { why: input.why } : {}), ...(meta.thread ? { thread: meta.thread } : {}) });
        if (r.error) throw fail(r.error.message, r.error.code || "failed");
        return { held: r.data.id, message: `Held at the Gate: "${c.subject}" to ${to.join(", ")} from ${acct.from} goes out once the user approves it in Vyre.` };
      }),
    });

    ctx.tool("mail.release", {
      internal: true,
      description: "The Gate's call once the user approved a held email: sends exactly the approved `to` and content over SMTP.",
      input: obj({ id: str, to: { type: "array", items: str }, content: { type: "object" } }, ["id", "to", "content"]),
      run: safe(async ({ id, to, content }, { caller }) => {
        if (caller !== "module:gate") throw fail("only the Gate releases what goes out", "denied");
        const item = await ctx.call("gate.get", { id });
        const m = /^mail:(.+)$/.exec(String(item.data?.via || ""));
        if (!m) throw fail(`${id} is not held for a mail account`);
        const acct = await settings(m[1]);
        const dest = addresses(to, "to");
        const cc = addresses(content.cc, "cc");
        const msg = smtp.buildMessage({ from: acct.from, to: dest, cc, subject: String(content.subject ?? ""), body: String(content.body ?? ""),
          ...(named(content.in_reply_to) ? { in_reply_to: content.in_reply_to, references: named(content.references) } : {}) });
        try {
          const out = await smtp.send(acct.smtp, { from: acct.from, to: [...dest, ...cc], raw: msg.raw });
          ctx.events.emit("mail.sent", { account: acct.name });
          return { message_id: msg.message_id, accepted: out.accepted, response: out.response };
        } catch (e) {
          ctx.events.emit("mail.send-failed", { account: acct.name, code: String(/** @type {any} */ (e).code || "failed") });
          throw e;
        }
      }),
    });

    return { async stop() {} };
  },
};
