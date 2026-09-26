// @ts-check
// google: native Google Calendar and Gmail (ADR 0016 decision 6).
//
// The assistant and the Capsule read the person's calendar and mail through these tools, over
// REST, with an OAuth refresh token or a domain-wide-delegation service account from the vault.
// Nothing runs in the background: no polling, no sync, no cache beyond the access tokens the
// credential library keeps in memory. Every call is on demand.
//
// What goes out as the person goes through the Gate (floor rules 1 and 2):
// - google.mail.send is always held. The Gate calls google.release with exactly what the person
//   approved, and only then is a gmail.send token minted.
// - google.calendar.create and .update are held when they name attendees, because Calendar mails
//   each one an invite; released writes use sendUpdates=all. Without attendees they write
//   directly with sendUpdates=none, so nobody hears of it.
// - google.mail.draft writes directly: a draft goes nowhere until the person sends it from Gmail.
// Each account is its own Gate sender, google:<account>, so the person sees which address a
// message or an invite would leave from.
//
// Every result and every error is scrubbed of every value the credential library touched, and
// events carry names, never content or values (floor rule 8).
//
// "Sign in with Google" (connect.js) gets the first refresh token: the module puts it in a vault
// item it makes for itself, google-<name>, granted to itself, and adds the account the way
// google.add does. Only people start, finish or cancel a sign-in; a model never can.

import { Credentials, CredentialError } from "../connectors/auth.js";
import { client, SCOPE, SCOPES } from "./api.js";
import { MIGRATIONS, check, store, forRead, forWrite, EMAIL, loopback } from "./accounts.js";
import { calendar, fieldsOf, dayRange } from "./calendar.js";
import { mail, addresses, checkMessage, addressOf, nameOf } from "./mail.js";
import { parse, parseRowId, eventRow, mailRow, whenText } from "./find.js";
import { connector } from "./connect.js";

const str = { type: "string" };
const int = { type: "integer" };
const emails = { anyOf: [str, { type: "array", items: str }], description: "an address, a comma list, or a list" };
const obj = (properties, required = []) => ({ type: "object", properties, required });
const PEOPLE = ["cli", "local", "deck", "capsule", "module"];
const account = { type: "string", description: "an account name from google.accounts; reads default to every account" };

/** What a held item of a google:<account> sender carries, for gate.senders. */
const CONTENT = {
  subject: "string (an email)", body: "string, plain text (an email)", cc: "email[]? (an email)", bcc: "email[]? (an email)",
  in_reply_to: "Message-ID? (an email reply)", thread_id: "Gmail thread id? (an email reply)",
  op: "create | update (an invite; `to` is the attendees)", event_id: "string (an invite update)", summary: "the event title (an invite)",
  start: "ISO time (an invite)", end: "ISO time? (an invite)", where: "string? (an invite)", description: "string? (an invite)", time_zone: "IANA zone? (an invite)",
};

const clamp = (v, lo, hi, dflt) => (Number.isInteger(v) ? Math.min(hi, Math.max(lo, v)) : dflt);
const named = v => (typeof v === "string" && v ? v : undefined);
const fail = (msg, code = "bad_input") => Object.assign(new Error(msg), { code });

