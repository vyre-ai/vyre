// @ts-check
// graph: one authenticated, read-only call to Microsoft Graph as the firm app, for one user's mailbox, and the shaping of what comes back for a model to read. The mailbox in the path is always
// the account's own (account.mailbox, set by member-account.js from the attested email), never an input. Redirects are refused (they would carry the bearer token to another host); a timeout on every
// call; errors carry Graph's own message scrubbed of every value the credential library has touched, and never the request.
import { httpFetch } from "../../lib/http.js";

const TIMEOUT_MS = 30_000, MAX_BYTES = 5_000_000, TEXT_CAP = 20_000;
export const GRAPH_SCOPE = "https://graph.microsoft.com/.default";
export const DEFAULT_BASE = "https://graph.microsoft.com";
const bad = m => Object.assign(new Error(m), { code: "bad_input" });

export class GraphError extends Error {
  /** @param {string} message @param {{ status?: number, code?: string }} [i] */
  constructor(message, i = {}) { super(message); this.name = "GraphError"; this.code = i.code || "graph"; if (i.status) this.status = i.status; }
}

/** @param {{ creds: import("../../lib/connectors/auth.js").Credentials, fetch?: typeof fetch }} deps */
export function graph({ creds, fetch: f = httpFetch }) {
  /** @param {any} acct @param {{ path: string, query?: Record<string, string|number>, raw?: boolean, headers?: Record<string,string> }} req */
  async function request(acct, req) {
    if (!acct || !acct.mailbox) throw new GraphError("no mailbox to act as", { code: "denied" });
    const url = new URL((acct.base || DEFAULT_BASE).replace(/\/+$/, "") + `/v1.0/users/${encodeURIComponent(acct.mailbox)}` + req.path);
    for (const [k, v] of Object.entries(req.query || {})) url.searchParams.set(k, String(v));
    for (let attempt = 0; ; attempt++) {
      const headers = { ...(await creds.headers(acct.auth, { scopes: [GRAPH_SCOPE] })), accept: req.raw ? "text/plain, */*" : "application/json", ...(req.headers || {}) };
      let res;
      try { res = await f(url, { method: "GET", headers, redirect: "manual", signal: AbortSignal.timeout(TIMEOUT_MS) }); }
      catch (e) { throw new GraphError(`Microsoft Graph ${/** @type {any} */ (e)?.name === "TimeoutError" ? "did not answer in 30 s" : "could not be reached"}`, { code: "network" }); }
      const text = await readCapped(res);
      if (res.status === 401 && attempt === 0) { creds.invalidate(acct.auth, [GRAPH_SCOPE]); continue; }
      if (res.status >= 300 && res.status < 400) throw new GraphError(`Microsoft Graph answered a redirect (${res.status}), which is refused`, { status: res.status });
      let json = null; try { json = text ? JSON.parse(text) : {}; } catch {}
      if (!res.ok) {
        const e = json && typeof json.error === "object" ? json.error : null;
        let msg = `Microsoft Graph answered ${res.status}: ${creds.scrub(String((e && e.message) || text.slice(0, 200) || "no reason given")).slice(0, 300)}`;
        if (res.status === 403) msg += ". The app may not reach this mailbox: the tenant restricts it to a staff group (ApplicationAccessPolicy or RBAC for Applications), or the permission is not granted.";
        throw new GraphError(msg, { status: res.status, code: res.status === 404 ? "not_found" : res.status === 403 ? "forbidden" : "graph" });
      }
      return req.raw ? { text: creds.scrub(text) } : (json ?? {});
    }
  }
  return { request };
}

async function readCapped(res) {
  if (!res.body) return "";
  const reader = res.body.getReader(), dec = new TextDecoder();
  let out = "", size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BYTES) { await reader.cancel().catch(() => {}); throw new GraphError(`Microsoft Graph answered more than ${MAX_BYTES} bytes`); }
    out += dec.decode(value, { stream: true });
  }
  return out + dec.decode();
}

/** A search term for Graph's $search (a quoted phrase). @param {string} q */
export const quote = q => {
  const t = String(q ?? "").trim();
  if (!t || t.length > 200) throw bad("the search is empty or too long");
  return `"${t.replace(/["\\]/g, " ")}"`;
};
const ID = /^[A-Za-z0-9_=%.-]{5,300}$/;
const addr = x => (x && x.emailAddress ? `${x.emailAddress.name ? x.emailAddress.name + " " : ""}<${x.emailAddress.address || ""}>`.trim() : "");

