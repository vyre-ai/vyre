// @ts-check
// A fake Google for tests: a token endpoint, Calendar v3 and Gmail v1, on 127.0.0.1 port 0.
// Tests must never reach real Google (team rules), and a fake that accepts anything would hide the
// bugs that matter here: a JWT signed with the wrong key, a missing `sub`, a token minted for
// read scopes used to send. So this fake checks what real Google checks, in miniature:
// - JWT assertions are verified against the keys it generated in `serviceAccount()`, with the
//   audience, expiry, subject and scopes checked; `opts.allowedScopes` plays the Workspace admin
//   console's domain-wide-delegation list and refuses the rest with 401 unauthorized_client.
// - Access tokens are opaque, remembered with the scopes they were minted for, and required on
//   every API call (401 without, 403 when the scope is too narrow). `expireTokens()` expires
//   them all, to test the refresh-once-on-401 path.
// - Every request lands in `calls`, so a test can prove that nothing was sent.
// Data is the sample world: alex@example.com's mailbox and calendar, Harlow Legal and Northwind Bakery.

import crypto from "node:crypto";
import http from "node:http";

const S = "https://www.googleapis.com/auth/";
const FULL_MAIL = "https://mail.google.com/";
const NEED = {
  calRead: [S + "calendar.readonly", S + "calendar", S + "calendar.events", S + "calendar.events.readonly"],
  calWrite: [S + "calendar", S + "calendar.events"],
  mailRead: [S + "gmail.readonly", S + "gmail.modify", FULL_MAIL],
  mailMeta: [S + "gmail.metadata", S + "gmail.readonly", S + "gmail.modify", FULL_MAIL],
  mailCompose: [S + "gmail.compose", S + "gmail.modify", FULL_MAIL],
  mailSend: [S + "gmail.send", S + "gmail.compose", S + "gmail.modify", FULL_MAIL],
};
const ALL_SCOPES = [...new Set(Object.values(NEED).flat())];
const ME = "alex@example.com";

/**
 * @typedef {{ method: string, path: string, query: Record<string, string>, auth: boolean,
 *   body: any, subject?: string }} FakeCall
 * @typedef {{ allowedScopes?: string[], users?: string[], oauthScopes?: string[], tokenTtl?: number,
 *   now?: () => number }} FakeOpts
 */

/**
 * Start the fake. It closes when the test ends.
 * @param {{ after: (fn: () => any) => void }} t @param {FakeOpts} [opts]
 */
