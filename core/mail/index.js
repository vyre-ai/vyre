// @ts-check
// mail: one capability over every mail account the person connected (ADR 0016 decision 8).
//
// mail.send, mail.search and mail.read take an `account`, a vault connection id (ADR 0028
// decision 9b), and work the same whichever adapter serves it: a Google account (the google
// module, DWD or OAuth), an MCP server (the hub), the person's Apps Script web app, or IMAP and
// SMTP. This module never imports google, mcp or vault; it reaches them with ctx.call, and serves
// the last two adapters itself (apps-script.js, imap.js).
//
// Rules, and why:
// - The vault decides who may use which account. mail asks vault.connections.list for the caller
//   vyred verified (accounts.js callerFor) and acts only on what comes back, so an account a
//   surface may not use is invisible to it and cannot be named into a send.
// - Every send is held at the Gate, whichever adapter. Google holds as google:<account>, the hub
//   as mcp:<server> with `hold: true` (so a mapped tool that looks like a read still waits), and
//   the native adapters as mail:<account>, which the Gate releases through mail.release. Approving
//   needs presence, like every outbound item; nothing here asks for it (the no-nag rule).
// - The chat or agent a call came from goes with it as `on_behalf`, so a held item is filed where
//   it was asked for.
// - A missing or ungranted vault item answers needs_credential with {module, need, account}, where
//   need is an id under needs.credentials in module.json, so the vault's flow (vault.connect)
//   can ask the person. Never a value.
// - Nothing runs in the background: no timer, no poll, no child.

import { addresses, checkContent, parseQuery, addressOf, nameOf } from "../../lib/connectors/message.js";
import { checkBehalf } from "../../lib/connectors/behalf.js";
import { MIGRATIONS, ID, callerFor, filingFor, adapterOf, imapConfig, view, pickFor } from "./accounts.js";
import { guess, checkMap, sendArgs, messagesOf, messageOf } from "./mcpmap.js";
import { parse, composeId, parseComposeId, messageId, parseMessageId } from "./capsule.js";
import { imapAdapter } from "./imap.js";
import { appsScriptAdapter } from "./apps-script.js";

const str = { type: "string" };
const int = { type: "integer" };
const obj = (properties, required = []) => ({ type: "object", properties, required });
const emails = { anyOf: [str, { type: "array", items: str }], description: "an address, a comma list, or a list" };
const PEOPLE = ["cli", "local", "deck", "capsule", "module"];
const MANAGERS = ["cli", "local", "deck", "module"];
/** mail.send only holds a message at the Gate, from accounts this caller may use, so a model session may ask for one. */
const WITH_MODELS = [...PEOPLE, "mcp", "harness"];
const account = { type: "string", description: "a mail account id from mail.accounts (a vault connection id); reads default to every account this caller may use" };
const behalf = obj({ surface: { type: "string", enum: ["capsule", "chat", "agent", "phone"] }, thread: str, agent: str },
  []);

/** What a held item of a mail:<account> sender carries, for gate.senders. */
const CONTENT = { subject: "string", body: "string, plain text", cc: "email[]?", bcc: "email[]?", in_reply_to: "Message-ID?" };

const fail = (msg, code = "bad_input", detail) => Object.assign(new Error(msg), { code, ...(detail ? { detail } : {}) });
const named = v => (typeof v === "string" && v ? v : undefined);
const clamp = (v, lo, hi, d) => (Number.isInteger(v) ? Math.min(hi, Math.max(lo, v)) : d);
const MAILCAPS = ["send_mail", "read_mail"];

