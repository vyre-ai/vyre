// @ts-check
// apps-script: the mail adapter for a person's own Google Apps Script web app (ADR 0016 decision 8).
//
// The person pastes core/mail/apps-script.gs into a new Apps Script project, deploys it as a web
// app that runs as them, and keeps its /exec URL and a random token in the vault as one env-set
// {url, token}. Vyre POSTs JSON to that URL; the script searches, reads and sends their Gmail.
//
// Rules, and why:
// - The url must be a script.google.com web app URL (https://script.google.com/macros/s/<id>/exec,
//   or the Workspace form /a/macros/<domain>/s/<id>/exec). A loopback origin is allowed too, for
//   the test fakes. Anything else is refused before a request, so the token only ever goes to
//   Google.
// - The token travels in the POST body, never in the URL, where logs and history keep it.
// - Apps Script answers a POST with a 302 to https://script.googleusercontent.com/macros/echo?...
//   That one redirect is followed, as a GET with no body and no token, and only to that host (or,
//   for a loopback url, the same origin). Any other redirect is refused ("redirect"): a redirect
//   to Google's sign-in page means the deployment is not open to "Anyone" ("not_web_app").
// - One timer covers the whole call, both requests and the body, and a body over 2 MB is refused.
// - An answer that is not the script's JSON (Google's HTML sign-in page, a 404) is "not_web_app",
//   with a message saying how to deploy.
// - Every result and every error is scrubbed of the url, the deployment id and the token, since a
//   script or Google can echo what it was sent. Errors carry a `code`.
// - This file never holds or sends a message on its own: `mail` puts every send through the Gate
//   first and calls send() only on release.

import { scrub, scrubAll } from "../connectors/auth.js";
import { EMAIL, addresses, checkContent } from "../connectors/message.js";

export const MAX_RESPONSE = 2 * 1024 * 1024;
export const DEFAULT_TIMEOUT = 30_000;
const ECHO_HOST = "script.googleusercontent.com";
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);
const EXEC_PATH = /^\/(?:a\/macros\/[A-Za-z0-9.-]+|macros)\/s\/([A-Za-z0-9_-]{10,200})\/exec$/;
const MAX_LIMIT = 25;
const BODY_CAP = 20_000;
const DEPLOY_HINT = "Deploy the script as a web app with Execute as: Me and Who has access: Anyone, and use the /exec URL it shows.";

/** @param {string} code @param {string} message */
const fail = (code, message) => Object.assign(new Error(message), { code });

/**
 * @typedef {{ address: string, auth: { item: string } }} AppsScriptConfig
 * @typedef {(name: "url" | "token") => Promise<string>} Field
 */

/** Check the url and say whether it is a loopback fake. @param {unknown} raw */
function checkUrl(raw) {
  let u;
  try { u = new URL(String(raw ?? "")); } catch { throw fail("bad_config", "the Apps Script url is not a valid URL. " + DEPLOY_HINT); }
  if (u.username || u.password) throw fail("bad_config", "the Apps Script url cannot carry a user name or password");
  if (u.search || u.hash) throw fail("bad_config", "the Apps Script url must end in /exec, with no query string");
  if (u.protocol === "https:" && u.hostname === "script.google.com" && !u.port && EXEC_PATH.test(u.pathname)) return { u, loopback: false };
  if ((u.protocol === "http:" || u.protocol === "https:") && LOOPBACK.has(u.hostname)) return { u, loopback: true };
  throw fail("bad_config", "the Apps Script url must look like https://script.google.com/macros/s/<deployment id>/exec. " + DEPLOY_HINT);
}

/** @param {Response} res */
const isRedirect = res => (res.status >= 300 && res.status < 400) || res.type === "opaqueredirect";

/** Where the one allowed redirect may go. @param {Response} res @param {URL} from @param {boolean} loopback */
function redirectTarget(res, from, loopback) {
  const loc = res.headers.get("location");
  let t;
  try { t = loc ? new URL(loc, from) : null; } catch { t = null; }
  if (!t) throw fail("redirect", "the Apps Script web app answered with a redirect that names no place");
  if (t.username || t.password) throw fail("redirect", "the Apps Script web app redirected to a URL with a user name or password; refused");
  if (loopback ? t.origin === from.origin : t.protocol === "https:" && t.hostname === ECHO_HOST && !t.port) return t;
  if (!loopback && /(^|\.)accounts\.google\.com$/.test(t.hostname)) {
    throw fail("not_web_app", "the Apps Script web app asked for a Google sign-in, so it is not open to Anyone. " + DEPLOY_HINT);
  }
  throw fail("redirect", `the Apps Script web app redirected to ${t.host}; only ${loopback ? "the same origin" : ECHO_HOST} is followed, so the request was stopped`);
}