export async function startFakeGoogle(t, opts = {}) {
  const now = opts.now || Date.now;
  const users = opts.users || [ME];
  const ttl = opts.tokenTtl || 3600;
  /** @type {FakeCall[]} */ const calls = [];
  /** @type {Map<string, { publicKey: crypto.KeyObject }>} */ const keys = new Map();
  /** @type {Map<string, { client_secret: string, refresh_token: string, scopes: string[] }>} */ const clients = new Map();
  /** @type {Map<string, { subject: string, scopes: string[], expired: boolean, expires: number }>} */ const tokens = new Map();
  const mail = seedMail(now());
  const calendar = seedCalendar(now());
  let seq = 0;
  const id = p => `${p}${(++seq).toString(36)}${crypto.randomBytes(3).toString("hex")}`;

  const server = http.createServer((req, res) => {
    const chunks = [];
    let size = 0;
    req.on("data", c => { size += c.length; if (size < 2_000_000) chunks.push(c); });
    req.on("end", () => {
      const u = new URL(req.url || "/", "http://fake");
      const raw = Buffer.concat(chunks).toString("utf8");
      const type = String(req.headers["content-type"] || "");
      let body = raw;
      if (type.includes("json")) { try { body = JSON.parse(raw); } catch {} } else if (type.includes("x-www-form-urlencoded")) body = Object.fromEntries(new URLSearchParams(raw));
      /** @type {FakeCall} */
      const call = { method: req.method || "GET", path: u.pathname, query: Object.fromEntries(u.searchParams), auth: !!req.headers.authorization, body };
      calls.push(call);
      const send = (status, json) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(json)); };
      try { route(req, u, body, call, send); } catch (e) { send(500, { error: { code: 500, message: String(/** @type {any} */ (e)?.message || e) } }); }
    });
  });
  await new Promise(r => server.listen(0, "127.0.0.1", () => r(undefined)));
  const addr = /** @type {import("node:net").AddressInfo} */ (server.address());
  const base = `http://127.0.0.1:${addr.port}`;
  const tokenUri = `${base}/token`;
  t.after(() => new Promise(r => { server.closeAllConnections?.(); server.close(() => r(undefined)); }));

  function mint(subject, scopes) {
    const token = `ya29.fake-${crypto.randomBytes(18).toString("base64url")}`;
    tokens.set(token, { subject, scopes, expired: false, expires: now() + ttl * 1000 });
    return { access_token: token, expires_in: ttl, token_type: "Bearer" };
  }

  function tokenEndpoint(body, send) {
    const b = body && typeof body === "object" ? body : {};
    if (b.grant_type === "refresh_token") {
      const c = clients.get(b.client_id);
      if (!c || c.client_secret !== b.client_secret) return send(401, { error: "invalid_client", error_description: "The OAuth client was not found." });
      if (c.refresh_token !== b.refresh_token) return send(400, { error: "invalid_grant", error_description: "Token has been expired or revoked." });
      return send(200, { ...mint(ME, c.scopes), scope: c.scopes.join(" ") });
    }
    if (b.grant_type === "urn:ietf:params:oauth:grant-type:jwt-bearer") {
      const parts = String(b.assertion || "").split(".");
      if (parts.length !== 3) return send(400, { error: "invalid_grant", error_description: "Invalid JWT." });
      let header, claims;
      try { header = JSON.parse(Buffer.from(parts[0], "base64url").toString()); claims = JSON.parse(Buffer.from(parts[1], "base64url").toString()); } catch {
        return send(400, { error: "invalid_grant", error_description: "Invalid JWT." });
      }
      const key = keys.get(claims.iss);
      if (header.alg !== "RS256" || !key) return send(400, { error: "invalid_grant", error_description: "Invalid JWT Signature." });
      const ok = crypto.verify("sha256", Buffer.from(`${parts[0]}.${parts[1]}`), key.publicKey, Buffer.from(parts[2], "base64url"));
      if (!ok) return send(400, { error: "invalid_grant", error_description: "Invalid JWT Signature." });
      const t = Math.floor(now() / 1000);
      if (claims.aud !== tokenUri) return send(400, { error: "invalid_grant", error_description: "Invalid JWT: Token must be a short-lived token and in a reasonable timeframe (aud)." });
      if (!(claims.exp > t) || claims.exp - claims.iat > 3600 || claims.iat > t + 300) return send(400, { error: "invalid_grant", error_description: "Invalid JWT: Token must be a short-lived token (60 minutes) and in a reasonable timeframe." });
      const scopes = String(claims.scope || "").split(" ").filter(Boolean);
      if (!scopes.length) return send(400, { error: "invalid_scope", error_description: "Invalid OAuth scope or ID token audience provided." });
      const unknown = scopes.filter(s => !ALL_SCOPES.includes(s));
      if (unknown.length) return send(400, { error: "invalid_scope", error_description: `Invalid OAuth scope or ID token audience provided: ${unknown.join(" ")}` });
      if (claims.sub !== undefined && !users.includes(claims.sub)) return send(400, { error: "invalid_grant", error_description: "Invalid email or User ID" });
      // Real Google does not say which scope a DWD client lacks; neither does this fake.
      if (opts.allowedScopes && scopes.some(s => !opts.allowedScopes?.includes(s))) {
        return send(401, { error: "unauthorized_client", error_description: "Client is unauthorized to retrieve access tokens using this method, or client not authorized for any of the scopes requested." });
      }
      return send(200, mint(claims.sub || claims.iss, scopes));
    }
    return send(400, { error: "unsupported_grant_type", error_description: "Invalid grant_type." });
  }

  /** Check the bearer token and its scope; send the error and return null when it fails. */
  function authorize(req, call, need, send) {
    const m = /^Bearer (.+)$/.exec(String(req.headers.authorization || ""));
    const tok = m && tokens.get(m[1]);
    if (!tok || tok.expired || tok.expires <= now()) {
      send(401, { error: { code: 401, message: "Request had invalid authentication credentials.", status: "UNAUTHENTICATED" } });
      return null;
    }
    call.subject = tok.subject;
    if (!tok.scopes.some(s => need.includes(s))) {
      send(403, { error: { code: 403, message: "Request had insufficient authentication scopes.", status: "PERMISSION_DENIED" } });
      return null;
    }
    return tok;
  }

  function route(req, u, body, call, send) {
    const p = u.pathname, q = u.searchParams, method = req.method;
    if (p === "/token" && method === "POST") return tokenEndpoint(body, send);
    const notFound = () => send(404, { error: { code: 404, message: "Not Found", status: "NOT_FOUND" } });

    // Calendar v3
    if (p === "/calendar/v3/users/me/calendarList" && method === "GET") {
      if (!authorize(req, call, NEED.calRead, send)) return;
      return send(200, { kind: "calendar#calendarList", items: calendar.calendars });
    }
    let m = /^\/calendar\/v3\/calendars\/([^/]+)\/events(?:\/([^/]+))?$/.exec(p);
    if (m) {
      const cal = decodeURIComponent(m[1]);
      if (cal !== "primary" && !calendar.calendars.some(c => c.id === cal)) return authorize(req, call, NEED.calRead, send) && notFound();
      const eventId = m[2] && decodeURIComponent(m[2]);
      if (method === "GET" && !eventId) {
        if (!authorize(req, call, NEED.calRead, send)) return;
        if (q.get("orderBy") === "startTime" && q.get("singleEvents") !== "true") {
          return send(400, { error: { code: 400, message: "The requested ordering is not available for the particular query.", status: "INVALID_ARGUMENT" } });
        }
        return send(200, listEvents(calendar.events, q));
      }
      if (method === "GET" && eventId) {
        if (!authorize(req, call, NEED.calRead, send)) return;
        const ev = calendar.events.find(e => e.id === eventId);
        return ev ? send(200, ev) : notFound();
      }
      if (method === "POST" && !eventId) {
        if (!authorize(req, call, NEED.calWrite, send)) return;
        const b = body && typeof body === "object" ? body : {};
        if (!b.start || !b.end) return send(400, { error: { code: 400, message: "Missing time.", status: "INVALID_ARGUMENT" } });
        const ev = { kind: "calendar#event", id: id("ev"), status: "confirmed", htmlLink: `${base}/calendar/event?eid=${seq}`,
          organizer: { email: ME, self: true }, created: new Date(now()).toISOString(), ...b };
        calendar.events.push(ev);
        noteInvites(ev, q.get("sendUpdates"));
        return send(200, ev);
      }
      if (method === "PATCH" && eventId) {
        if (!authorize(req, call, NEED.calWrite, send)) return;
        const ev = calendar.events.find(e => e.id === eventId);
        if (!ev) return notFound();
        Object.assign(ev, body && typeof body === "object" ? body : {}, { id: ev.id, updated: new Date(now()).toISOString() });
        noteInvites(ev, q.get("sendUpdates"));
        return send(200, ev);
      }
      return notFound();
    }

    // Gmail v1
    if (p === "/gmail/v1/users/me/messages" && method === "GET") {
      if (!authorize(req, call, NEED.mailMeta, send)) return;
      const max = Math.min(Number(q.get("maxResults")) || 100, 500);
      const hits = mail.messages.filter(msg => matches(msg, q.get("q") || "", now())).sort((a, b) => b.internalDate - a.internalDate);
      const out = hits.slice(0, max).map(msg => ({ id: msg.id, threadId: msg.threadId }));
      return send(200, { messages: out.length ? out : undefined, resultSizeEstimate: hits.length, nextPageToken: hits.length > max ? "more" : undefined });
    }
    m = /^\/gmail\/v1\/users\/me\/(messages|threads)\/([^/]+)$/.exec(p);
    if (m && method === "GET" && m[2] !== "send") {
      const format = q.get("format") || "full";
      if (!authorize(req, call, format === "metadata" ? NEED.mailMeta : NEED.mailRead, send)) return;
      const wantHeaders = q.getAll("metadataHeaders");
      if (m[1] === "messages") {
        const msg = mail.messages.find(x => x.id === m?.[2]);
        return msg ? send(200, render(msg, format, wantHeaders)) : notFound();
      }
      const list = mail.messages.filter(x => x.threadId === m?.[2]).sort((a, b) => a.internalDate - b.internalDate);
      return list.length ? send(200, { id: m[2], historyId: "1", messages: list.map(x => render(x, format, wantHeaders)) }) : notFound();
    }
    if (p === "/gmail/v1/users/me/drafts" && method === "POST") {
      if (!authorize(req, call, NEED.mailCompose, send)) return;
      const msg = parseRaw(body?.message?.raw);
      if (!msg) return send(400, { error: { code: 400, message: "Invalid raw message.", status: "INVALID_ARGUMENT" } });
      const draft = { id: id("r"), message: { id: id("m"), threadId: body.message.threadId || id("t"), labelIds: ["DRAFT"], ...msg } };
      mail.drafts.push(draft);
      return send(200, { id: draft.id, message: { id: draft.message.id, threadId: draft.message.threadId, labelIds: ["DRAFT"] } });
    }
    if (p === "/gmail/v1/users/me/messages/send" && method === "POST") {
      if (!authorize(req, call, NEED.mailSend, send)) return;
      const msg = parseRaw(body?.raw);
      if (!msg) return send(400, { error: { code: 400, message: "Invalid raw message.", status: "INVALID_ARGUMENT" } });
      const sent = { id: id("m"), threadId: body.threadId || id("t"), labelIds: ["SENT"], ...msg };
      mail.sent.push(sent);
      return send(200, { id: sent.id, threadId: sent.threadId, labelIds: ["SENT"] });
    }
    return notFound();
  }

  function noteInvites(ev, sendUpdates) {
    ev._sendUpdates = sendUpdates || "none";
    if (Array.isArray(ev.attendees) && ev.attendees.length && (sendUpdates === "all" || sendUpdates === "externalOnly")) {
      calendar.invites.push({ eventId: ev.id, to: ev.attendees.map(a => a.email), sendUpdates });
    }
  }

  return {
    base, tokenUri, calls, mail, calendar,
    /** Every access token issued, with the subject and scopes it was minted for. */
    tokens,
    /** A fresh service-account JSON string whose token_uri points here. */
    serviceAccount(subject) {
      const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
      const client_email = `vyre-${crypto.randomBytes(3).toString("hex")}@northwind-bakery.iam.gserviceaccount.com`;
      keys.set(client_email, { publicKey });
      if (subject && !users.includes(subject)) users.push(subject);
      return JSON.stringify({ type: "service_account", project_id: "northwind-bakery", private_key_id: crypto.randomBytes(20).toString("hex"),
        private_key: privateKey.export({ type: "pkcs8", format: "pem" }).toString(), client_email,
        client_id: String(100000000000 + Math.floor(Math.random() * 1e9)), token_uri: tokenUri });
    },
    /** Fields for an oauth env-set whose token_uri points here. */
    oauthItem() {
      const fields = { client_id: `${crypto.randomBytes(6).toString("hex")}.apps.googleusercontent.com`,
        client_secret: `GOCSPX-${crypto.randomBytes(14).toString("base64url")}`,
        refresh_token: `1//fake-${crypto.randomBytes(24).toString("base64url")}`, token_uri: tokenUri };
      clients.set(fields.client_id, { client_secret: fields.client_secret, refresh_token: fields.refresh_token, scopes: opts.oauthScopes || ALL_SCOPES });
      return fields;
    },
    /** Expire every access token issued so far; the next API call with one gets 401. */
    expireTokens() { for (const tok of tokens.values()) tok.expired = true; },
    /** Calls that carried an Authorization header to an API (not the token endpoint). */
    apiCalls() { return calls.filter(c => c.path !== "/token"); },
  };
}

