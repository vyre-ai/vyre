// @ts-check
// drive-seam: Google Drive for Files > Linked, as ONE person (core/files/linked-gdrive.js calls it through google.drive.linked).
//
// Whose account (the same resolution as google.drive.read, from the person the files module names):
// - the Space owner uses their own signed-in accounts (never the firm key, which is a key to act as members, not a mailbox);
// - a team member uses the firm key acting as the work email the owner attested for them (member-account.js), and nothing else;
// - nobody else's account is ever a fallback: no account answers a plain sentence, never the owner's Drive.
// The scope is the narrowest the call needs (drive.readonly for a read, drive for a write), only the Drive v3 files, changes and upload paths pass, and an error that leaves here
// has every token-looking value removed and is cut to 300 characters.
import { forMember } from "./member-account.js";

export const NO_ACCOUNT = "Connect your Google account in Settings first";
const METHODS = ["GET", "POST", "PATCH", "DELETE"];
const PATHS = /^\/(?:upload\/)?drive\/v3\/(?:files(?:\/[A-Za-z0-9_-]{1,128}(?:\/(?:export|revisions))?)?|changes(?:\/startPageToken)?)$/;
const PERSON = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const fail = (/** @type {string} */ message, /** @type {string} */ code) => Object.assign(new Error(message), { code });

/** A message with every bearer token, authorization header and token-valued field removed, cut to 300 characters. @param {unknown} s */
export function strip(s) {
  return String(s ?? "")
    .replace(/\bauthorization\b\s*[:=]\s*\S+(?:\s+\S+)?/gi, "[removed]")
    .replace(/\bBearer\s+[^\s"',;}]+/gi, "[removed]")
    .replace(/\b((?:access|refresh|id)_token|client_secret|api[_-]?key)\b(["']?\s*[:=]\s*["']?)[^\s"',;&}]+/gi, "$1$2[removed]")
    .slice(0, 300);
}

/**
 * @param {{ all: () => any[], owner: () => string | undefined, memberOf: (id: string) => any, request: (acct: any, req: any) => Promise<any> }} d
 */
export function driveSeam({ all, owner, memberOf, request }) {
  /** The one account this person's Drive calls run as. @param {string} person */
  function accountFor(person) {
    if (!PERSON.test(String(person))) throw fail(NO_ACCOUNT, "no_account");
    if (owner() !== undefined && String(person) === String(owner())) {
      const own = all().filter(a => a && !a.firm && a.auth);
      if (!own.length) throw fail(NO_ACCOUNT, "no_account");
      return own[0];
    }
    const rec = memberOf(String(person));
    if (!rec) throw fail(NO_ACCOUNT, "no_account");
    try { return forMember(all(), rec)[0]; }
    catch (e) { const err = /** @type {any} */ (e); throw fail(err && err.code === "no_account" ? NO_ACCOUNT : strip(err && err.message), err && err.code === "denied" ? "denied" : "no_account"); }
  }

  /**
   * @param {string} person
   * @param {{ method?: string, path: string, query?: any, body?: any, bodyB64?: string, raw?: boolean }} req
   * @returns {Promise<{ status: number, body?: any, bytesB64?: string, message?: string }>} a Google refusal comes back as its status, not as a throw
   */
  async function run(person, req) {
    const method = String(req.method || "GET").toUpperCase(), path = String(req.path || "");
    if (!METHODS.includes(method) || !PATHS.test(path)) throw fail("only Google Drive files can be reached from a linked folder", "bad_input");
    const acct = accountFor(person);
    const body = typeof req.bodyB64 === "string" ? new Uint8Array(Buffer.from(req.bodyB64, "base64")) : req.body;
    try {
      const out = await request(acct, { api: "drive", scope: method === "GET" ? "drive.readonly" : "drive", method, path, ...(req.query ? { query: req.query } : {}), ...(body !== undefined ? { body } : {}), ...(req.raw ? { raw: "bytes" } : {}) });
      return req.raw ? { status: 200, bytesB64: Buffer.from(out.bytes).toString("base64") } : { status: 200, body: out };
    } catch (e) {
      const err = /** @type {any} */ (e), st = Number(err && err.status);
      if (Number.isInteger(st) && st >= 300) return { status: st, message: strip(err.message) };
      throw fail(strip(err && err.message) || "Google Drive did not answer", typeof (err && err.code) === "string" ? err.code : "failed");
    }
  }
  return { accountFor, run };
}

/** The `client` linked-gdrive.js wants, over a function that calls google.drive.linked. @param {(input: any) => Promise<{ data?: any, error?: { code?: string, message?: string } }>} call */
export function driveClient(call) {
  return {
    /** @param {string} person @param {any} req */
    async request(person, req) {
      const { body, raw, ...rest } = req || {};
      const bytes = body instanceof Uint8Array;
      const r = await call({ person, ...rest, ...(raw ? { raw: true } : {}), ...(bytes ? { bodyB64: Buffer.from(body).toString("base64") } : body !== undefined ? { body } : {}) });
      if (r.error) throw Object.assign(new Error(strip(r.error.message) || NO_ACCOUNT), { code: r.error.code || "failed" });
      const d = r.data;
      if (d.status !== 200) throw Object.assign(new Error(strip(d.message) || `Google Drive answered ${d.status}`), { status: d.status });
      return raw ? { bytes: new Uint8Array(Buffer.from(d.bytesB64, "base64")) } : d.body;
    },
  };
}