/** Read a whole body, refusing one over the cap. @param {Response} res */
async function readCapped(res) {
  const len = Number(res.headers.get("content-length") || 0);
  const tooLarge = () => fail("too_large", `the Apps Script answer is over ${MAX_RESPONSE} bytes`);
  if (len > MAX_RESPONSE) { res.body?.cancel().catch(() => {}); throw tooLarge(); }
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_RESPONSE) { reader.cancel().catch(() => {}); throw tooLarge(); }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** The script's JSON, or the reason it is not. @param {Response} res @param {string} text */
function answer(res, text) {
  let j;
  try { j = JSON.parse(text); } catch { j = undefined; }
  if (!j || typeof j !== "object" || typeof j.ok !== "boolean") {
    const status = res.ok ? "" : ` (HTTP ${res.status})`;
    throw fail("not_web_app", `the Apps Script url did not answer as Vyre's script${status}. ` + DEPLOY_HINT);
  }
  if (j.ok) return j.data;
  const code = typeof j.code === "string" && /^[a-z_]{1,32}$/.test(j.code) ? j.code : "script";
  if (code === "auth") throw fail("auth", "the Apps Script web app refused the token: the vault's token must equal the script's VYRE_TOKEN property");
  throw fail(code, typeof j.error === "string" && j.error ? `the script said: ${j.error.slice(0, 500)}` : "the script refused the request");
}

/** A copy of an error with its message and fields scrubbed. @param {any} e @param {string[]} values */
function clean(e, values) {
  const extra = e && typeof e === "object" ? scrubAll({ ...e }, values) : {};
  return Object.assign(new Error(scrub(e?.message ?? e, values)), extra, { code: e?.code || "mail" });
}

/**
 * The Apps Script adapter.
 * @param {{ fetch?: typeof fetch, timeout?: number }} [deps]
 */