// ---- data ----

function seedCalendar(at) {
  const iso = ms => new Date(ms).toISOString();
  const tomorrow = new Date(at + 86_400_000);
  tomorrow.setUTCHours(10, 0, 0, 0);
  const org = { email: ME, self: true };
  return {
    calendars: [{ kind: "calendar#calendarListEntry", id: ME, summary: ME, primary: true, accessRole: "owner", timeZone: "UTC" }],
    events: [
      { kind: "calendar#event", id: "evharlow1", status: "confirmed", summary: "Harlow Legal check-in", location: "Zoom",
        description: "Review the engagement letter with Dana.", organizer: org,
        start: { dateTime: iso(at + 30 * 60_000) }, end: { dateTime: iso(at + 60 * 60_000) },
        attendees: [{ email: ME, self: true, responseStatus: "accepted" }, { email: "dana@harlowlegal.com", responseStatus: "needsAction" }] },
      { kind: "calendar#event", id: "evnorthwind1", status: "confirmed", summary: "Northwind Bakery tasting", location: "Northwind Bakery",
        description: "Try the autumn menu.", organizer: org,
        start: { dateTime: iso(tomorrow.getTime()) }, end: { dateTime: iso(tomorrow.getTime() + 3_600_000) } },
    ],
    /** @type {{ eventId: string, to: string[], sendUpdates: string }[]} */
    invites: [],
  };
}

