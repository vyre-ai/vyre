// @ts-check
// A fake Google for the connector tests: one mailbox (Gmail: profile, messages list and get in metadata form, drafts, send) and one calendar (events list by updatedMin, get, insert, patch,
// delete), the bearer token checked. A message is what Gmail's metadata format gives: id, threadId, snippet, internalDate (ms, as text) and payload.headers. `handle` takes a request shaped
// like the vault's transport call; `serve` puts the same handler on a local port.

import http from "node:http";

export const TOKEN = "ya29.fake-connector-token";

export function fakeGoogle(o = { mailbox: "alex@harlow.test" }) {
  const g = { mailbox: o.mailbox, messages: /** @type {any[]} */ ([]), drafts: /** @type {any[]} */ ([]), sent: /** @type {any[]} */ ([]), events: new Map(), calls: /** @type {any[]} */ ([]), n: 0, clock: 1791000000000, limitNext: 0 };
  const reply = (/** @type {number} */ status, /** @type {any} */ body, /** @type {Record<string, string>} */ headers = {}) => ({ status, headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  /** A message as the mailbox holds it. @param {{ from: string, to?: string, cc?: string, subject: string, snippet?: string, at?: number, thread?: string }} m */
  function addMessage(m) {
    const id = `18f${String(++g.n).padStart(5, "0")}`;
    const headers = [{ name: "From", value: m.from }, { name: "To", value: m.to ?? g.mailbox }, ...(m.cc ? [{ name: "Cc", value: m.cc }] : []), { name: "Subject", value: m.subject }, { name: "Message-ID", value: `<${id}@mail.test>` }];
    const msg = { id, threadId: m.thread ?? `t${id}`, snippet: m.snippet ?? "", internalDate: String(m.at ?? (g.clock += 60_000)), labelIds: ["INBOX"], payload: { headers } };
    g.messages.push(msg); return msg;
  }
  /** An event as Calendar holds it; `updated` moves forward on every write unless the test gives it. @param {any} e */
  function putEvent(e) {
    const id = e.id ?? `ev${++g.n}`;
    const row = { kind: "calendar#event", status: "confirmed", ...e, id, etag: `"${g.n}"`, updated: e.updated ?? new Date(g.clock += 1000).toISOString(), htmlLink: `https://calendar.google.com/event?eid=${id}` };
    g.events.set(id, row); return row;
  }
  /** @param {{ method: string, url: URL, headers: Record<string, string>, body?: string }} r */
  function handle(r) {
    g.calls.push({ method: r.method, path: r.url.pathname, search: r.url.search, headers: r.headers, body: r.body });
    if (r.headers.authorization !== `Bearer ${TOKEN}`) return reply(401, { error: { code: 401, message: "Invalid Credentials" } });
    if (g.limitNext > 0) { g.limitNext--; return reply(429, { error: { code: 429 } }, { "retry-after": "1" }); }
    const p = r.url.pathname, m = r.method, q = r.url.searchParams;
    let hit;
    const json = () => { try { return JSON.parse(r.body || "{}"); } catch { return {}; } };
    if (m === "GET" && p === "/gmail/v1/users/me/profile") return reply(200, { emailAddress: g.mailbox, messagesTotal: g.messages.length });
    if (m === "GET" && p === "/gmail/v1/users/me/messages") {
      const after = /after:(\d+)/.exec(q.get("q") || "");
      const rows = g.messages.filter(x => !after || Number(x.internalDate) >= Number(after[1]) * 1000).slice(0, Number(q.get("maxResults") || 100));
      return reply(200, rows.length ? { messages: rows.map(x => ({ id: x.id, threadId: x.threadId })), resultSizeEstimate: rows.length } : { resultSizeEstimate: 0 });
    }
    if (m === "GET" && (hit = /^\/gmail\/v1\/users\/me\/messages\/([^/]+)$/.exec(p))) {
      const x = g.messages.find(y => y.id === hit[1]);
      if (!x) return reply(404, { error: { code: 404, message: "Requested entity was not found." } });
      const want = q.getAll("metadataHeaders");
      return reply(200, { ...x, payload: { headers: want.length ? x.payload.headers.filter((/** @type {any} */ h) => want.includes(h.name)) : x.payload.headers } });
    }
    if (m === "POST" && p === "/gmail/v1/users/me/drafts") { const b = json(); if (!b.message || !b.message.raw) return reply(400, { error: { code: 400, message: "Invalid message" } }); const d = { id: `r${++g.n}`, message: { id: `m${g.n}`, threadId: b.message.threadId ?? `t${g.n}` }, raw: b.message.raw }; g.drafts.push(d); return reply(200, { id: d.id, message: d.message }); }
    if (m === "POST" && p === "/gmail/v1/users/me/messages/send") { const b = json(); if (!b.raw) return reply(400, { error: { code: 400, message: "Invalid message" } }); const s = { id: `s${++g.n}`, threadId: b.threadId ?? `t${g.n}`, raw: b.raw }; g.sent.push(s); return reply(200, { id: s.id, threadId: s.threadId, labelIds: ["SENT"] }); }
    if (m === "POST" && p === "/gmail/v1/users/me/drafts/send") { const b = json(); const d = g.drafts.find(x => x.id === b.id); if (!d) return reply(404, { error: { code: 404 } }); g.sent.push({ id: `s${++g.n}`, raw: d.raw }); return reply(200, { id: `s${g.n}`, labelIds: ["SENT"] }); }
    if ((hit = /^\/calendar\/v3\/calendars\/([^/]+)\/events(?:\/([^/]+))?$/.exec(p))) {
      const id = hit[2] && decodeURIComponent(hit[2]);
      if (m === "GET" && !id) {
        const since = q.get("updatedMin");
        const items = [...g.events.values()].filter(e => !since || Date.parse(e.updated) >= Date.parse(since)).filter(e => q.get("showDeleted") === "true" || e.status !== "cancelled");
        return reply(200, { kind: "calendar#events", items: items.slice(0, Number(q.get("maxResults") || 250)) });
      }
      if (m === "GET" && id) { const e = g.events.get(id); return e ? reply(200, e) : reply(404, { error: { code: 404 } }); }
      if (m === "POST" && !id) { const b = json(); if (!b.start || !b.end) return reply(400, { error: { code: 400, message: "Missing start or end" } }); if (b.id && g.events.has(b.id)) return reply(409, { error: { code: 409, message: "The requested identifier already exists." } }); return reply(200, putEvent(b)); }
      if (m === "PATCH" && id) { const cur = g.events.get(id); return cur ? reply(200, putEvent({ ...cur, ...json(), id })) : reply(404, { error: { code: 404 } }); }
      if (m === "DELETE" && id) { const cur = g.events.get(id); if (!cur) return reply(404, { error: { code: 404 } }); putEvent({ ...cur, status: "cancelled" }); return { status: 204, headers: {}, body: "" }; }
    }
    return reply(404, { error: { code: 404, message: `no route ${m} ${p}` } });
  }
  /** @param {number} [port] */
  async function serve(port = 0) {
    const server = http.createServer((req, res) => {
      const chunks = /** @type {Buffer[]} */ ([]);
      req.on("data", c => chunks.push(c));
      req.on("end", () => { const out = handle({ method: req.method || "GET", url: new URL(req.url || "/", "http://x"), headers: /** @type {any} */ (req.headers), body: Buffer.concat(chunks).toString("utf8") }); res.writeHead(out.status, out.headers); res.end(out.body); });
    });
    await new Promise(ok => server.listen(port, "127.0.0.1", () => ok(undefined)));
    return { url: `http://127.0.0.1:${/** @type {any} */ (server.address()).port}`, close: () => new Promise(ok => server.close(() => ok(undefined))) };
  }
  return Object.assign(g, { handle, addMessage, putEvent, serve });
}
