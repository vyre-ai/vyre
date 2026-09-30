// @ts-check
// The push-credential manager (0.2 plan: vault.md "Push credentials", watchers.md 3.8). It holds
// one live IMAP IDLE connection per connected Google account and emits `vault.push` when new mail
// arrives, so nothing has to poll. It is a library: the module that owns the vault wires it up
// (see `pushTools`), passing what it needs as functions.
//
// Rules, and why:
// - A value never crosses a boundary, only a signal does. The access token is minted for each
//   (re)connect through the credential library, handed to imap.js for the login and dropped. It
//   is never in an event, a status row, a log line or an error: every message is scrubbed of
//   every value the credential library has touched.
// - `vault.push` carries ids and a little metadata (uid, sender, date), never a body and never a
//   subject. What to do about the mail is for whoever hears it; the read goes through Google's own
//   tools. `scope` rides on the event so a listener can hold it to the grant.
// - Granted per { projects, agents }, the same shape as the MCP hub. Only a person starts or stops
//   a connection; status shows a caller only what its scope allows.
// - An expired sign-in is never a silent dead connection. Google's Testing mode kills a refresh
//   token after 7 days (reviewer H1), and a login can also be refused for want of the mail scope.
//   Both end the watch and emit `vault.push.reconsent` once, with a plain reason, and status shows
//   state "needs-consent". A slow check (default every 6 hours, one token request) finds an expired
//   refresh token while the socket is still up, before the next drop would.
// - Drops are `vault.push.lost` with a reason, and `vault.push.resumed` when the connection is
//   back, so a listener can fall back to a delta check meanwhile and drop it after.

import { watch } from "./imap.js";
import { scrub } from "./auth.js";
import { IMAP_SCOPE } from "./google.js";

const CHECK_MS = 6 * 3600_000;
const fail = (msg, code = "bad_input") => Object.assign(new Error(msg), { code });
const isObj = v => Boolean(v) && typeof v === "object" && !Array.isArray(v);
const CONNECTION = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,199}$/;

/** The hub's grant shape, defaulting to everyone. */
export function normalizeScope(s) {
  if (s === undefined || s === null) return { projects: "*", agents: "*" };
  if (!isObj(s)) throw fail('scope is { projects: "*" | [ids], agents: "*" | [names] }');
  const one = (v, what) => {
    if (v === undefined || v === "*") return "*";
    if (!Array.isArray(v) || !v.every(x => typeof x === "string" && x)) throw fail(`scope.${what} must be "*" or a list`);
    return [...new Set(v)];
  };
  return { projects: one(s.projects, "projects"), agents: one(s.agents, "agents") };
}

const REASONS = {
  expired: "Google no longer accepts the saved sign-in. While a Google app is in Testing status this happens every 7 days. Sign in again to get instant mail alerts back.",
  scope: "Google's mail server refused the sign-in. Sign in again and leave the mail permission ticked.",
  unavailable: "This connection was not given the mail permission. Sign in again and leave it ticked.",
};

/**
 * @typedef {{ person?: boolean, agent?: string | null, thread?: string | null }} Who
 * @typedef {{ email: string, auth: { type: "oauth", item: string }, imap?: boolean, host?: string, port?: number }} Account
 * @typedef {{
 *   creds: { token: (auth: any, opts?: any) => Promise<string>, invalidate: (auth: any, scopes?: string[]) => void, secrets: () => string[] },
 *   account: (connection: string) => Promise<Account | null> | Account | null,
 *   emit: (type: string, payload: Record<string, unknown>) => void,
 *   log?: (message: string, fields?: Record<string, unknown>) => void,
 *   connect?: import("./imap.js").WatchOptions["connect"],
 *   agentProjects?: (agent: string) => Promise<string[] | "*">,
 *   threadProject?: (thread: string) => Promise<string | null>,
 *   now?: () => number, checkMs?: number, metaFields?: string[],
 *   idleMs?: number, noopMs?: number, noopFloorMs?: number, backoffMs?: number, maxBackoffMs?: number,
 *   sleep?: import("./imap.js").WatchOptions["sleep"],
 * }} PushDeps
 */

