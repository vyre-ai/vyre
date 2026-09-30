// @ts-check
// One Google consent for both things a Google connection does (0.2 plan: vault.md "Push
// credentials", reviewer N3): Google's hosted MCP servers (Bearer, through the hub) and mail push
// (XOAUTH2, through core/connectors/push.js). Google's hosted MCP has no dynamic registration, so
// the person's own OAuth client makes this one authorize call, and this file asks for the hosted
// scopes and https://mail.google.com/ in that same call. One token set comes back and is stored
// once, bound to Google's issuer and to the hosted MCP resources it was minted for (PLAN.md P21).
//
// The trade, said plainly: the token that carries both scopes is one token. A copy of it would
// reach the whole mailbox, not only new-mail signals. `scope_note` says so in words the card can
// show as they are, and `broad` lets the card put a badge on it. Least privilege inside vyred is
// two doors over one token (Credentials.headers with `url` for the hub, push.js for XOAUTH2),
// neither of which hands the value out.
//
// This file has no ctx. The caller passes what it needs as functions, like oauth.js does.

import { connector } from "./oauth.js";

export const ISSUER = "https://accounts.google.com";
export const AUTH_URI = "https://accounts.google.com/o/oauth2/v2/auth";
export const TOKEN_URI = "https://oauth2.googleapis.com/token";
export const IMAP_SCOPE = "https://mail.google.com/";
const SCOPE = "https://www.googleapis.com/auth/";
/** What the hosted Gmail, Calendar and Drive servers ask for; confirm against Google's list at the connect spike. */
export const HOSTED_SCOPES = ["gmail.readonly", "gmail.compose", "calendar.readonly", "calendar.events", "drive.readonly"].map(s => SCOPE + s);
/** The hosted MCP servers this token may be sent to, and nowhere else. */
export const HOSTED_RESOURCES = ["https://gmailmcp.googleapis.com/", "https://calendarmcp.googleapis.com/", "https://drivemcp.googleapis.com/"];
export const CONSENT_SCOPES = ["openid", "email", ...HOSTED_SCOPES, IMAP_SCOPE];

export const SCOPE_NOTE = "This sign-in gives Vyre access to all of your Gmail, including reading, sending and deleting mail. " +
  "Vyre uses it only to hear the moment new mail arrives (who it is from and when, never the message). Reading and sending go through " +
  "Google's own tools, and anything sent waits for your OK. The one saved key carries both permissions.";

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const fail = (msg, code = "bad_input") => Object.assign(new Error(msg), { code });

/**
 * @typedef {{
 *   fetchItem: (item: string, field?: string) => Promise<string>,
 *   save: (item: string, fields: Record<string, string>) => Promise<void>,
 *   record: (row: { name: string, email: string, item: string, issuer: string, resources: string[], scopes: string[],
 *     imap: boolean, broad: boolean, scope_note: string }) => Promise<void> | void,
 *   taken?: (name: string) => boolean | Promise<boolean>,
 *   emit: (type: string, payload: Record<string, unknown>) => void,
 *   log?: (message: string, fields?: Record<string, unknown>) => void,
 *   fetch?: typeof fetch, expiresMs?: number, authUri?: string, tokenUri?: string, issuer?: string,
 * }} GoogleDeps
 */

/**
 * The Google connect request. Returns oauth.js's start/finish/cancel/stop, where `start` takes
 * { name, client } (a vault item with client_id and client_secret) and asks for every scope above.
 * @param {GoogleDeps} deps
 */
export function googleConnector(deps) {
  const issuer = deps.issuer || ISSUER;
  const inner = connector({
    ...(deps.fetchItem ? { fetchItem: deps.fetchItem } : {}),
    ...(deps.fetch ? { fetch: deps.fetch } : {}),
    ...(deps.expiresMs ? { expiresMs: deps.expiresMs } : {}),
    ...(deps.log ? { log: deps.log } : {}),
    emit: deps.emit,
    async complete(flow, tokens) {
      const granted = String(tokens.scope || "").split(/\s+/).filter(Boolean);
      // Google lets a person untick a scope on the consent screen. No IMAP scope means no push.
      const imap = granted.includes(IMAP_SCOPE);
      if (!tokens.refresh_token) throw fail("Google did not send a refresh token, which happens when this client was allowed before. Remove Vyre's access at myaccount.google.com/permissions and sign in again.", "no_refresh_token");
      let email = "";
      try { email = String(JSON.parse(Buffer.from(String(tokens.id_token).split(".")[1] || "", "base64url").toString("utf8")).email || ""); } catch {}
      if (!EMAIL.test(email)) throw fail("Google did not say which address signed in. Start a new sign-in and allow Vyre to see your email address.", "refused");
      if (deps.taken && await deps.taken(flow.name)) throw fail(`a connection named ${flow.name} was added while you signed in; start again with another name`, "exists");
      const item = `google-${flow.name}`;
      const resources = flow.bind || [];
      // One item, one token set: the binding (issuer, resources) rides in the item so every door checks it.
      await deps.save(item, { client_id: flow.client.client_id, client_secret: flow.client.client_secret || "", refresh_token: tokens.refresh_token,
        token_uri: tokens.token_uri, issuer: tokens.issuer, resource: resources.join(" "), scope: granted.join(" ") });
      await deps.record({ name: flow.name, email, item, issuer: tokens.issuer, resources, scopes: granted, imap, broad: imap, scope_note: imap ? SCOPE_NOTE : "" });
      return { name: flow.name, email, item, imap, broad: imap, ...(imap ? { scope_note: SCOPE_NOTE } : {}) };
    },
  });
  return {
    /** @param {{ name: string, client: string }} input */
    start: input => inner.start({ name: input.name, client: input.client, scopes: CONSENT_SCOPES, bind: HOSTED_RESOURCES,
      server: { issuer, authorize_uri: deps.authUri || AUTH_URI, token_uri: deps.tokenUri || TOKEN_URI } }),
    finish: inner.finish, cancel: inner.cancel, port: inner.port, stop: inner.stop,
  };
}