function seedMail(at) {
  const h = 3_600_000;
  const msg = (id, threadId, ago, from, to, subject, text, labels = ["INBOX"]) => ({
    id, threadId, labelIds: labels, internalDate: at - ago, snippet: text.slice(0, 100),
    headers: { From: from, To: to, Subject: subject, Date: new Date(at - ago).toUTCString(), "Message-ID": `<${id}@mail.example.com>` }, text,
  });
  return {
    messages: [
      msg("mharlow1", "tharlow", 26 * h, "Dana Reyes <dana@harlowlegal.com>", ME, "Harlow Legal engagement letter",
        "Hi Alex, the engagement letter is attached. Could you sign it before Thursday? Thanks, Dana"),
      msg("mharlow2", "tharlow", 20 * h, `Alex <${ME}>`, "dana@harlowlegal.com", "Re: Harlow Legal engagement letter",
        "Thanks Dana, I will sign it tomorrow morning.", ["SENT"]),
      msg("mnorthwind1", "tnorthwind", 2 * h, "Northwind Bakery <orders@northwindbakery.com>", ME, "Your Northwind Bakery order",
        "Your order of two sourdough loaves is ready for pickup.", ["INBOX", "UNREAD"]),
      msg("mnorthwind0", "tnorthwind0", 10 * 24 * h, "Northwind Bakery <orders@northwindbakery.com>", ME, "Northwind Bakery newsletter",
        "The autumn menu is here: apple tarts and pumpkin bread."),
    ],
    /** @type {any[]} */ drafts: [],
    /** @type {any[]} */ sent: [],
  };
}