/** @param {PushDeps} deps */
export function pushManager(deps) {
  const log = deps.log || (() => {});
  const now = deps.now || Date.now;
  const meta = deps.metaFields || ["from", "date"];
  /** @type {Map<string, any>} */ const live = new Map();
  const clean = text => scrub(String(text ?? ""), deps.creds.secrets());

  async function inScope(entry, who) {
    if (who.person) return true;
    const { projects, agents } = entry.scope;
    if (who.agent) {
      if (agents !== "*" && !agents.includes(who.agent)) return false;
      if (projects === "*") return true;
      const ap = deps.agentProjects ? await deps.agentProjects(who.agent).catch(() => []) : [];
      return ap === "*" || (Array.isArray(ap) && ap.some(p => projects.includes(p)));
    }
    if (projects === "*") return true;
    const project = who.thread && deps.threadProject ? await deps.threadProject(who.thread).catch(() => null) : null;
    return Boolean(project && projects.includes(project));
  }

  const view = e => ({ connection: e.connection, state: e.state, since: e.since, scope: e.scope, ...(e.lastMail ? { last_mail: e.lastMail } : {}),
    ...(e.error ? { error: e.error } : {}), ...(e.reason ? { reconsent: e.reason } : {}) });

  function setState(e, state, error = "") {
    if (e.state !== state) { e.state = state; e.since = now(); }
    e.error = error;
  }

  /** The sign-in cannot continue: say so once, stop holding a socket, and wait to be started again. */
  function needsConsent(e, reason, message) {
    if (e.reason === reason && e.state === "needs-consent") return;
    e.watch?.stop();
    e.watch = null;
    e.checker?.abort();
    e.reason = reason;
    setState(e, "needs-consent", clean(message));
    deps.emit("vault.push.reconsent", { connection: e.connection, reason, message: REASONS[reason] || clean(message), at: now() });
    log("push needs a new sign-in", { connection: e.connection, reason });
  }

  function begin(e) {
    e.reason = null;
    let tries = 0;
    setState(e, "connecting");
    const w = watch({
      ...(deps.connect ? { connect: deps.connect } : {}),
      ...Object.fromEntries(["idleMs", "noopMs", "noopFloorMs", "backoffMs", "maxBackoffMs", "sleep"].filter(k => deps[k] !== undefined).map(k => [k, deps[k]])),
      log,
      auth: async () => {
        const acct = await deps.account(e.connection);
        if (!acct) throw fail("this connection is gone", "config");
        if (!acct.imap) throw Object.assign(fail(REASONS.unavailable, "unavailable"), { unavailable: true });
        e.host = acct.host; e.port = acct.port;
        // A token for each (re)connect, minted fresh after the first, never kept here.
        if (tries++) deps.creds.invalidate(acct.auth, [IMAP_SCOPE]);
        return { user: acct.email, token: await deps.creds.token(acct.auth, { scopes: [IMAP_SCOPE] }) };
      },
      ...(e.host ? { host: e.host } : {}), ...(e.port ? { port: e.port } : {}),
      onMail: mail => {
        const rows = mail.map(m => ({ uid: m.uid, ...Object.fromEntries(meta.filter(k => k !== "subject" && m[k]).map(k => [k, m[k]])) }));
        e.lastMail = now();
        deps.emit("vault.push", { connection: e.connection, kind: "mail.new", ids: mail.map(m => m.messageId || `uid:${m.uid}`),
          meta: rows, at: e.lastMail, scope: e.scope });
      },
      onState: (state, info) => {
        if (e.watch !== w) return;
        if (state === "idle" || state === "polling") {
          const back = e.state === "lost";
          setState(e, state);
          if (back) deps.emit("vault.push.resumed", { connection: e.connection, at: now() });
        } else if (state === "lost") {
          setState(e, "lost", clean(info?.message));
          deps.emit("vault.push.lost", { connection: e.connection, reason: String(info?.code || "closed"), at: now() });
        }
      },
    });
    e.watch = w;
    w.done.then(end => {
      if (e.watch !== w || end.code === "stopped") return;
      // The watch only ends on its own when retrying cannot help.
      const reason = end.code === "auth" ? "scope" : end.code === "unavailable" ? "unavailable" : "expired";
      if (["auth", "refused", "unavailable"].includes(end.code)) needsConsent(e, reason, end.message);
      else { setState(e, "failed", clean(end.message)); deps.emit("vault.push.lost", { connection: e.connection, reason: end.code, at: now() }); }
    });
    // The slow check: is the refresh token still good? A dead one is found now, not at the next drop.
    e.checker = new AbortController();
    (async () => {
      const every = deps.checkMs || CHECK_MS;
      while (!e.checker.signal.aborted) {
        await new Promise(r => { const t = setTimeout(r, every); t.unref?.(); e.checker.signal.addEventListener("abort", () => { clearTimeout(t); r(undefined); }, { once: true }); });
        if (e.checker.signal.aborted || e.watch !== w) return;
        try {
          const acct = await deps.account(e.connection);
          if (!acct?.imap) return needsConsent(e, "unavailable", REASONS.unavailable);
          deps.creds.invalidate(acct.auth, [IMAP_SCOPE]);
          await deps.creds.token(acct.auth, { scopes: [IMAP_SCOPE] });
        } catch (err) {
          if (/** @type {any} */ (err)?.oauthError === "invalid_grant") return needsConsent(e, "expired", String(/** @type {any} */ (err).message));
          log("push token check failed", { connection: e.connection });
        }
      }
    })();
  }

  const must = (input, key = "connection") => {
    const c = String(input?.[key] || "");
    if (!CONNECTION.test(c)) throw fail("connection must name a connection");
    return c;
  };

  return {
    /**
     * Hold a push connection for `connection`. Idempotent: a second start keeps the one socket and
     * updates the scope; starting one that needs a new sign-in tries again.
     * @param {{ connection: string, scope?: unknown }} input @param {Who} who
     */
    async start(input, who) {
      if (!who?.person) throw fail("only a person starts mail push", "forbidden");
      const connection = must(input);
      const scope = normalizeScope(input.scope);
      const acct = await deps.account(connection);
      if (!acct) throw fail(`no connection named ${connection}`, "not_found");
      let e = live.get(connection);
      if (e && e.state !== "needs-consent" && e.state !== "failed") { e.scope = scope; return view(e); }
      if (!e) { e = { connection, scope, state: "stopped", since: now(), error: "", watch: null, checker: null, reason: null, lastMail: 0 }; live.set(connection, e); }
      e.scope = scope;
      if (!acct.imap) { needsConsent(e, "unavailable", REASONS.unavailable); return view(e); }
      begin(e);
      return view(e);
    },

    /** @param {{ connection: string }} input @param {Who} who */
    async stop(input, who) {
      if (!who?.person) throw fail("only a person stops mail push", "forbidden");
      const connection = must(input);
      const e = live.get(connection);
      if (!e) throw fail(`mail push is not running for ${connection}`, "not_found");
      e.watch?.stop(); e.watch = null; e.checker?.abort();
      live.delete(connection);
      return { stopped: connection };
    },

    /** @param {{ connection?: string }} input @param {Who} who */
    async status(input, who) {
      const out = [];
      for (const e of live.values()) {
        if (input?.connection && e.connection !== input.connection) continue;
        if (await inScope(e, who || {})) out.push(view(e));
      }
      return out;
    },

    /** What to persist: the connections held and their scopes. */
    list: () => [...live.values()].map(e => ({ connection: e.connection, scope: e.scope })),

    /** After a restart, hold the connections that were held. @param {Array<{ connection: string, scope?: unknown }>} rows */
    async restore(rows) {
      for (const r of rows || []) { try { await this.start(r, { person: true }); } catch (e) { log("push restore skipped", { connection: String(r?.connection || "").slice(0, 80), code: /** @type {any} */ (e)?.code }); } }
    },

    /** Module stop: close every socket and timer. */
    close() {
      for (const e of live.values()) { e.watch?.stop(); e.watch = null; e.checker?.abort(); }
      live.clear();
    },
  };
}

