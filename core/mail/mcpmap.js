// @ts-check
// mcpmap: how a mail account served by an MCP server maps mail.send, mail.search and mail.read
// onto that server's own tools (ADR 0016 decision 8). Pure: no I/O.
//
// MCP mail servers name things their own way (send_email, gmail_send_message; to, recipient,
// recipients). `guess` reads the tools the hub cached and picks one per verb, with the argument
// each field goes in, and the person corrects it with mail.update when the guess is wrong. The
// map is stored, so a server that renames a tool later does not change what a send calls.

const pick = (props, names) => names.find(n => Object.prototype.hasOwnProperty.call(props, n));
const propsOf = t => (t && t.input && typeof t.input === "object" && t.input.properties && typeof t.input.properties === "object") ? t.input.properties : {};

const TO = ["to", "recipients", "recipient", "to_address", "toAddress", "email", "address"];
const SUBJECT = ["subject", "title"];
const BODY = ["body", "text", "content", "message", "plain_text", "body_text"];
const CC = ["cc"], BCC = ["bcc"];
const REPLY = ["in_reply_to", "inReplyTo", "reply_to_message_id"];
const Q = ["query", "q", "search", "filter", "search_query"];
const LIMIT = ["max_results", "maxResults", "limit", "count", "page_size", "pageSize"];
const ID = ["id", "message_id", "messageId", "email_id", "emailId"];

const MAILISH = /(mail|email|message|msg|thread|inbox)/i;

/**
 * The best tool for a verb: its name matches, and it has the arguments the verb needs.
 * @param {any[]} tools @param {RegExp} verb @param {string[][]} need
 */