export function appsScriptAdapter(deps = {}) {
  const f = deps.fetch || fetch;
  const timeout = deps.timeout || DEFAULT_TIMEOUT;

  /** @param {Field} field @param {string} op @param {Record<string, unknown>} args */
  async function call(field, op, args) {
    /** @type {string[]} */
    const values = [];
    try {
      const rawUrl = await field("url");
      values.push(String(rawUrl ?? ""));
      const token = await field("token");
      values.push(String(token ?? ""));
      if (typeof token !== "string" || token.length < 16) {
        throw fail("bad_config", "the Apps Script token is missing or shorter than 16 characters; set a long random VYRE_TOKEN and keep the same value in the vault");
      }
      const { u, loopback } = checkUrl(rawUrl);
      const id = /\/s\/([^/]+)\/exec$/.exec(u.pathname)?.[1];
      if (id) values.push(id);

      const ac = new AbortController();
      let timedOut = false;
      const timer = setTimeout(() => { timedOut = true; ac.abort(); }, timeout);
      /** @param {URL} to @param {RequestInit} init */
      const go = async (to, init) => {
        try { return await f(to, { ...init, redirect: "manual", signal: ac.signal }); } catch (e) {
          if (timedOut) throw e;
          throw fail("unreachable", `could not reach the Apps Script web app: ${/** @type {any} */ (e)?.cause?.code || /** @type {any} */ (e)?.code || "network error"}`);
        }
      };
      try {
        let res = await go(u, {
          method: "POST",
          headers: { "content-type": "application/json", accept: "application/json" },
          body: JSON.stringify({ ...args, op, token }),
        });
        if (isRedirect(res)) {
          res.body?.cancel().catch(() => {});
          const next = redirectTarget(res, u, loopback);
          res = await go(next, { method: "GET", headers: { accept: "application/json" } });
          if (isRedirect(res)) {
            res.body?.cancel().catch(() => {});
            throw fail("redirect", "the Apps Script answer redirected a second time; only one redirect is followed");
          }
        }
        return scrubAll(answer(res, await readCapped(res)), values);
      } catch (e) {
        if (timedOut) throw fail("timeout", `the Apps Script web app did not answer within ${timeout} ms`);
        throw e;
      } finally {
        clearTimeout(timer);
      }
    } catch (e) {
      throw clean(e, values);
    }
  }

  const str = v => (typeof v === "string" ? v : "");

  return {
    /** A problem with the account's config, or null. @param {any} cfg */
    check(cfg) {
      if (!cfg || typeof cfg !== "object") return "an Apps Script account needs a config";
      if (typeof cfg.address !== "string" || !EMAIL.test(cfg.address)) return "an Apps Script account needs the Gmail address the script runs as";
      if (!cfg.auth || typeof cfg.auth.item !== "string" || !cfg.auth.item.trim()) return "an Apps Script account needs auth.item: the vault env-set holding url and token";
      return null;
    },

    /** The vault items this account uses. @param {AppsScriptConfig} cfg */
    items(cfg) { return [cfg.auth.item]; },

    /**
     * A harmless call that proves the url, the token and whose Gmail it is. Never sends.
     * @param {AppsScriptConfig} cfg @param {Field} field
     * @returns {Promise<{ ok: boolean, can: { search: boolean, read: boolean, send: boolean }, address?: string, error?: string, code?: string }>}
     */
    async test(cfg, field) {
      const none = { search: false, read: false, send: false };
      try {
        const data = await call(field, "test", {});
        const address = str(data?.address);
        if (!address) return { ok: false, can: none, error: "the script did not say which Gmail account it runs as", code: "script" };
        if (address.toLowerCase() !== String(cfg.address).toLowerCase()) {
          return { ok: false, can: none, address, code: "wrong_account",
            error: `the script runs as ${address}, not ${cfg.address}; deploy it from ${cfg.address}'s Google account, or add the account as ${address}` };
        }
        return { ok: true, can: { search: true, read: true, send: true }, address };
      } catch (e) {
        return { ok: false, can: none, error: String(/** @type {any} */ (e).message), code: /** @type {any} */ (e).code };
      }
    },

    /**
     * Gmail search, the latest message of each thread. `q` is Gmail syntax, passed as is.
     * @param {AppsScriptConfig} cfg @param {Field} field @param {{ q: string, limit?: number }} input
     */
    async search(cfg, field, { q, limit } = /** @type {any} */ ({})) {
      if (typeof q !== "string") throw fail("bad_input", "search needs q");
      const n = Math.min(MAX_LIMIT, Math.max(1, Math.floor(Number(limit) || 10)));
      const data = await call(field, "search", { q, limit: n });
      if (!Array.isArray(data)) throw fail("script", "the script's search answer is not a list");
      return data.slice(0, n).map(m => ({
        id: str(m?.id), thread_id: str(m?.thread_id), from: str(m?.from), to: str(m?.to),
        subject: str(m?.subject), date: str(m?.date), snippet: str(m?.snippet).slice(0, 200),
        _at: Date.parse(str(m?.date)) || 0,
      }));
    },

    /** One message as text. @param {AppsScriptConfig} cfg @param {Field} field @param {{ id: string }} input */
    async read(cfg, field, { id } = /** @type {any} */ ({})) {
      if (typeof id !== "string" || !/^[A-Za-z0-9_-]{1,200}$/.test(id)) throw fail("bad_input", "read needs the id of a message");
      const m = await call(field, "read", { id });
      if (!m || typeof m !== "object") throw fail("script", "the script's read answer is not a message");
      return {
        id: str(m.id), thread_id: str(m.thread_id), from: str(m.from), to: str(m.to), cc: str(m.cc),
        subject: str(m.subject), date: str(m.date), message_id: str(m.message_id),
        body: str(m.body).slice(0, BODY_CAP),
        attachments: Array.isArray(m.attachments) ? m.attachments.map(a => str(a)).filter(Boolean) : [],
      };
    },

    /**
     * Send, after the Gate released it. The content is checked again here, before any request.
     * @param {AppsScriptConfig} cfg @param {Field} field
     * @param {{ to: string | string[], cc?: string | string[], bcc?: string | string[], subject: string, body: string, in_reply_to?: string }} input
     */
    async send(cfg, field, input = /** @type {any} */ ({})) {
      const to = addresses(input.to, "to");
      checkContent(to, input);
      const args = {
        to: to.join(", "), cc: addresses(input.cc, "cc").join(", "), bcc: addresses(input.bcc, "bcc").join(", "),
        subject: input.subject, body: input.body,
      };
      if (input.in_reply_to) args.in_reply_to = input.in_reply_to;
      const data = await call(field, "send", args);
      if (!data || data.sent !== true) throw fail("script", "the script did not confirm the send");
      return { sent: true };
    },
  };
}
