// @ts-check
// mail: one capability over every mail account the person connected (ADR 0016 decision 8).
//
// mail.send, mail.search and mail.read take an `account` and work the same whichever adapter
// serves it: a Google account (the google module, DWD or OAuth), an MCP server (the hub), the
// person's Apps Script web app, or IMAP and SMTP. This module never imports google or mcp; it
// reaches them with ctx.call, and serves the last two itself (apps-script.js, imap.js).
//
// Rules, and why:
// - Every send is held at the Gate, whichever adapter. Google holds as google:<account>, the hub
//   as mcp:<server> with `hold: true` (so a mapped tool that looks like a read still waits), and
//   the native adapters as mail:<account>, which the Gate releases through mail.release. Approving
//   needs presence, like every outbound item; nothing here asks for it (the no-nag rule).
// - The surface comes from what vyred verified (accounts.js). A surface sees only the accounts
//   granted to it, and a send with no account names the only one or asks, never guesses.
// - The chat or agent a call came from goes with it as `on_behalf`, so a held item is filed
//   where it was asked for.
// - A missing or ungranted vault item answers `needs_credential` with the account and the item,
//   so the vault's flow can ask the person; never a value.
// - Nothing runs in the background: no timer, no poll, no child. Google accounts are mirrored
//   lazily, when accounts are listed.

import { addresses, checkContent, parseQuery, addressOf, nameOf } from "../connectors/message.js";
import { MIGRATIONS, ADAPTERS, NAME, store, surfacesOf, surfaceOf, allowed, configOf, pickForSend, view } from "./accounts.js";
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
const account = { type: "string", description: "an account from mail.accounts; reads default to every account this surface may use" };
const behalf = obj({ surface: { type: "string", enum: ["capsule", "chat", "agent"] }, thread: str, agent: str });

/** What a held item of a mail:<account> sender carries, for gate.senders. */
const CONTENT = { subject: "string", body: "string, plain text", cc: "email[]?", bcc: "email[]?", in_reply_to: "Message-ID?" };

const fail = (msg, code = "bad_input", detail) => Object.assign(new Error(msg), { code, ...(detail ? { detail } : {}) });
const named = v => (typeof v === "string" && v ? v : undefined);
const clamp = (v, lo, hi, d) => (Number.isInteger(v) ? Math.min(hi, Math.max(lo, v)) : d);
const NATIVE = new Set(["imap", "apps-script"]);
const isGoogle = a => a === "google-dwd" || a === "google-oauth";