/**
 * The three tools the owning module registers: connectors.push.start, .stop and .status. `who`
 * turns a tool call's meta into a Who. Their events (vault.push, vault.push.lost,
 * vault.push.resumed, vault.push.reconsent) go in that module's watches.emits.
 * @param {ReturnType<typeof pushManager>} m @param {(meta: any) => Who} who
 */
export function pushTools(m, who) {
  const str = { type: "string" };
  const scope = { type: "object", properties: { projects: { anyOf: [str, { type: "array", items: str }] }, agents: { anyOf: [str, { type: "array", items: str }] } } };
  return [
    { name: "connectors.push.start", callers: ["cli", "local", "deck", "capsule"], run: (input, meta) => m.start(input, who(meta)),
      description: "Hold a live mail connection for a connected Google account so new mail is announced as a vault.push event (ids and sender only, never the message). scope { projects, agents } says who may hear about it.",
      input: { type: "object", properties: { connection: str, scope }, required: ["connection"] } },
    { name: "connectors.push.stop", callers: ["cli", "local", "deck", "capsule"], run: (input, meta) => m.stop(input, who(meta)),
      description: "Close the live mail connection for a connection.", input: { type: "object", properties: { connection: str }, required: ["connection"] } },
    { name: "connectors.push.status", run: (input, meta) => m.status(input, who(meta)),
      description: "The live mail connections this caller may see: state (connecting, idle, polling, lost, needs-consent, failed), since, scope, and when mail last arrived. Never a value.",
      input: { type: "object", properties: { connection: str } } },
  ];
}