/** @param {{ request: ReturnType<typeof graph>["request"] }} g */
export function tools({ request }) {
  return {
    async mailSearch(acct, { q, limit = 10 }) {
      const r = await request(acct, { path: "/messages", query: { $search: quote(q), $top: limit, $select: "id,subject,from,receivedDateTime,bodyPreview,webLink" } });
      return (r.value || []).map(m => ({ account: acct.name, id: String(m.id), from: addr(m.from), subject: String(m.subject || "(no subject)"), date: m.receivedDateTime || null, snippet: String(m.bodyPreview || "").slice(0, 200), url: m.webLink || null }));
    },
    async mailRead(acct, { id }) {
      if (!ID.test(String(id))) throw bad("id must be a message id");
      const m = await request(acct, { path: `/messages/${encodeURIComponent(id)}`, query: { $select: "id,subject,from,toRecipients,ccRecipients,receivedDateTime,body,webLink" }, headers: { Prefer: 'outlook.body-content-type="text"' } });
      const body = String(m.body && m.body.content || "").replace(/\r\n/g, "\n");
      return { account: acct.name, id: String(m.id), from: addr(m.from), to: (m.toRecipients || []).map(addr), cc: (m.ccRecipients || []).map(addr), subject: String(m.subject || "(no subject)"), date: m.receivedDateTime || null, text: body.slice(0, TEXT_CAP), ...(body.length > TEXT_CAP ? { truncated: true } : {}), url: m.webLink || null };
    },
    async calendarList(acct, { from, to, limit = 25 }) {
      const f = new Date(from), t = new Date(to);
      if (isNaN(+f) || isNaN(+t) || +t < +f || +t - +f > 366 * 86_400_000) throw bad("from and to are ISO times at most a year apart");
      const r = await request(acct, { path: "/calendarView", query: { startDateTime: f.toISOString(), endDateTime: t.toISOString(), $top: limit, $orderby: "start/dateTime", $select: "id,subject,start,end,location,organizer,isAllDay,webLink" }, headers: { Prefer: 'outlook.timezone="UTC"' } });
      return (r.value || []).map(e => ({ account: acct.name, id: String(e.id), title: String(e.subject || "(no title)"), start: e.start && e.start.dateTime ? e.start.dateTime + "Z" : null, end: e.end && e.end.dateTime ? e.end.dateTime + "Z" : null, all_day: Boolean(e.isAllDay), where: e.location && e.location.displayName || "", organizer: addr(e.organizer), url: e.webLink || null }));
    },
    async driveSearch(acct, { q, limit = 10 }) {
      const term = String(q ?? "").trim();
      if (!term || term.length > 200) throw bad("the search is empty or too long");
      const r = await request(acct, { path: `/drive/root/search(q='${term.replace(/'/g, "''").replace(/[\\/?#%]/g, " ")}')`, query: { $top: limit, $select: "id,name,file,lastModifiedDateTime,webUrl" } });
      return (r.value || []).map(f => ({ account: acct.name, id: String(f.id), name: String(f.name || ""), type: f.file && f.file.mimeType || "", modified: f.lastModifiedDateTime || null, url: f.webUrl || null }));
    },
    async driveRead(acct, { id }) {
      if (!ID.test(String(id))) throw bad("id must be a Drive item id");
      const meta = await request(acct, { path: `/drive/items/${encodeURIComponent(id)}`, query: { $select: "id,name,file,webUrl,size" } });
      const type = meta.file && meta.file.mimeType || "";
      const out = { account: acct.name, id: String(meta.id), name: String(meta.name || ""), type, url: meta.webUrl || null };
      if (!/^text\//.test(type) && !/^application\/(json|xml)$/.test(type)) return { ...out, note: "this file is not plain text; open it in OneDrive" };
      const raw = await request(acct, { path: `/drive/items/${encodeURIComponent(id)}/content`, raw: true });
      const text = String(raw.text || "");
      return { ...out, text: text.slice(0, TEXT_CAP), ...(text.length > TEXT_CAP ? { truncated: true } : {}) };
    },
  };
}