/** @type {{ start(ctx: any): Promise<{ stop(): Promise<void> }> }} */
export default {
  async start(ctx) {
    ctx.store.migrate(MIGRATIONS);
    const rows = store(ctx.store.db);
    const now = () => Date.now();
    const opts = (ctx.config && ctx.config.mail) || {};
    const timeout = Number.isInteger(opts.timeout) ? opts.timeout : undefined;
    const native = { imap: imapAdapter({ ...(timeout ? { timeout } : {}) }), "apps-script": appsScriptAdapter({ ...(timeout ? { timeout } : {}) }) };

    /** A call to another module's tool: its data, or its error thrown with the code kept. */
    const use = async (tool, input) => {
      const r = await ctx.call(tool, input);
      if (r.error) {
        if (r.error.code === "no_such_tool") throw fail(`${tool.split(".")[0]} is not running on this machine, so this account cannot be used`, "unavailable");
        throw fail(r.error.message, r.error.code || "failed", r.error.detail);
      }
      return r.data;
    };

    /** A vault value for a native adapter, with a missing or ungranted item said plainly. */
    const secret = (acct, item, field) => async () => {
      try { return String(await ctx.vault.fetch(item, field ? { field } : {})); } catch (e) {
        const m = String(/** @type {any} */ (e)?.message || e);
        if (/is not granted to|no item named/.test(m)) {
          ctx.events.emit("mail.needs-credential", { account: acct.account, item });
          throw fail(`${acct.account} needs the vault item ${item}, granted to mail · vyre vault grant ${item} mail`, "needs_credential", { account: acct.account, item });
        }
        if (/locked/i.test(m)) throw fail("the vault is locked; unlock it to use this account", "locked");
        throw fail(m, "vault");
      }
    };
    const cfgOf = acct => ({ ...acct.config, address: acct.address });
    const nativeArgs = acct => acct.adapter === "imap"
      ? [cfgOf(acct), secret(acct, acct.config.auth.item, acct.config.auth.field)]
      : [cfgOf(acct), name => secret(acct, acct.config.auth.item, name)()];

    // ---- the Gate and the vault's connections ----

    const offer = async acct => {
      if (!NATIVE.has(acct.adapter)) return;
      const r = await ctx.call("gate.offer", { name: `mail:${acct.account}`, tool: "mail.release", kinds: ["send"], content: CONTENT });
      if (r.error) ctx.log(`could not offer the mail:${acct.account} sender: ${r.error.message}`);
    };

    /**
     * Tell the vault this account is a connection and which items it needs, so its "needs a
     * credential" flow can name them. Until the vault serves connections this is a no-op.
     */
    const register = async acct => {
      const items = NATIVE.has(acct.adapter) ? native[acct.adapter].items(cfgOf(acct)) : [];
      const r = await ctx.call("vault.connections.register", { id: `mail:${acct.account}`, kind: "mail", adapter: acct.adapter, label: acct.label || acct.address, items });
      if (r.error && r.error.code !== "no_such_tool") ctx.log(`could not register mail:${acct.account} with the vault: ${r.error.message}`);
    };
    const unregister = async name => {
      const r = await ctx.call("vault.connections.remove", { id: `mail:${name}` });
      if (r.error && r.error.code !== "no_such_tool") ctx.log(`could not unregister mail:${name}: ${r.error.message}`);
    };

    for (const a of rows.all()) await offer(a);

    /**
     * Mirror the google module's accounts: a row for each one not yet here, and a mirrored row
     * dropped when its Google account went. Called when accounts are listed, never on a timer.
     */
    const syncGoogle = async () => {
      const r = await ctx.call("google.accounts", {});
      if (r.error) return;
      const g = Array.isArray(r.data) ? r.data : [];
      const byName = new Map(g.map(x => [x.name, x]));
      for (const a of rows.all()) {
        if (isGoogle(a.adapter) && !byName.has(a.config.google)) { rows.remove(a.account); await unregister(a.account); ctx.events.emit("mail.removed", { account: a.account }); }
      }
      const mirrored = new Set(rows.all().filter(a => isGoogle(a.adapter)).map(a => a.config.google));
      for (const x of g) {
        if (mirrored.has(x.name)) continue;
        const name = rows.get(x.name) ? `google-${x.name}`.slice(0, 32) : x.name;
        if (rows.get(name) || !NAME.test(name)) continue;
        const acct = rows.put({ account: name, adapter: x.auth?.type === "service-account" ? "google-dwd" : "google-oauth", address: x.email,
          surfaces: surfacesOf(undefined), config: { google: x.name } }, now());
        await register(acct);
        ctx.events.emit("mail.added", { account: acct.account, adapter: acct.adapter });
      }
    };

    /** The accounts this caller may use, Google mirrored first. */
    const usable = async (meta, input) => {
      await syncGoogle();
      const s = surfaceOf(meta.caller, meta, input && input.on_behalf);
      return { s, list: rows.all().filter(a => allowed(a, s)) };
    };
    /** Who a held item is filed under: the verified thread and agent, or a module's on_behalf. */
    const filing = s => ({ ...(s.thread ? { thread: s.thread } : {}), ...(s.kind === "agent" && s.agent ? { agent: s.agent } : {}) });

    // ---- accounts ----

    ctx.tool("mail.accounts", {
      description: "The mail accounts this caller may use: account, adapter (google-dwd, google-oauth, mcp, apps-script, imap), the address it sends from, a label, and which surfaces may use it. Never a value.",
      input: obj({ on_behalf: behalf }),
      run: async (input, meta) => (await usable(meta, input)).list.map(view),
    });

    const addInput = {
      account: str, adapter: { type: "string", enum: ADAPTERS }, address: str, label: str,
      surfaces: obj({ capsule: { type: "boolean" }, chat: { type: "boolean" }, agents: { anyOf: [str, { type: "array", items: str }] } }),
      google: { type: "string", description: "google adapters: the google.accounts name" },
      server: { type: "string", description: "mcp: the hub server" }, map: { type: "object", description: "mcp: { send: { tool, to, subject, body, cc?, bcc? }, search?: { tool, q, limit? }, read?: { tool, id } }; guessed when left out" },
      auth: obj({ item: str, field: str }), username: str,
      imap: obj({ host: str, port: int, tls: str }), smtp: obj({ host: str, port: int, tls: str }),
    };

    /** Check and store an account; the one path for add and update. */
    async function save(input, before) {
      const adapter = input.adapter ?? before?.adapter;
      const merged = { ...(before ? before.config : {}), ...input };
      let config = configOf(adapter, merged);
      let address = named(input.address) || before?.address;
      if (isGoogle(adapter)) {
        const g = (await use("google.accounts", {})).find(x => x.name === config.google);
        if (!g) throw fail(`no Google account named ${config.google}; add it with google.add first`, "not_found");
        address = address || g.email;
      }
      if (adapter === "mcp") {
        const tools = (await use("mcp.tools", {})).filter(t => t.server === config.server);
        if (!tools.length) throw fail(`the MCP server ${config.server} has no tools cached; add it and run mcp.test first`, "not_found");
        const map = merged.map === undefined ? guess(tools) : merged.map;
        const problem = checkMap(map);
        if (problem) throw fail(problem);
        for (const verb of ["send", "search", "read"]) if (map[verb] && !tools.some(t => t.tool === map[verb].tool)) throw fail(`${config.server} has no tool ${map[verb].tool} that is on`);
        config = { ...config, map };
      }
      if (NATIVE.has(adapter)) {
        const problem = native[adapter].check({ ...config, address });
        if (problem) throw fail(problem);
      }
      if (!address) throw fail("address is required: the address mail is sent from");
      const acct = rows.put({ account: String(input.account), adapter, address, label: input.label ?? before?.label,
        surfaces: surfacesOf(input.surfaces, before ? before.surfaces : undefined), config }, now());
      await offer(acct);
      await register(acct);
      ctx.events.emit(before ? "mail.updated" : "mail.added", { account: acct.account, adapter: acct.adapter });
      return view(acct);
    }

    ctx.tool("mail.add", {
      description: "Connect a mail account. adapter google-dwd or google-oauth with `google` (a google.accounts name); mcp with `server` (a hub server) and an optional tool `map`, guessed from the server's tools; apps-script with auth.item (a vault env-set with url and token); imap with imap and smtp { host, port?, tls? }, username? and auth.item (the password). `surfaces` { capsule, chat, agents } says who may use it (default: the Capsule and chats, no agents). Credentials stay in the vault; grant each item to mail.",
      input: obj(addInput, ["account", "adapter"]),
      callers: MANAGERS,
      run: async input => {
        if (rows.get(input.account)) throw fail(`there is already a mail account named ${input.account}; use mail.update`, "exists");
        return save(input, null);
      },
    });

    ctx.tool("mail.update", {
      description: "Change a mail account: any field of mail.add. Use it to grant or take back surfaces, or to correct an MCP tool map.",
      input: obj(addInput, ["account"]),
      callers: MANAGERS,
      run: async input => {
        const before = rows.get(input.account);
        if (!before) throw fail(`no mail account named ${input.account}`, "not_found");
        if (input.adapter !== undefined && input.adapter !== before.adapter) throw fail("an account's adapter does not change; remove it and add it again");
        return save(input, before);
      },
    });

    ctx.tool("mail.remove", {
      description: "Remove a mail account. Its vault items and grants are left as they are; a mirrored Google account comes back while it is still in google.accounts.",
      input: obj({ account: str }, ["account"]),
      callers: MANAGERS,
      run: async ({ account: name }) => {
        const removed = rows.remove(name);
        if (removed) { await unregister(name); ctx.events.emit("mail.removed", { account: name }); }
        return { removed };
      },
    });

    ctx.tool("mail.test", {
      description: "Check a mail account without sending anything: whether it can search, read and send, and what is wrong if not.",
      input: obj({ account: str }, ["account"]),
      callers: MANAGERS,
      run: async ({ account: name }) => {
        const acct = rows.get(name);
        if (!acct) throw fail(`no mail account named ${name}`, "not_found");
        if (NATIVE.has(acct.adapter)) {
          try { return { account: name, ...(await native[acct.adapter].test(...nativeArgs(acct))) }; } catch (e) {
            const err = /** @type {any} */ (e);
            return { account: name, ok: false, can: { search: false, read: false, send: false }, error: String(err.message), code: err.code || "failed" };
          }
        }
        if (isGoogle(acct.adapter)) {
          const t = await use("google.test", { name: acct.config.google });
          const sc = t.scopes || {};
          return { account: name, ok: Boolean(t.ok), can: { search: Boolean(sc["gmail.readonly"]), read: Boolean(sc["gmail.readonly"]), send: Boolean(sc["gmail.send"]) }, ...(t.error ? { error: t.error } : {}) };
        }
        const t = await use("mcp.test", { name: acct.config.server });
        const tools = new Set((Array.isArray(t.tools) ? t.tools : []).map(x => (typeof x === "string" ? x : x.name)));
        const has = verb => Boolean(acct.config.map?.[verb]) && (tools.size === 0 || [...tools].some(n => n === acct.config.map[verb].tool || String(n).endsWith(`__${acct.config.map[verb].tool}`)));
        return { account: name, ok: Boolean(t.ok), can: { search: has("search"), read: has("read"), send: has("send") }, ...(t.error ? { error: t.error } : {}) };
      },
    });

    // ---- reads ----

    /** Search one account. Returns rows with `_at` for ordering. */
    async function searchOne(acct, q, limit) {
      if (isGoogle(acct.adapter)) {
        const r = await use("google.mail.search", { q, account: acct.config.google, limit });
        return (r.messages || []).map(m => ({ ...m, account: acct.account, _at: Date.parse(m.date) || 0 }));
      }
      if (acct.adapter === "mcp") {
        const m = acct.config.map?.search;
        if (!m) throw fail(`${acct.account} has no search tool mapped`, "unsupported");
        const r = await use("mcp.call", { server: acct.config.server, tool: m.tool, arguments: { [m.q]: q, ...(m.limit ? { [m.limit]: limit } : {}) } });
        if (r && r.held) throw fail(`${acct.config.server}'s ${m.tool} is held as outward; mark it read in Connections to search with it`, "held");
        return messagesOf(r, acct.account).slice(0, limit);
      }
      const [cfg, cred] = nativeArgs(acct);
      const list = acct.adapter === "imap"
        ? await native.imap.search(cfg, cred, { query: parseQuery(q), limit })
        : await native["apps-script"].search(cfg, cred, { q, limit });
      return list.map(m => ({ ...m, account: acct.account }));
    }

    ctx.tool("mail.search", {
      description: "Messages matching words, from:, to:, subject:, newer_than:7d or is:unread, newest first, across every account this caller may use unless one is named: { messages: [{ account, id, from, to, subject, date, snippet }], errors? }. Read one with mail.read { account, id }.",
      input: obj({ q: str, account, limit: int, on_behalf: behalf }, ["q"]),
      run: async (input, meta) => {
        const { list } = await usable(meta, input);
        const accts = named(input.account) ? [pickForSend(list, input.account)] : list;
        if (!accts.length) throw fail("no mail account is connected for this surface", "no_account");
        const limit = clamp(input.limit, 1, 25, 10);
        const errors = [];
        const found = await Promise.all(accts.map(a => searchOne(a, String(input.q), limit).catch(e => {
          const err = /** @type {any} */ (e);
          errors.push({ account: a.account, error: String(err.message).slice(0, 300), code: err.code || "failed" }); return [];
        })));
        if (errors.length === accts.length) throw fail(errors.map(e => `${e.account}: ${e.error}`).join("; "), errors[0].code, { errors });
        const messages = found.flat().sort((a, b) => b._at - a._at).slice(0, limit).map(({ _at, ...m }) => m);
        return { messages, ...(errors.length ? { errors } : {}) };
      },
    });

    ctx.tool("mail.read", {
      description: "One message as plain text with its headers, from the account mail.search named. `message_id` is what a reply's in_reply_to takes.",
      input: obj({ account, id: str, on_behalf: behalf }, ["account", "id"]),
      run: async (input, meta) => {
        const acct = pickForSend((await usable(meta, input)).list, input.account);
        return readOne(acct, String(input.id));
      },
    });

    async function readOne(acct, id) {
      if (isGoogle(acct.adapter)) return { ...(await use("google.mail.read", { id, account: acct.config.google })), account: acct.account };
      if (acct.adapter === "mcp") {
        const m = acct.config.map?.read;
        if (!m) throw fail(`${acct.account} has no read tool mapped`, "unsupported");
        const r = await use("mcp.call", { server: acct.config.server, tool: m.tool, arguments: { [m.id]: id } });
        if (r && r.held) throw fail(`${acct.config.server}'s ${m.tool} is held as outward; mark it read in Connections to read with it`, "held");
        return messageOf(r, acct.account, id);
      }
      const [cfg, cred] = nativeArgs(acct);
      return { ...(await native[acct.adapter].read(cfg, cred, { id })), account: acct.account };
    }

    // ---- sends ----

    const mailInput = { to: emails, subject: str, body: { type: "string", description: "plain text" }, cc: emails, bcc: emails,
      in_reply_to: { type: "string", description: "the Message-ID being answered, from mail.read" }, account, why: str, on_behalf: behalf };

    /** Hold one message at the Gate through the account's adapter. */
    async function holdSend(acct, to, c, why, s) {
      const on = filing(s);
      let held;
      if (isGoogle(acct.adapter)) {
        held = await use("google.mail.send", { account: acct.config.google, to, subject: c.subject, body: c.body, ...(c.cc ? { cc: c.cc } : {}), ...(c.bcc ? { bcc: c.bcc } : {}),
          ...(c.in_reply_to ? { in_reply_to: c.in_reply_to } : {}), ...(why ? { why } : {}), on_behalf: on });
        held = { held: held.held, via: `google:${acct.config.google}` };
      } else if (acct.adapter === "mcp") {
        const m = acct.config.map?.send;
        if (!m) throw fail(`${acct.account} has no send tool mapped`, "unsupported");
        const r = await use("mcp.call", { server: acct.config.server, tool: m.tool, arguments: sendArgs(m, to, c), hold: true, on_behalf: on });
        if (!r || !r.held) throw fail(`the hub did not hold this send on ${acct.config.server}; nothing was sent`, "failed");
        held = { held: r.held, via: `mcp:${acct.config.server}` };
      } else {
        const r = await use("gate.request", { kind: "send", via: `mail:${acct.account}`, to, content: c, ...(why ? { why } : {}), ...on });
        held = { held: r.id, via: `mail:${acct.account}` };
      }
      ctx.events.emit("mail.held", { account: acct.account, id: held.held, via: held.via }, s.thread ? { thread: s.thread } : undefined);
      return { ...held, account: acct.account,
        message: `Held at the Gate: "${c.subject || "(no subject)"}" to ${to.join(", ")} from ${acct.address} goes out once the user approves it in Vyre. Nothing was sent.` };
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
      description: "Send an email as the user from one of their accounts. It is always held at the Gate until the user approves it (and may edit it); returns { held, account, message }. With several accounts, name one from mail.accounts.",
      input: obj(mailInput, ["to", "subject", "body"]),
      run: async (input, meta) => {
        const { s, list } = await usable(meta, input);
        const acct = pickForSend(list, named(input.account));
        const { to, c } = contentOf(input);
        return holdSend(acct, to, c, named(input.why), s);
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
        const m = /^mail:([a-z][a-z0-9-]{0,31})$/.exec(String(it.via || ""));
        if (!m) throw fail(`${id} is not held for a mail account`);
        const acct = rows.get(m[1]);
        if (!acct) throw fail(`the mail account ${m[1]} was removed; add it again to send this`, "no_account");
        if (!NATIVE.has(acct.adapter)) throw fail(`${m[1]} sends through its own adapter, not mail.release`, "denied");
        const dest = addresses(to, "to");
        const c = { subject: content.subject, body: content.body, ...(content.cc ? { cc: addresses(content.cc, "cc") } : {}),
          ...(content.bcc ? { bcc: addresses(content.bcc, "bcc") } : {}), ...(named(content.in_reply_to) ? { in_reply_to: content.in_reply_to } : {}) };
        checkContent(dest, c);
        const [cfg, cred] = nativeArgs(acct);
        const out = await native[acct.adapter].send(cfg, cred, { to: dest, ...c });
        ctx.events.emit("mail.sent", { account: acct.account });
        return { ...out, account: acct.account };
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
        if (!list.length) return { rows: [] };
        const n = clamp(input.limit, 1, 20, 6);
        if (p.kind === "compose") {
          const { kind, ...fill } = p;
          const what = [fill.to || fill.name ? `to ${fill.to || fill.name}` : "", fill.subject ? `about ${fill.subject}` : ""].filter(Boolean).join(" ");
          return { rows: list.slice(0, n).map(a => ({ id: composeId(a.account, fill), kind: "compose",
            name: `Send from ${a.address}`, sub: [a.label || kindName(a.adapter), what].filter(Boolean).join(" · ") })) };
        }
        const errors = [];
        const found = await Promise.all(list.map(a => searchOne(a, p.q, n).catch(e => { errors.push(a.account); return []; })));
        const rowsOut = found.flat().sort((a, b) => b._at - a._at).slice(0, n)
          .map(m => ({ id: messageId(m.account, m.id), kind: "email", name: m.subject || "(no subject)", sub: [nameOf(m.from), list.length > 1 ? m.account : ""].filter(Boolean).join(" · ") }));
        return { rows: rowsOut };
      },
    });

    ctx.tool("mail.compose", {
      description: "The Capsule's action on a mail.find row. On a send row it holds the message at the Gate with what the words named (to, subject, body, each of which may be given here instead), for the user to finish and approve there; on a message row it gives the message as text.",
      input: obj({ id: str, to: emails, subject: str, body: str }, ["id"]),
      callers: PEOPLE,
      run: async (input, meta) => {
        const { s, list } = await usable(meta, input);
        const msg = parseMessageId(input.id);
        if (msg) return { kind: "email", message: await readOne(pickForSend(list, msg.account), msg.id) };
        const row = parseComposeId(input.id);
        if (!row) throw fail("that is not a mail row");
        const acct = pickForSend(list, row.account);
        const fill = { ...row.fill, ...(input.to !== undefined ? { to: input.to } : {}), ...(named(input.subject) ? { subject: input.subject } : {}), ...(named(input.body) ? { body: input.body } : {}) };
        let to = fill.to;
        if (!to && fill.name) to = await resolve(acct, fill.name);
        if (!to) throw fail(fill.name ? `no address found for ${fill.name} in ${acct.account}; say who it goes to with an address` : "say who it goes to: an address", "needs_to");
        const { to: dest, c } = contentOf({ to, subject: fill.subject || "", body: fill.body || "" });
        return { kind: "held", ...(await holdSend(acct, dest, c, "written in the Capsule", s)) };
      },
    });

    /** A person's address from a name, from the mail they sent this account. */
    async function resolve(acct, name) {
      const list = await searchOne(acct, `from:${/\s/.test(name) ? `"${name}"` : name}`, 5).catch(() => []);
      const low = name.toLowerCase();
      for (const m of list) {
        const addr = addressOf(m.from);
        if (addr && (nameOf(m.from).toLowerCase().includes(low) || addr.toLowerCase().includes(low))) return addr;
      }
      return undefined;
    }

    return { async stop() {} };
  },
};

function kindName(adapter) {
  return { "google-dwd": "Google (Workspace)", "google-oauth": "Google", mcp: "MCP", "apps-script": "Apps Script", imap: "IMAP" }[adapter] || adapter;
}