/** @type {{ start(ctx: any): Promise<{ stop(): Promise<void> }> }} */
export default {
  async start(ctx) {
    ctx.store.migrate(MIGRATIONS);
    const db = ctx.store.db;
    const now = () => Date.now();
    const opts = (ctx.config && ctx.config.mail) || {};
    const timeout = Number.isInteger(opts.timeout) ? opts.timeout : undefined;
    const native = { imap: imapAdapter({ ...(timeout ? { timeout } : {}) }), "apps-script": appsScriptAdapter({ ...(timeout ? { timeout } : {}) }) };

    /** Another module's tool: its data, or its error thrown with the code kept. */
    const use = async (tool, input) => {
      const r = await ctx.call(tool, input);
      if (r.error) {
        if (r.error.code === "no_such_tool") throw fail(`${tool.split(".")[0]} is not running on this machine, so this account cannot be used`, "unavailable");
        throw fail(r.error.message, r.error.code || "failed", r.error.detail);
      }
      return r.data;
    };

    // ---- the vault: accounts and values ----

    /** The mail accounts this caller may use, from the vault's connections. */
    const usable = async (meta, input) => {
      // on_behalf counts only from one of Vyre's own modules, and its thread is checked against
      // the Switchboard (connectors/behalf.js) before anything is filed under it.
      let bh;
      if (input && input.on_behalf !== undefined && meta.firstParty !== true) throw fail("on_behalf is for Vyre's own modules only", "denied");
      if (meta.firstParty === true && input && input.on_behalf && typeof input.on_behalf === "object") {
        const checked = await checkBehalf((tool, x) => ctx.call(tool, x), meta, input.on_behalf);
        bh = { surface: input.on_behalf.surface, ...(checked || {}) };
      }
      const caller = callerFor(meta.caller, meta, bh);
      // A module installed into a home is not the person and speaks for no one: it sees no account.
      if (String(meta.caller || "").startsWith("module:") && meta.firstParty !== true) return { caller, filing: {}, list: [] };
      const rows = await use("vault.connections.list", { caller });
      const list = (Array.isArray(rows) ? rows : rows?.connections || [])
        .filter(r => r && ID.test(String(r.id)) && adapterOf(r) && (r.capabilities || []).some(c => MAILCAPS.includes(c)));
      return { caller, filing: filingFor(meta.caller, meta, bh), list };
    };

    /** A vault value, with a missing or ungranted item said plainly. */
    const value = async (acct, item, field) => {
      try { return String(await ctx.vault.fetch(item, field ? { field } : {})); } catch (e) {
        const m = String(/** @type {any} */ (e)?.message || e);
        if (/is not granted to|no item named/.test(m)) {
          ctx.events.emit("mail.needs-credential", { account: acct.id, item });
          throw fail(`${acct.label || acct.account} needs the vault item ${item}, granted to mail · open Vault, Connections`, "needs_credential", { module: "mail", need: adapterOf(acct) === "apps-script" ? "apps-script" : "imap", account: acct.id });
        }
        if (/locked/i.test(m)) throw fail("the vault is locked; unlock it to use this account", "locked");
        throw fail(m, "vault");
      }
    };

    /** The adapter settings and the credential of a native account: [cfg, secret]. */
    async function nativeArgs(acct) {
      const item = String(acct.ref);
      if (adapterOf(acct) === "apps-script") return [{ address: acct.account, auth: { item } }, name => value(acct, item, name)];
      const f = {};
      for (const k of ["imap_host", "imap_port", "smtp_host", "smtp_port", "username", "from", "security"]) {
        try { f[k] = String(await ctx.vault.fetch(item, { field: k })); } catch (e) {
          const m = String(/** @type {any} */ (e)?.message || e);
          if (/is not granted to|no item named|locked/i.test(m)) await value(acct, item, k);
        }
      }
      const cfg = imapConfig(item, f, acct.account);
      const problem = native.imap.check(cfg);
      if (problem) throw fail(`${acct.label || acct.account}: ${problem}`, "bad_config");
      return [cfg, () => value(acct, item, "password")];
    }

    // ---- MCP tool maps ----

    const mapOf = id => { const r = /** @type {any} */ (db.prepare("SELECT * FROM mail_maps WHERE account = ?").get(id)); return r ? { server: String(r.server), map: JSON.parse(String(r.map)), guessed: Boolean(r.guessed) } : null; };
    const putMap = (id, server, map, guessed) => db.prepare(`INSERT INTO mail_maps (account, server, map, guessed, updated) VALUES (?,?,?,?,?)
      ON CONFLICT(account) DO UPDATE SET server = excluded.server, map = excluded.map, guessed = excluded.guessed, updated = excluded.updated`).run(id, server, JSON.stringify(map), guessed ? 1 : 0, now());

    /** The map of an MCP account: the person's, or guessed from the hub's cached tools once. */
    async function mcpMap(acct) {
      const server = String(acct.ref);
      const have = mapOf(acct.id);
      if (have && have.server === server) return have.map;
      const tools = (await use("mcp.tools", {})).filter(t => t.server === server);
      if (!tools.length) throw fail(`the MCP server ${server} has no tools cached; test it in Connections first`, "not_found");
      const map = guess(tools);
      const problem = checkMap(map);
      if (problem) throw fail(`${server}: ${problem} with mail.map`, "unsupported");
      putMap(acct.id, server, map, true);
      return map;
    }

    const offered = new Set();
    const offer = async id => {
      if (offered.has(id)) return;
      const r = await ctx.call("gate.offer", { name: `mail:${id}`, tool: "mail.release", kinds: ["send"], content: CONTENT });
      if (r.error) throw fail(`the Gate did not take the mail:${id} sender: ${r.error.message}`, "failed");
      offered.add(id);
    };

    // A held item survives a restart of vyred: offer the sender of every one still waiting, so
    // the person can approve it. New senders are offered on first use (holdSend).
    {
      const r = await ctx.call("gate.held", {});
      const items = Array.isArray(r.data) ? r.data : r.data?.items || [];
      for (const v of new Set(items.map(i => String(i.via || "")).filter(v => /^mail:[A-Za-z0-9_-]{1,64}$/.test(v)))) {
        await offer(v.slice(5)).catch(e => ctx.log(String(e.message)));
      }
    }

    // ---- accounts ----

    ctx.tool("mail.accounts", {
      description: "The mail accounts this caller may use: account (the id every mail tool takes), adapter, address, label. With several, name one in mail.send.",
      input: obj({ on_behalf: behalf }),
      run: async (input, meta) => (await usable(meta, input)).list.map(view),
    });

    ctx.tool("mail.map", {
      description: "Show or correct how an MCP-served mail account maps onto its server's tools: { send: { tool, to, subject, body, cc?, bcc?, to_list? }, search?: { tool, q, limit? }, read?: { tool, id } }. Without `map` it shows the current one (guessing it the first time).",
      input: obj({ account: str, map: { type: "object" } }, ["account"]),
      callers: MANAGERS,
      run: async (input, meta) => {
        const acct = pickFor((await usable(meta, input)).list, input.account);
        if (adapterOf(acct) !== "mcp") throw fail(`${input.account} is not served by an MCP server`);
        if (input.map === undefined) return { account: acct.id, server: acct.ref, map: await mcpMap(acct) };
        const problem = checkMap(input.map);
        if (problem) throw fail(problem);
        const tools = (await use("mcp.tools", {})).filter(t => t.server === acct.ref);
        for (const verb of ["send", "search", "read"]) if (input.map[verb] && !tools.some(t => t.tool === input.map[verb].tool)) throw fail(`${acct.ref} has no tool ${input.map[verb].tool} that is on`);
        putMap(acct.id, String(acct.ref), input.map, false);
        ctx.events.emit("mail.mapped", { account: acct.id });
        return { account: acct.id, server: acct.ref, map: input.map };
      },
    });

    ctx.tool("mail.test", {
      description: "Check a mail account without sending anything: whether it can search, read and send, and what is wrong if not.",
      input: obj({ account: str }, ["account"]),
      callers: MANAGERS,
      run: async (input, meta) => {
        const acct = pickFor((await usable(meta, input)).list, input.account);
        const kind = adapterOf(acct);
        try {
          if (kind === "imap" || kind === "apps-script") {
            const [cfg, cred] = await nativeArgs(acct);
            return { account: acct.id, ...(await native[kind].test(cfg, cred)) };
          }
          if (kind === "google") {
            const t = await use("google.test", { name: acct.ref });
            const sc = t.scopes || {};
            return { account: acct.id, ok: Boolean(t.ok), can: { search: Boolean(sc["gmail.readonly"]), read: Boolean(sc["gmail.readonly"]), send: Boolean(sc["gmail.send"]) }, ...(t.error ? { error: t.error } : {}) };
          }
          const map = await mcpMap(acct);
          const t = await use("mcp.test", { name: acct.ref });
          return { account: acct.id, ok: Boolean(t.ok), can: { search: Boolean(map.search), read: Boolean(map.read), send: Boolean(map.send) }, ...(t.error ? { error: t.error } : {}) };
        } catch (e) {
          const err = /** @type {any} */ (e);
          return { account: acct.id, ok: false, can: { search: false, read: false, send: false }, error: String(err.message), code: err.code || "failed" };
        }
      },
    });

    // ---- reads ----

    /** Search one account. Rows carry `_at` for ordering. */
    async function searchOne(acct, q, limit) {
      const kind = adapterOf(acct);
      if (kind === "google") {
        const r = await use("google.mail.search", { q, account: acct.ref, limit });
        return (r.messages || []).map(m => ({ ...m, account: acct.id, _at: Date.parse(m.date) || 0 }));
      }
      if (kind === "mcp") {
        const m = (await mcpMap(acct)).search;
        if (!m) throw fail(`${acct.label || acct.ref} has no search tool mapped`, "unsupported");
        const r = await use("mcp.call", { server: acct.ref, tool: m.tool, arguments: { [m.q]: q, ...(m.limit ? { [m.limit]: limit } : {}) } });
        if (r && r.held) throw fail(`${acct.ref}'s ${m.tool} is held as outward; mark it read in Connections to search with it`, "held");
        return messagesOf(r, acct.id).slice(0, limit);
      }
      const [cfg, cred] = await nativeArgs(acct);
      const list = kind === "imap" ? await native.imap.search(cfg, cred, { query: parseQuery(q), limit }) : await native["apps-script"].search(cfg, cred, { q, limit });
      return list.map(m => ({ ...m, account: acct.id }));
    }

    /** Search every given account, newest first; one failing account is an entry in `errors`. */
    async function searchAll(accts, q, limit) {
      const errors = [];
      const found = await Promise.all(accts.map(a => searchOne(a, q, limit).catch(e => {
        const err = /** @type {any} */ (e);
        errors.push({ account: a.id, error: String(err.message).slice(0, 300), code: err.code || "failed", ...(err.detail ? { detail: err.detail } : {}) });
        return [];
      })));
      const messages = found.flat().sort((a, b) => b._at - a._at).slice(0, limit).map(({ _at, ...m }) => m);
      return { messages, errors };
    }

    ctx.tool("mail.search", {
      description: "Search mail newest first, across every account this caller may use unless account is named. Returns id, from, subject, snippet. Read one with mail.read.",
      input: obj({ q: { ...str, description: "words, from:, to:, subject:, newer_than:7d, is:unread" }, account, limit: int, on_behalf: behalf }, ["q"]),
      run: async (input, meta) => {
        const { list } = await usable(meta, input);
        const accts = named(input.account) ? [pickFor(list, input.account)] : list;
        if (!accts.length) throw fail("no mail account is connected for this surface · add one in Vault, Connections", "no_account");
        const { messages, errors } = await searchAll(accts, String(input.q), clamp(input.limit, 1, 25, 10));
        if (errors.length === accts.length) throw fail(errors.map(e => `${e.account}: ${e.error}`).join("; "), errors[0].code, errors.length === 1 ? errors[0].detail : { errors });
        return { messages, ...(errors.length ? { errors } : {}) };
      },
    });

    async function readOne(acct, id) {
      const kind = adapterOf(acct);
      if (kind === "google") return { ...(await use("google.mail.read", { id, account: acct.ref })), account: acct.id };
      if (kind === "mcp") {
        const m = (await mcpMap(acct)).read;
        if (!m) throw fail(`${acct.label || acct.ref} has no read tool mapped`, "unsupported");
        const r = await use("mcp.call", { server: acct.ref, tool: m.tool, arguments: { [m.id]: id } });
        if (r && r.held) throw fail(`${acct.ref}'s ${m.tool} is held as outward; mark it read in Connections to read with it`, "held");
        return messageOf(r, acct.id, id);
      }
      const [cfg, cred] = await nativeArgs(acct);
      return { ...(await native[kind].read(cfg, cred, { id })), account: acct.id };
    }

    ctx.tool("mail.read", {
      description: "One message as plain text with its headers, from the account mail.search named. `message_id` is what a reply's in_reply_to takes.",
      input: obj({ account, id: str, on_behalf: behalf }, ["account", "id"]),
      run: async (input, meta) => readOne(pickFor((await usable(meta, input)).list, input.account), String(input.id)),
    });

    // ---- sends ----

    const mailInput = { to: emails, subject: str, body: { type: "string", description: "plain text" }, cc: emails, bcc: emails,
      in_reply_to: { type: "string", description: "the Message-ID being answered, from mail.read" }, account, why: str, on_behalf: behalf };

    /** Hold one message at the Gate through the account's adapter. Nothing is sent here. */
    async function holdSend(acct, to, c, why, on) {
      const kind = adapterOf(acct);
      let held, via;
      if (kind === "google") {
        const r = await use("google.mail.send", { account: acct.ref, to, subject: c.subject, body: c.body, ...(c.cc ? { cc: c.cc } : {}), ...(c.bcc ? { bcc: c.bcc } : {}),
          ...(c.in_reply_to ? { in_reply_to: c.in_reply_to } : {}), ...(why ? { why } : {}), on_behalf: on });
        held = r.held; via = `google:${acct.ref}`;
      } else if (kind === "mcp") {
        const m = (await mcpMap(acct)).send;
        if (!m) throw fail(`${acct.label || acct.ref} has no send tool mapped`, "unsupported");
        const r = await use("mcp.call", { server: acct.ref, tool: m.tool, arguments: sendArgs(m, to, c), hold: true, on_behalf: on });
        held = r && r.held; via = `mcp:${acct.ref}`;
      } else {
        await offer(acct.id);
        const r = await use("gate.request", { kind: "send", via: `mail:${acct.id}`, to, content: c, ...(why ? { why } : {}), ...on });
        held = r.id; via = `mail:${acct.id}`;
      }
      if (!held) throw fail(`${via} did not hold this send, so nothing was sent`, "failed");
      ctx.events.emit("mail.held", { account: acct.id, id: held, via }, on.thread ? { thread: on.thread } : undefined);
      return { held, account: acct.id, via,
        message: `Held at the Gate: "${c.subject || "(no subject)"}" to ${to.join(", ")} from ${acct.account} goes out once the user approves it in Vyre. Nothing was sent.` };
    }

    const contentOf = input => {
      const to = addresses(input.to, "to");
      const c = { subject: String(input.subject ?? ""), body: String(input.body ?? "") };
      const cc = addresses(input.cc, "cc"), bcc = addresses(input.bcc, "bcc");
      if (cc.length) c.cc = cc;
      if (bcc.length) c.bcc = bcc;
      if (named(input.in_reply_to)) c.in_reply_to = input.in_reply_to;
      checkContent(to, c);
      return { to, c };
    };

    ctx.tool("mail.send", {
      callers: WITH_MODELS,
      description: "Send an email as the user, always held at the Gate until they approve it. With several accounts, name one from mail.accounts.",
      input: obj(mailInput, ["to", "subject", "body"]),
      run: async (input, meta) => {
        const { filing, list } = await usable(meta, input);
        const acct = pickFor(list, named(input.account));
        if (!(acct.capabilities || []).includes("send_mail")) throw fail(`${acct.label || acct.account} is not allowed to send; it reads only`, "denied");
        const { to, c } = contentOf(input);
        return holdSend(acct, to, c, named(input.why), filing);
      },
    });

    ctx.tool("mail.release", {
      internal: true,
      description: "The Gate's call once the user approved a held email of a mail:<account> sender: sends exactly the approved `to` and content.",
      input: obj({ id: str, to: { type: "array", items: str }, content: { type: "object" } }, ["id", "to", "content"]),
      run: async ({ id, to, content }, { caller }) => {
        if (caller !== "module:gate") throw fail("only the Gate releases what goes out", "denied");
        const it = await use("gate.get", { id });
        if (!it || it.state !== "sending") throw fail(`${id} is not an approved item being sent`, "denied");
        const m = /^mail:([A-Za-z0-9_-]{1,64})$/.exec(String(it.via || ""));
        if (!m) throw fail(`${id} is not held for a mail account`);
        // The person approved it, so no surface filter applies: the account must still be there,
        // and still one mail serves itself. vault.connections.get is for module callers.
        const acct = await ctx.call("vault.connections.get", { id: m[1] }).then(r => (r.error ? null : r.data && (r.data.connection || r.data)));
        if (!acct) throw fail(`the mail account ${m[1]} was removed; connect it again to send this`, "no_account");
        const kind = adapterOf(acct);
        if (kind !== "imap" && kind !== "apps-script") throw fail(`${m[1]} sends through its own module, not mail.release`, "denied");
        const dest = addresses(to, "to");
        const c = { subject: content.subject, body: content.body, ...(content.cc ? { cc: addresses(content.cc, "cc") } : {}),
          ...(content.bcc ? { bcc: addresses(content.bcc, "bcc") } : {}), ...(named(content.in_reply_to) ? { in_reply_to: content.in_reply_to } : {}) };
        checkContent(dest, c);
        const [cfg, cred] = await nativeArgs(acct);
        const out = await native[kind].send(cfg, cred, { to: dest, ...c });
        ctx.events.emit("mail.sent", { account: acct.id });
        return { ...out, account: acct.id };
      },
    });

    // ---- the Capsule ----

    ctx.tool("mail.find", {
      description: "The Capsule's mail results: \"send an email\", \"email dana@northwind-bakery.example about the order\" gives one row per account to send from; \"email from dana\" gives messages across accounts. { rows: [{ id, name, kind, sub }] }.",
      input: obj({ q: str, limit: int }, ["q"]),
      callers: PEOPLE,
      run: async (input, meta) => {
        const p = parse(input.q);
        if (p.kind === "none") return { rows: [] };
        const { list } = await usable(meta, input);
        const n = clamp(input.limit, 1, 20, 6);
        if (p.kind === "compose") {
          const { kind, ...fill } = p;
          const what = [fill.to || fill.name ? `to ${fill.to || fill.name}` : "", fill.subject ? `about ${fill.subject}` : ""].filter(Boolean).join(" ");
          return { rows: list.filter(a => (a.capabilities || []).includes("send_mail")).slice(0, n).map(a => ({ id: composeId(a.id, fill), kind: "compose",
            name: `Send from ${a.account}`, sub: [kindName(adapterOf(a)), a.label || a.account, what].filter(Boolean).join(" · ") })) };
        }
        const readers = list.filter(a => (a.capabilities || []).includes("read_mail"));
        const { messages } = await searchAll(readers, p.q, n);
        return { rows: messages.map(m => ({ id: messageId(m.account, m.id), kind: "email", name: m.subject || "(no subject)",
          sub: [nameOf(m.from), readers.length > 1 ? (readers.find(a => a.id === m.account)?.account || "") : ""].filter(Boolean).join(" · ") })) };
      },
    });

    ctx.tool("mail.compose", {
      description: "The Capsule's action on a mail.find row. On a send row it holds the message at the Gate with what the words named (to, subject, body, each of which may be given here instead), for the user to finish and approve there; on a message row it gives the message as text.",
      input: obj({ id: str, to: emails, subject: str, body: str }, ["id"]),
      callers: PEOPLE,
      run: async (input, meta) => {
        const { filing, list } = await usable(meta, input);
        const msg = parseMessageId(input.id);
        if (msg) return { kind: "email", message: await readOne(pickFor(list, msg.account), msg.id) };
        const row = parseComposeId(input.id);
        if (!row) throw fail("that is not a mail row");
        const acct = pickFor(list, row.account);
        const fill = { ...row.fill, ...(input.to !== undefined ? { to: input.to } : {}), ...(named(input.subject) ? { subject: input.subject } : {}), ...(named(input.body) ? { body: input.body } : {}) };
        let to = fill.to;
        if (!to && fill.name) to = await resolve(list, acct, fill.name);
        if (!to) throw fail(fill.name ? `no address found for ${fill.name}; say who it goes to with an address` : "say who it goes to: an address", "needs_to");
        const { to: dest, c } = contentOf({ to, subject: fill.subject || "", body: fill.body || "" });
        return { kind: "held", ...(await holdSend(acct, dest, c, "written in the Capsule", filing)) };
      },
    });

    /** A person's address from a name: from mail they sent, the sending account first. */
    async function resolve(list, acct, name) {
      const readers = [acct, ...list.filter(a => a.id !== acct.id)].filter(a => (a.capabilities || []).includes("read_mail"));
      const q = `from:${/\s/.test(name) ? `"${name}"` : name}`;
      const low = name.toLowerCase();
      for (const a of readers) {
        const found = await searchOne(a, q, 5).catch(() => []);
        for (const m of found) {
          const addr = addressOf(m.from);
          if (addr && (nameOf(m.from).toLowerCase().includes(low) || addr.toLowerCase().includes(low))) return addr;
        }
      }
      return undefined;
    }

    return { async stop() {} };
  },
};

function kindName(adapter) {
  return { google: "Google", mcp: "MCP", "apps-script": "Apps Script", imap: "IMAP" }[adapter] || adapter;
}