function listEvents(events, q) {
  const min = q.get("timeMin") ? Date.parse(q.get("timeMin")) : -Infinity;
  const max = q.get("timeMax") ? Date.parse(q.get("timeMax")) : Infinity;
  const words = (q.get("q") || "").toLowerCase().split(/\s+/).filter(Boolean);
  const when = e => Date.parse(e.start?.dateTime || e.start?.date || "");
  const end = e => Date.parse(e.end?.dateTime || e.end?.date || "");
  let items = events.filter(e => e.status !== "cancelled" && end(e) > min && when(e) < max);
  if (words.length) {
    items = items.filter(e => {
      const hay = [e.summary, e.description, e.location, ...(e.attendees || []).map(a => a.email)].join(" ").toLowerCase();
      return words.every(w => hay.includes(w));
    });
  }
  if (q.get("orderBy") === "startTime") items = [...items].sort((a, b) => when(a) - when(b));
  const max2 = Number(q.get("maxResults")) || 250;
  const page = items.slice(0, max2).map(({ _sendUpdates, ...e }) => e);
  return { kind: "calendar#events", summary: ME, timeZone: "UTC", items: page, nextPageToken: items.length > max2 ? "more" : undefined };
}

/** A small Gmail query language: from:, to:, subject:, newer_than:, is:unread, in:, and plain words. */
function matches(msg, query, at) {
  const terms = [...String(query).matchAll(/(\w+):(?:"([^"]*)"|(\S+))|"([^"]*)"|(\S+)/g)];
  const lower = s => String(s || "").toLowerCase();
  for (const t of terms) {
    const [, op, qv, v, phrase, word] = t;
    const val = lower(qv ?? v);
    if (op === "from" && !lower(msg.headers.From).includes(val)) return false;
    else if (op === "to" && !lower(msg.headers.To).includes(val)) return false;
    else if (op === "subject" && !lower(msg.headers.Subject).includes(val)) return false;
    else if (op === "newer_than") {
      const n = /^(\d+)([dhmy])$/.exec(val);
      const unit = n ? { h: 3_600_000, d: 86_400_000, m: 30 * 86_400_000, y: 365 * 86_400_000 }[n[2]] : 0;
      if (n && msg.internalDate < at - Number(n[1]) * unit) return false;
    } else if (op === "is" && val === "unread" && !msg.labelIds.includes("UNREAD")) return false;
    else if (op === "in" && !msg.labelIds.includes(val.toUpperCase())) return false;
    else if (!op) {
      const w = lower(phrase ?? word);
      const hay = lower([msg.headers.From, msg.headers.To, msg.headers.Subject, msg.text].join(" "));
      if (!hay.includes(w)) return false;
    }
  }
  return true;
}

/** A message in Gmail's shape, with a multipart/alternative payload for format=full. */
function render(msg, format, wantHeaders) {
  let headers = Object.entries(msg.headers).map(([name, value]) => ({ name, value }));
  if (format === "metadata" && wantHeaders.length) headers = headers.filter(h => wantHeaders.some(w => w.toLowerCase() === h.name.toLowerCase()));
  const base = { id: msg.id, threadId: msg.threadId, labelIds: msg.labelIds, snippet: msg.snippet,
    internalDate: String(msg.internalDate), sizeEstimate: msg.text.length + 400 };
  if (format === "minimal") return base;
  if (format === "metadata") return { ...base, payload: { mimeType: "multipart/alternative", headers } };
  const enc = s => Buffer.from(s, "utf8").toString("base64url");
  const html = `<div>${msg.text.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</div>`;
  return { ...base, payload: { partId: "", mimeType: "multipart/alternative", headers, body: { size: 0 }, parts: [
    { partId: "0", mimeType: "text/plain", headers: [{ name: "Content-Type", value: "text/plain; charset=UTF-8" }], body: { size: msg.text.length, data: enc(msg.text) } },
    { partId: "1", mimeType: "text/html", headers: [{ name: "Content-Type", value: "text/html; charset=UTF-8" }], body: { size: html.length, data: enc(html) } },
  ] } };
}

/** Parse a base64url RFC 822 message into headers and a text body; null when it is not one. */
function parseRaw(raw) {
  if (typeof raw !== "string" || !raw) return null;
  const text = Buffer.from(raw, "base64url").toString("utf8");
  const split = text.search(/\r?\n\r?\n/);
  if (split < 0) return null;
  const head = text.slice(0, split).replace(/\r?\n[ \t]+/g, " ");
  /** @type {Record<string, string>} */ const headers = {};
  for (const line of head.split(/\r?\n/)) {
    const i = line.indexOf(":");
    if (i > 0) headers[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  if (!headers.To && !headers.to) return null;
  return { headers, text: text.slice(split).replace(/^\r?\n\r?\n/, ""), raw };
}