/** @type {{ start(ctx: any): Promise<{ stop(): Promise<void> }> }} */
export default {
  async start(ctx) {
    ctx.store.migrate(MIGRATIONS);
    const accounts = store(ctx.store.db);
    const now = () => Date.now();
    const creds = new Credentials({
      fetchItem: (item, field) => ctx.vault.fetch(item, field ? { field } : {}),
      log: (m, f) => ctx.log(m, f),
    });
    const { request } = client({ creds });
    const cal = calendar({ request, now });
    const gm = mail({ request });

    /** Run a tool body and scrub what comes back, errors included; codes pass through. */
    const safe = fn => async (input, meta) => {
      try { return creds.scrubAll(await fn(input, meta)); } catch (e) {
        const err = /** @type {any} */ (e);
        throw Object.assign(new Error(creds.scrub(String(err?.message || err))), { code: typeof err?.code === "string" ? err.code : "failed" });
      }
    };

    const offer = async acct => {
      const r = await ctx.call("gate.offer", { name: `google:${acct.name}`, tool: "google.release", kinds: ["send"], content: CONTENT });
      if (r.error) ctx.log(`could not offer the google:${acct.name} sender: ${r.error.message}`);
    };
    for (const a of accounts.all()) await offer(a);

    /** Hold something at the Gate, filed under the model's own thread when vyred verified one. */
    const hold = async (acct, to, content, input, meta) => {
      const r = await ctx.call("gate.request", { kind: "send", via: `google:${acct.name}`, to, content,
        ...(named(input.why) ? { why: input.why } : {}), ...(meta && meta.thread ? { thread: meta.thread } : {}) });
      if (r.error) throw fail(r.error.message, r.error.code || "failed");
      return r.data.id;
    };

    // ---- accounts ----

    ctx.tool("google.accounts", {
      description: "The Google accounts Vyre can use: name, address, and which vault item authenticates it (never a value).",
      input: obj({}),
      run: safe(() => accounts.all()),
    });

    ctx.tool("google.add", {
      description: "Connect a Google account: `auth` names a vault item, an OAuth env-set (client_id, client_secret, refresh_token, token_uri) or a service-account JSON; a service account acts as `subject` (default: `email`) through domain-wide delegation. The item still needs `vyre vault grant <item> google`.",
      input: obj({ name: str, email: str, auth: obj({ type: { type: "string", enum: ["oauth", "service-account"] }, item: str, subject: str }, ["type", "item"]), base: str },
        ["name", "email", "auth"]),
      callers: PEOPLE,
      run: safe(input => addAccount(input)),
    });

    /** The one way an account is added, by google.add and by a finished sign-in. */
    async function addAccount(input) {
      const problem = check(input);
      if (problem) throw fail(problem);
      const acct = accounts.put(input, now());
      // A token cached for an item of the same name before must not outlive the new item.
      for (const s of SCOPES) creds.invalidate(acct.auth, [SCOPE + s]);
      await offer(acct);
      ctx.events.emit("google.added", { name: acct.name });
      return acct;
    }

    // ---- sign in with Google ----

    const signIn = connector({
      fetchItem: (item, field) => ctx.vault.fetch(item, { field }),
      taken: name => Boolean(accounts.get(name)),
      // The item a sign-in will make must be free, or one this module made before.
      blocked: async item => {
        const r = await ctx.call("vault.list", { filter: item });
        const old = r.data?.items?.find(x => x.name === item);
        return old && old.origin !== "module:google" ? `the vault already has an item named ${item} that Vyre's Google sign-in did not make; rename or delete it first` : null;
      },
      save: async (item, fields) => {
        const r = await ctx.call("vault.put", { name: item, kind: "env-set", description: "Google sign-in (made by Vyre)", fields, grants: ["google"] });
        if (r.error) throw fail(`could not save the sign-in in the vault: ${r.error.message}`, r.error.code || "vault");
      },
      add: async acct => { await addAccount(acct); },
      emit: (type, payload) => ctx.events.emit(type, payload),
      log: (m, x) => ctx.log(m, x),
    });

    ctx.tool("google.connect", {
      description: "Start \"Sign in with Google\": `client` names a vault env-set with the OAuth client's client_id and client_secret (and optionally auth_uri, token_uri), granted to google. Returns { id, url, redirect }: open `url` in a browser. When Google sends the browser back, the account is added as `name` and google.connected is emitted. A browser on another device cannot reach `redirect`; paste the address it landed on into google.connect.finish.",
      input: obj({ name: str, client: str, base: str }, ["name", "client"]),
      callers: PEOPLE,
      run: async ({ name, client, base }) => {
        if (base !== undefined && !loopback(base)) throw fail("base must be a loopback origin such as http://127.0.0.1:8080 (it exists for test fakes)");
        return signIn.start({ name, client, base });
      },
    });

    ctx.tool("google.connect.finish", {
      description: "Finish a sign-in with the whole address the browser landed on (for a browser on another device). Returns { name, email, item }.",
      input: obj({ id: str, url: str }, ["id", "url"]),
      callers: PEOPLE,
      run: input => signIn.finish(input),
    });

    ctx.tool("google.connect.cancel", {
      description: "Cancel an open sign-in.",
      input: obj({ id: str }, ["id"]),
      callers: PEOPLE,
      run: input => signIn.cancel(input),
    });

    ctx.tool("google.remove", {
      description: "Disconnect a Google account. The vault item stays; its grant is the vault's to revoke.",
      input: obj({ name: str }, ["name"]),
      callers: PEOPLE,
      run: safe(async ({ name }) => {
        const removed = accounts.remove(name);
        if (removed) ctx.events.emit("google.removed", { name });
        return { removed };
      }),
    });

    ctx.tool("google.test", {
      description: "Check an account: mint a token for each scope Vyre uses and make a harmless call with each. Names any scope that is refused.",
      input: obj({ name: str }),
      callers: PEOPLE,
      run: safe(async ({ name }) => {
        const acct = forWrite(accounts.all(), named(name));
        const out = await testAccount(acct);
        return acct.auth.type === "service-account" ? { ...out, ...(await delegation(acct)) } : out;
      }),
    });

    /**
     * What a Workspace admin pastes under Security, API controls, Domain-wide delegation: the
     * service account's numeric client ID (a public identifier) and the exact scope line. The
     * key's other fields never leave this function.
     */
    async function delegation(acct) {
      const admin_scopes = SCOPES.map(s => SCOPE + s).join(",");
      let client_id;
      try {
        const key = JSON.parse(await ctx.vault.fetch(acct.auth.item, acct.auth.field ? { field: acct.auth.field } : {}));
        if (/^\d{5,30}$/.test(String(key?.client_id ?? ""))) client_id = String(key.client_id);
      } catch {}
      return { ...(client_id ? { client_id } : {}), admin_scopes };
    }

    /** @param {any} acct */
    async function testAccount(acct) {
      /** @type {Record<string, boolean>} */
      const scopes = {};
      const why = {};
      const sa = acct.auth.type === "service-account";
      // A service account's refusals come at mint time: domain-wide delegation is per scope.
      if (sa) {
        for (const s of SCOPES) {
          try { await creds.token(acct.auth, { scopes: [SCOPE + s] }); scopes[s] = true; } catch (e) {
            const err = /** @type {any} */ (e);
            if (err instanceof CredentialError && (err.oauthError === "unauthorized_client" || err.oauthError === "invalid_scope")) { scopes[s] = false; why[s] = "refused"; continue; }
            return { ok: false, account: acct.name, scopes: Object.fromEntries(SCOPES.map(x => [x, false])), error: creds.scrub(err.message) };
          }
        }
      }
      // Then one harmless call per scope. The writes send a body Google must refuse (400) once it
      // has accepted the token's scope, so nothing is created, drafted or sent; a 403 is the refusal.
      const probes = {
        "calendar.readonly": { api: "calendar", method: "GET", path: "/calendar/v3/users/me/calendarList", query: { maxResults: 1 } },
        "gmail.readonly": { api: "gmail", method: "GET", path: "/gmail/v1/users/me/messages", query: { maxResults: 1 } },
        "calendar.events": { api: "calendar", method: "POST", path: "/calendar/v3/calendars/primary/events", query: { sendUpdates: "none" }, body: {}, write: true },
        "gmail.compose": { api: "gmail", method: "POST", path: "/gmail/v1/users/me/drafts", body: { message: { raw: "" } }, write: true },
        "gmail.send": { api: "gmail", method: "POST", path: "/gmail/v1/users/me/messages/send", body: { raw: "" }, write: true },
      };
      for (const s of SCOPES) {
        if (scopes[s] === false) continue;
        // A service account whose write scope minted is allowed it; no need to knock on a write.
        if (sa && probes[s].write) continue;
        try {
          await request(acct, { ...probes[s], scope: s });
          scopes[s] = true;
        } catch (e) {
          const err = /** @type {any} */ (e);
          if (probes[s].write && err.status === 400) { scopes[s] = true; continue; }
          if (err instanceof CredentialError) return { ok: false, account: acct.name, scopes: Object.fromEntries(SCOPES.map(x => [x, false])), error: creds.scrub(err.message) };
          scopes[s] = false;
          why[s] = err.status === 403 ? "refused" : creds.scrub(err.message);
        }
      }
      const refused = SCOPES.filter(s => !scopes[s]);
      if (!refused.length) return { ok: true, account: acct.name, scopes };
      const full = refused.map(s => SCOPE + s).join(", ");
      const other = refused.filter(s => why[s] && why[s] !== "refused").map(s => `${s}: ${why[s]}`);
      const error = (sa
        ? `Refused: ${refused.join(", ")}. Allow ${full} for this service account's client ID in the Google Workspace admin console, under Security, API controls, Domain-wide delegation.`
        : `Refused: ${refused.join(", ")}. The OAuth consent behind this refresh token does not include ${full}; consent again with them and put the new refresh token in the vault.`)
        + (other.length ? ` (${other.join("; ")})` : "");
      return { ok: false, account: acct.name, scopes, error };
    }

    // ---- calendar ----

    ctx.tool("google.calendar.next", {
      description: "The next events, across every account unless one is named: [{id, account, title, start, end, where, attendees, url}].",
      input: obj({ account, limit: int }),
      run: safe(({ account: a, limit }) => cal.next(forRead(accounts.all(), named(a)), { limit: clamp(limit, 1, 50, 5) })),
    });

    ctx.tool("google.calendar.list", {
      description: "Events between two times (ISO 8601), across every account unless one is named.",
      input: obj({ from: str, to: str, account, limit: int }, ["from", "to"]),
      run: safe(({ from, to, account: a, limit }) => cal.list(forRead(accounts.all(), named(a)), { from, to, limit: clamp(limit, 1, 100, 25) })),
    });

    ctx.tool("google.calendar.search", {
      description: "Events matching words (title, description, place, attendees), from 30 days ago unless `from` says otherwise.",
      input: obj({ q: str, from: str, to: str, account, limit: int }, ["q"]),
      run: safe(({ q, from, to, account: a, limit }) => cal.search(forRead(accounts.all(), named(a)), { q, from, to, limit: clamp(limit, 1, 50, 10) })),
    });

    const eventInput = { title: str, start: { type: "string", description: "ISO 8601 time, or a date for all day" }, end: str, where: str, description: str,
      attendees: { ...emails, description: "attendee addresses; naming any holds the invite at the Gate" }, time_zone: str, account, why: str };

    ctx.tool("google.calendar.create", {
      description: "Create an event. Without attendees it is written at once and nobody is told. With attendees an invite would go out, so it is held at the Gate for the user: returns { held, message }.",
      input: obj(eventInput, ["title", "start"]),
      run: safe(async (input, meta) => {
        const acct = forWrite(accounts.all(), named(input.account));
        const fields = fieldsOf(input, { create: true });
        const to = addresses(input.attendees, "attendees");
        if (!to.length) {
          const event = await cal.write(acct, { op: "create", fields, sendUpdates: "none" });
          ctx.events.emit("google.scheduled", { account: acct.name, op: "create" });
          return { event };
        }
        const id = await hold(acct, to, heldEvent("create", input), input, meta);
        return { held: id, message: `Held at the Gate: the invite goes to ${to.join(", ")} from ${acct.email} once the user approves it in Vyre. Nothing was created yet.` };
      }),
    });

    ctx.tool("google.calendar.update", {
      description: "Change an event: only the fields given. Without a change to attendees it is written at once with no notice to anyone. Giving `attendees` (the full new list) holds it at the Gate, since Calendar mails them: returns { held, message }.",
      input: obj({ id: str, ...eventInput }, ["id"]),
      run: safe(async (input, meta) => {
        const acct = forWrite(accounts.all(), named(input.account));
        const fields = fieldsOf(input, { create: false });
        const to = input.attendees === undefined ? [] : addresses(input.attendees, "attendees");
        if (!to.length) {
          const event = await cal.write(acct, { op: "update", event_id: input.id, fields,
            ...(input.attendees !== undefined ? { attendees: [] } : {}), sendUpdates: "none" });
          ctx.events.emit("google.scheduled", { account: acct.name, op: "update" });
          return { event };
        }
        const id = await hold(acct, to, heldEvent("update", input), input, meta);
        return { held: id, message: `Held at the Gate: the updated invite goes to ${to.join(", ")} from ${acct.email} once the user approves it in Vyre. Nothing was changed yet.` };
      }),
    });

    /** An invite as the person will see and may edit it at the Gate: plain words, not Calendar's JSON. */
    function heldEvent(op, input) {
      const c = { op, ...(op === "update" ? { event_id: String(input.id) } : {}) };
      for (const [from, to] of [["title", "summary"], ["start", "start"], ["end", "end"], ["where", "where"], ["description", "description"], ["time_zone", "time_zone"]]) {
        if (input[from] !== undefined) c[to] = String(input[from]);
      }
      return c;
    }

    // ---- mail ----

    ctx.tool("google.mail.search", {
      description: "Messages matching a Gmail query (from:dana, subject:invoice, newer_than:7d, is:unread, plain words), newest first, across every account unless one is named: [{id, thread_id, account, from, to, subject, date, snippet, url}].",
      input: obj({ q: str, account, limit: int }, ["q"]),
      run: safe(({ q, account: a, limit }) => gm.search(forRead(accounts.all(), named(a)), { q, limit: clamp(limit, 1, 25, 10) })),
    });

    ctx.tool("google.mail.read", {
      description: "One message (`id`) or a whole thread (`thread_id`) as plain text with its headers; bodies are capped near 20,000 characters. `message_id` is what a reply's in_reply_to takes.",
      input: obj({ id: str, thread_id: str, account }),
      run: safe(async ({ id, thread_id, account: a }) => {
        if (!named(id) && !named(thread_id)) throw fail("give the message's id or a thread_id");
        let last;
        // Without an account, the message is in whichever account has it.
        for (const acct of forRead(accounts.all(), named(a))) {
          try { return await gm.read(acct, { id, thread_id: named(thread_id) }); } catch (e) {
            last = e;
            if (/** @type {any} */ (e).status !== 404) throw e;
          }
        }
        throw last;
      }),
    });

    const mailInput = { to: emails, subject: str, body: { type: "string", description: "plain text" }, cc: emails, bcc: emails,
      in_reply_to: { type: "string", description: "the Message-ID being answered, from google.mail.read" }, thread_id: str, account };

    /** The content of an email from a tool's input, checked. */
    const mailContent = input => {
      const to = addresses(input.to, "to");
      const c = { subject: String(input.subject ?? ""), body: String(input.body ?? "") };
      const cc = addresses(input.cc, "cc"), bcc = addresses(input.bcc, "bcc");
      if (cc.length) c.cc = cc;
      if (bcc.length) c.bcc = bcc;
      if (named(input.in_reply_to)) c.in_reply_to = input.in_reply_to;
      if (named(input.thread_id)) c.thread_id = input.thread_id;
      checkMessage(to, c);
      return { to, c };
    };

    ctx.tool("google.mail.draft", {
      description: "Put an email in Gmail's drafts. It goes nowhere: the user sends it from Gmail, or you ask with google.mail.send.",
      input: obj(mailInput, ["to", "subject", "body"]),
      run: safe(async input => {
        const acct = forWrite(accounts.all(), named(input.account));
        const { to, c } = mailContent(input);
        const out = await gm.draft(acct, to, c);
        ctx.events.emit("google.drafted", { account: acct.name });
        return out;
      }),
    });

    ctx.tool("google.mail.send", {
      description: "Send an email as the user. It is always held at the Gate until the user approves it (and may edit it); returns { held, message }. Nothing is sent from here.",
      input: obj({ ...mailInput, why: str }, ["to", "subject", "body"]),
      run: safe(async (input, meta) => {
        const acct = forWrite(accounts.all(), named(input.account));
        const { to, c } = mailContent(input);
        const id = await hold(acct, to, c, input, meta);
        return { held: id, message: `Held at the Gate: "${c.subject}" to ${to.join(", ")} from ${acct.email} goes out once the user approves it in Vyre.` };
      }),
    });

    ctx.tool("google.release", {
      internal: true,
      description: "The Gate's call once the user approved a held email or invite: sends exactly the approved `to` and content.",
      input: obj({ id: str, to: { type: "array", items: str }, content: { type: "object" } }, ["id", "to", "content"]),
      run: safe(async ({ id, to, content }, { caller }) => {
        if (caller !== "module:gate") throw fail("only the Gate releases what goes out", "denied");
        const item = await ctx.call("gate.get", { id });
        const via = item.data && item.data.via;
        const m = /^google:([a-z][a-z0-9-]{0,31})$/.exec(String(via || ""));
        if (!m) throw fail(`${id} is not held for a Google account`);
        const acct = accounts.get(m[1]);
        if (!acct) throw fail(`the Google account ${m[1]} was removed; add it again to send this`, "no_account");
        const dest = addresses(to, "to");
        if (content.op !== undefined) {
          if (content.op !== "create" && content.op !== "update") throw fail("op must be create or update");
          if (content.op === "update" && !named(content.event_id)) throw fail("an invite update needs event_id");
          if (!dest.length) throw fail("an invite needs at least one attendee");
          const fields = fieldsOf({ title: content.summary, start: content.start, end: content.end, where: content.where,
            description: content.description, time_zone: content.time_zone }, { create: content.op === "create" });
          const event = await cal.write(acct, { op: content.op, event_id: content.event_id, fields, attendees: dest, sendUpdates: "all" });
          ctx.events.emit("google.sent", { account: acct.name, what: "invite" });
          return { event_id: event.id, url: event.url, attendees: event.attendees };
        }
        checkMessage(dest, content);
        const out = await gm.send(acct, dest, content);
        ctx.events.emit("google.sent", { account: acct.name, what: "email" });
        return out;
      }),
    });

    // ---- the Capsule ----

    ctx.tool("google.find", {
      description: "The Capsule's results: \"what's next\", \"today\", \"tomorrow\", \"email from dana\", \"email about invoice\", or any words (a few events and a few messages). { rows: [{ id, name, kind, sub }] }.",
      input: obj({ q: str, limit: int }, ["q"]),
      run: safe(async ({ q, limit }) => {
        const all = accounts.all();
        if (!all.length) return { rows: [] };
        const n = clamp(limit, 1, 20, 5), at = now(), many = all.length > 1;
        const p = parse(q);
        const events = list => list.events.map(e => eventRow(e, at, many));
        const msgs = list => list.messages.map(x => mailRow(x, at, many, nameOf));
        const none = () => ({ events: [], messages: [] });
        if (p.kind === "next") return { rows: events(await cal.next(all, { limit: n })) };
        if (p.kind === "day") return { rows: events(await cal.list(all, { ...dayRange(at, p.offset), limit: n })) };
        if (p.kind === "mail") return { rows: msgs(await gm.search(all, { q: p.q, limit: n })) };
        const half = Math.max(1, Math.ceil(n / 2));
        const [e, m] = await Promise.all([cal.search(all, { q: p.q, limit: half }).catch(none), gm.search(all, { q: p.q, limit: half }).catch(none)]);
        return { rows: [...events(e), ...msgs(m)].slice(0, n) };
      }),
    });

    ctx.tool("google.open", {
      description: "A Capsule action on a google.find row: `as: \"open\"` (default) gives the event's or message's url and a line about it; `as: \"reply\"` puts an empty reply to the message in Gmail's drafts, which goes nowhere.",
      input: obj({ id: str, as: { type: "string", enum: ["open", "reply"] } }, ["id"]),
      run: safe(async ({ id, as = "open" }) => {
        const r = parseRowId(id);
        if (!r) throw fail("that is not a Google result");
        const acct = accounts.get(r.account);
        if (!acct) throw fail(`no Google account named ${r.account}`, "no_account");
        if (r.kind === "event") {
          if (as === "reply") throw fail("An event has no reply; open it instead.");
          const e = await cal.get(acct, r.id);
          return { kind: "event", url: e.url, said: [e.title, whenText(e.start, now()), e.where].filter(Boolean).join(", "), event: e };
        }
        const m = await gm.meta(acct, r.id);
        const h = Object.fromEntries((m.payload?.headers || []).map(x => [String(x.name).toLowerCase(), String(x.value)]));
        const msg = { id: String(m.id), thread_id: String(m.threadId || ""), from: h.from || "", subject: h.subject || "(no subject)" };
        const url = `https://mail.google.com/mail/?authuser=${encodeURIComponent(acct.email)}#all/${encodeURIComponent(msg.thread_id || msg.id)}`;
        if (as === "open") return { kind: "email", url, said: `${msg.subject}, from ${nameOf(msg.from)}`, message: msg };
        const to = addressOf(h["reply-to"] || h.from);
        if (!to || !EMAIL.test(to)) throw fail("this message has no address to reply to");
        const subject = /^re:/i.test(msg.subject) ? msg.subject : `Re: ${msg.subject}`;
        const mid = /^<[^<>\s]+>$/.test(h["message-id"] || "") ? h["message-id"] : undefined;
        await gm.draft(acct, [to], { subject: subject.replace(/[\r\n]+/g, " "), body: "", ...(mid ? { in_reply_to: mid, references: h.references } : {}),
          ...(msg.thread_id ? { thread_id: msg.thread_id } : {}) });
        ctx.events.emit("google.drafted", { account: acct.name });
        return { kind: "draft", url, said: `A reply to ${nameOf(msg.from)} is in your Gmail drafts. Nothing was sent.` };
      }),
    });

    return { async stop() { signIn.stop(); } };
  },
};