function best(tools, verb, need) {
  const scored = [];
  for (const t of tools) {
    const n = String(t.tool || t.name || "");
    if (!verb.test(n)) continue;
    const p = propsOf(t);
    if (!need.every(names => pick(p, names))) continue;
    scored.push({ t, score: (MAILISH.test(n) ? 2 : 0) + (/mail/i.test(n) ? 1 : 0) - n.length / 1000 });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.length ? scored[0].t : null;
}

/**
 * Guess the map from a server's tools (as mcp.tools lists them: { tool, input, ... }).
 * @param {any[]} tools
 * @returns {{ send?: any, search?: any, read?: any }}
 */
export function guess(tools) {
  const list = Array.isArray(tools) ? tools : [];
  /** @type {any} */
  const map = {};
  const s = best(list, /send|compose_and_send|^reply$/i, [TO, SUBJECT, BODY]);
  if (s) {
    const p = propsOf(s);
    const to = /** @type {string} */ (pick(p, TO));
    map.send = { tool: String(s.tool), to, subject: pick(p, SUBJECT), body: pick(p, BODY), to_list: p[to]?.type === "array",
      ...(pick(p, CC) ? { cc: pick(p, CC) } : {}), ...(pick(p, BCC) ? { bcc: pick(p, BCC) } : {}), ...(pick(p, REPLY) ? { in_reply_to: pick(p, REPLY) } : {}) };
  }
  const q = best(list.filter(t => MAILISH.test(String(t.tool || t.name))), /search|list|find|query/i, [Q]);
  if (q) { const p = propsOf(q); map.search = { tool: String(q.tool), q: pick(p, Q), ...(pick(p, LIMIT) ? { limit: pick(p, LIMIT) } : {}) }; }
  const r = best(list.filter(t => MAILISH.test(String(t.tool || t.name))), /get|read|fetch|open/i, [ID]);
  if (r) { const p = propsOf(r); map.read = { tool: String(r.tool), id: pick(p, ID) }; }
  return map;
}

const fail = (msg, code = "bad_input") => Object.assign(new Error(msg), { code });

/** Check a map the person gave (or the guess), for the verbs it has. @param {any} map */
export function checkMap(map) {
  if (!map || typeof map !== "object") return "map must be { send, search, read }";
  const arg = v => typeof v === "string" && /^[A-Za-z0-9_.-]{1,64}$/.test(v);
  for (const [verb, need] of [["send", ["tool", "to", "subject", "body"]], ["search", ["tool", "q"]], ["read", ["tool", "id"]]]) {
    const m = map[verb];
    if (m === undefined) continue;
    if (!m || typeof m !== "object") return `map.${verb} must be an object`;
    for (const k of need) if (!arg(m[k])) return `map.${verb}.${k} must name the server's tool or argument`;
    for (const k of ["cc", "bcc", "in_reply_to", "limit"]) if (m[k] !== undefined && !arg(m[k])) return `map.${verb}.${k} must name an argument`;
  }
  if (!map.send) return "no tool on this server looks like it sends mail; give map.send { tool, to, subject, body }";
  return null;
}

/** The arguments of the mapped send tool for one message. @param {any} m @param {string[]} to @param {any} c */
export function sendArgs(m, to, c) {
  /** @type {Record<string, any>} */
  const a = { [m.to]: m.to_list ? to : to.join(", "), [m.subject]: c.subject, [m.body]: c.body };
  if (m.cc && c.cc && c.cc.length) a[m.cc] = m.to_list ? c.cc : c.cc.join(", ");
  else if (c.cc && c.cc.length) throw fail("this account's send tool takes no cc");
  if (m.bcc && c.bcc && c.bcc.length) a[m.bcc] = m.to_list ? c.bcc : c.bcc.join(", ");
  else if (c.bcc && c.bcc.length) throw fail("this account's send tool takes no bcc");
  if (m.in_reply_to && c.in_reply_to) a[m.in_reply_to] = c.in_reply_to;
  return a;
}

/** The value an MCP result carries: structuredContent, else the first text part read as JSON. */
function valueOf(result) {
  if (result && result.structuredContent !== undefined) return result.structuredContent;
  const text = (result && Array.isArray(result.content) ? result.content : []).filter(x => x && x.type === "text").map(x => String(x.text)).join("\n");
  try { return JSON.parse(text); } catch { return { text }; }
}

const first = (o, keys) => { for (const k of keys) if (o && o[k] !== undefined && o[k] !== null) return o[k]; return undefined; };
const asText = v => (Array.isArray(v) ? v.map(x => (typeof x === "object" && x ? first(x, ["email", "address", "name"]) : x)).join(", ") : typeof v === "object" && v ? String(first(v, ["email", "address", "name"]) ?? "") : String(v ?? ""));

/**
 * Messages from a search tool's result, in mail.search's shape, as far as the server says them.
 * @param {any} result @param {string} account
 */
export function messagesOf(result, account) {
  if (result && result.isError) throw fail(String(valueOf(result)?.text || "the server refused the search").slice(0, 300), "mcp");
  const v = valueOf(result);
  const list = Array.isArray(v) ? v : first(v, ["messages", "results", "items", "emails", "threads", "data"]);
  if (!Array.isArray(list)) return [];
  return list.filter(x => x && typeof x === "object").map(x => {
    const date = String(first(x, ["date", "internalDate", "receivedAt", "received", "sent_at"]) ?? "");
    const at = /^\d{10,13}$/.test(date) ? Number(date) : Date.parse(date) || 0;
    return { account, id: String(first(x, ["id", "message_id", "messageId"]) ?? ""), ...(first(x, ["thread_id", "threadId"]) ? { thread_id: String(first(x, ["thread_id", "threadId"])) } : {}),
      from: asText(first(x, ["from", "sender"])), to: asText(first(x, ["to", "recipients"])), subject: String(first(x, ["subject", "title"]) ?? "(no subject)"),
      date, snippet: String(first(x, ["snippet", "preview", "summary", "text"]) ?? "").slice(0, 300), _at: at };
  }).filter(m => m.id);
}

/** One message from a read tool's result. @param {any} result @param {string} account @param {string} id */
export function messageOf(result, account, id) {
  if (result && result.isError) throw fail(String(valueOf(result)?.text || "the server refused the read").slice(0, 300), "mcp");
  const v = valueOf(result);
  const x = v && typeof v === "object" && !Array.isArray(v) ? (first(v, ["message", "email"]) || v) : { text: String(v) };
  const body = String(first(x, ["body", "text", "content", "plain", "snippet"]) ?? "");
  return { account, id: String(first(x, ["id", "message_id", "messageId"]) ?? id), from: asText(first(x, ["from", "sender"])), to: asText(first(x, ["to", "recipients"])),
    subject: String(first(x, ["subject", "title"]) ?? "(no subject)"), date: String(first(x, ["date"]) ?? ""),
    body: body.length > 20_000 ? body.slice(0, 20_000) : body, ...(body.length > 20_000 ? { truncated: true } : {}) };
}
