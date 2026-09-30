// @ts-check
// capsule: what the Capsule's words mean for mail (ADR 0016 decision 8). Pure: no I/O.
//
// "send an email", "email dana@northwind-bakery.example about the order", "write to alex saying
// the draft is ready" are a message to write: the Capsule shows one row per account it may use,
// with what the words named filled in. "email from dana", "mail about invoices" are a search.
// Anything else is not mail's, and mail.find returns no rows for it.

import { EMAIL } from "../../lib/connectors/message.js";

const COMPOSE = /^\s*(?:(?:send|write|compose|draft|new)\s+(?:an?\s+|the\s+)?(?:e-?mail|mail|message)(?:\s+to)?|e-?mail|write\s+to|mail\s+to|message)\b\s*(.*)$/i;
const SEARCH = /^\s*(?:e-?mails?|mails?|messages?|inbox)\s+(from|about|to)\s+(.+)$/i;

/**
 * @param {string} q
 * @returns {{ kind: "compose", to?: string, name?: string, subject?: string, body?: string }
 *   | { kind: "search", q: string } | { kind: "none" }}
 */
export function parse(q) {
  const text = String(q || "").trim().slice(0, 500);
  const s = SEARCH.exec(text);
  if (s) {
    const what = s[2].trim().replace(/^"|"$/g, "");
    const key = s[1].toLowerCase();
    return { kind: "search", q: key === "about" ? what : `${key}:${/\s/.test(what) ? `"${what}"` : what}` };
  }
  const m = COMPOSE.exec(text);
  if (!m) return { kind: "none" };
  let rest = m[1].trim();
  /** @type {{ kind: "compose", to?: string, name?: string, subject?: string, body?: string }} */
  const out = { kind: "compose" };
  // "saying ..." or "that says ..." is the body; "about ..." or "re ..." is the subject.
  const say = /\b(?:saying|that says|to say|:)\s+(.+)$/i.exec(rest);
  if (say) { out.body = say[1].trim(); rest = rest.slice(0, say.index).trim(); }
  const about = /\b(?:about|re|regarding|subject)\s+(.+)$/i.exec(rest);
  if (about) { out.subject = about[1].trim().replace(/^["']|["']$/g, ""); rest = rest.slice(0, about.index).trim(); }
  rest = rest.replace(/^to\s+/i, "").trim();
  if (rest) {
    const addr = rest.split(/[\s,]+/).find(w => EMAIL.test(w));
    if (addr) out.to = addr;
    else if (/^[A-Za-z][A-Za-z'.-]{0,40}(?:\s+[A-Za-z][A-Za-z'.-]{0,40})?$/.test(rest)) out.name = rest;
  }
  if (out.subject) out.subject = out.subject.charAt(0).toUpperCase() + out.subject.slice(1);
  return out;
}

/** A compose row's id carries what the words said, so the action needs nothing else. */
export function composeId(account, fill) {
  const f = Object.fromEntries(Object.entries(fill).filter(([k, v]) => ["to", "name", "subject", "body"].includes(k) && typeof v === "string" && v));
  return `compose:${account}:${Buffer.from(JSON.stringify(f), "utf8").toString("base64url")}`;
}

/** @param {string} id */
export function parseComposeId(id) {
  const m = /^compose:([A-Za-z0-9_-]{1,64}):([A-Za-z0-9_-]{0,4000})$/.exec(String(id || ""));
  if (!m) return null;
  try {
    const f = JSON.parse(Buffer.from(m[2], "base64url").toString("utf8") || "{}");
    const fill = {};
    for (const k of ["to", "name", "subject", "body"]) if (typeof f[k] === "string") fill[k] = f[k].slice(0, 5000);
    return { account: m[1], fill };
  } catch { return null; }
}

/** A message row's id, for the "open" action on a search row. */
export const messageId = (account, id) => `msg:${account}:${Buffer.from(String(id), "utf8").toString("base64url")}`;
export function parseMessageId(id) {
  const m = /^msg:([A-Za-z0-9_-]{1,64}):([A-Za-z0-9_-]{1,2000})$/.exec(String(id || ""));
  return m ? { account: m[1], id: Buffer.from(m[2], "base64url").toString("utf8") } : null;
}
