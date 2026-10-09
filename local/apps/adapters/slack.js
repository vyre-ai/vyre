// @ts-check
// slack: messages to a Slack channel or person, and replies in a thread, through a Slack MCP
// server the person added to Vyre's MCP hub (ADR 0016). No Slack token lives in this module.
//
// A send or reply is `gated`, not `sends` in the apps.send sense: apps.act runs it, and it calls
// mcp.call, which holds the message at the Gate and returns { held, message }. Nothing reaches
// Slack until the person approves that item (gate.approve, with their proof), and then the hub
// releases exactly the approved arguments, once. apps.send, with its own proof, is for sends no
// Gate can hold (WhatsApp's UI).
//
// Before calling, the adapter checks that the hub counts the post tool as outward. A server that
// told the hub its post tool only reads would otherwise run the send at once, unapproved, so that
// is refused, and so is an answer that comes back without `held`.
//
// Never twice (ADR 0029, R2):
// - A held message is the queue. The same words to the same place already waiting at the Gate
//   are that item again, not a second one, so a retried apps.act (from an outbox, after a lost
//   answer, with or without an Idempotency-Key) cannot put two posts in front of the person.
// - A server that is down answers code `unreachable`, which an outbox keeps and retries; it is
//   never read as "no such channel".
// - An approval whose answer was lost (the server dropped mid-call) may or may not have posted.
//   `sent` reads the channel (or thread) for those exact words since the item was held, so a
//   surface asks it before offering to try again, and says "it went out" instead of posting twice.
//
// Which server: config apps.slack.server, by name. Without one, the server whose tools look like
// Slack's (a post tool and a channel list); two such servers is a question for settings, never a
// guess. Servers differ in names and argument keys, so both are read from the tool's own schema.

import { AppsError } from "../env.js";

/** Post tools of the Slack MCP servers people use, best known first. */
export const POST_TOOLS = ["slack_post_message", "conversations_add_message", "chat_postMessage", "post_message", "send_message"];
/** A tool made for thread replies; without one, the post tool with its thread argument. */
export const REPLY_TOOLS = ["slack_reply_to_thread", "reply_to_thread"];
/** Reads: channels, people, a channel's recent messages, a thread's replies. */
export const CHANNEL_TOOLS = ["slack_list_channels", "channels_list", "conversations_list", "list_channels"];
export const USER_TOOLS = ["slack_get_users", "users_list", "list_users"];
export const HISTORY_TOOLS = ["slack_get_channel_history", "conversations_history", "channel_history"];
export const REPLIES_TOOLS = ["slack_get_thread_replies", "conversations_replies", "thread_replies"];
const CHANNEL_KEYS = ["channel_id", "channel", "conversation_id", "to"];
const TEXT_KEYS = ["text", "payload", "message", "content"];
const THREAD_KEYS = ["thread_ts", "thread", "thread_id"];
const LIMIT_KEYS = ["limit", "count"];

/** A Slack id: a channel (C, G), a direct message (D) or a person (U, W). */
const SLACK_ID = /^[CGDUW][A-Z0-9]{6,}$/;
/** A message's ts, which is also its thread's id. */
const TS = /^\d{9,11}\.\d{1,8}$/;
/** Hub codes that mean the server did not answer: try again later, not "no". */
const DOWN = new Set(["unreachable", "exited", "closed", "timeout", "restarting", "offline"]);

/** The hub's tools, as mcp.tools lists them. @param {import("../env.js").Env} env */
async function hubTools(env) {
  const r = await env.call("mcp.tools", {});
  if (r && r.error) {
    if (r.error.code === "no_such_tool" || r.error.code === "not_found") throw new AppsError("setup", "Vyre's MCP hub is not running, so it cannot reach Slack");
    throw new AppsError("failed", r.error.message || "the MCP hub did not answer");
  }
  return Array.isArray(r && r.data && r.data.tools) ? r.data.tools : Array.isArray(r && r.data) ? r.data : [];
}

/**
 * The Slack server and its tools: the configured one, else the only one that looks like Slack.
 * @param {import("../env.js").Env} env
 */
export async function slackServer(env) {
  const tools = await hubTools(env);
  /** @type {Map<string, any[]>} */
  const by = new Map();
  for (const t of tools) {
    if (!t || typeof t.server !== "string") continue;
    by.set(t.server, [...(by.get(t.server) || []), t]);
  }
  const find = (/** @type {any[]} */ list, /** @type {string[]} */ names) => {
    for (const n of names) { const t = list.find(x => x.tool === n); if (t) return t; }
    return null;
  };
  const pick = (/** @type {string} */ server) => {
    const list = by.get(server) || [];
    return { server, post: find(list, POST_TOOLS), reply: find(list, REPLY_TOOLS), channels: find(list, CHANNEL_TOOLS), users: find(list, USER_TOOLS),
      history: find(list, HISTORY_TOOLS), replies: find(list, REPLIES_TOOLS) };
  };
  const named = env.config && env.config.slack && typeof env.config.slack.server === "string" ? env.config.slack.server : "";
  if (named) {
    if (!by.has(named)) throw new AppsError("setup", `The Slack server "${named}" in settings is not in Vyre's MCP hub (or has no tools yet)`);
    const s = pick(named);
    if (!s.post) throw new AppsError("setup", `The server "${named}" has no tool Vyre knows for posting to Slack`);
    return s;
  }
  const slackish = [...by.keys()].map(pick).filter(s => s.post && s.channels);
  if (slackish.length === 1) return slackish[0];
  if (!slackish.length) throw new AppsError("setup", "Add a Slack MCP server to Vyre (vyre mcp add), then Slack sends work from here");
  throw new AppsError("setup", `More than one server looks like Slack (${slackish.map(s => s.server).join(", ")}): pick one in settings as apps.slack.server`);
}

/** Whether the tool's input schema has a key. */
const hasKey = (/** @type {any} */ tool, /** @type {string} */ k) => Boolean(tool && tool.input && tool.input.properties && Object.prototype.hasOwnProperty.call(tool.input.properties, k));

/** The first of `keys` the tool's input schema has, else the first key. */
const keyOf = (/** @type {any} */ tool, /** @type {string[]} */ keys) => keys.find(k => hasKey(tool, k)) || keys[0];

/** A tool's result, as data: structuredContent, else JSON in its first text part. */
function resultData(/** @type {any} */ r) {
  if (!r || typeof r !== "object") return null;
  if (r.structuredContent && typeof r.structuredContent === "object") return r.structuredContent;
  const text = Array.isArray(r.content) ? r.content.find((/** @type {any} */ c) => c && c.type === "text") : null;
  if (!text || typeof text.text !== "string") return null;
  try { return JSON.parse(text.text); } catch { return null; }
}

/** The array in a list answer: the result itself, or its channels, members, users or messages. */
const listOf = (/** @type {any} */ d, /** @type {string[]} */ keys) => Array.isArray(d) ? d : keys.map(k => d && d[k]).find(Array.isArray) || [];

/** The server did not answer: a code an outbox keeps and retries. */
const down = (/** @type {string} */ server) => new AppsError("unreachable", `${server}, the Slack server in Vyre's MCP hub, is not answering; try again once it is back`);

/**
 * Run a read tool through the hub. Null for a tool the hub would hold (it is not a read) or a
 * refusal; a server that did not answer is code unreachable.
 * @param {import("../env.js").Env} env @param {string} server @param {any} tool @param {Record<string, any>} [args]
 */
async function read(env, server, tool, args = {}) {
  if (!tool || tool.outward) return null;
  const r = await env.call("mcp.call", { server, tool: tool.tool, arguments: args });
  if (r && r.error) {
    if (DOWN.has(String(r.error.code))) throw down(server);
    return null;
  }
  return resultData(r && r.data);
}

/**
 * Channels, then people, as targets. Archived channels and deleted people or bots are left out.
 * @param {Awaited<ReturnType<typeof slackServer>>} s @param {import("../env.js").Env} env
 */
async function targetsOf(s, env) {
  const [c, u] = await Promise.all([read(env, s.server, s.channels), read(env, s.server, s.users)]);
  /** @type {Array<{ id: string, title: string, kind: string, subtitle?: string }>} */
  const out = [];
  for (const ch of listOf(c, ["channels", "conversations"])) {
    if (!ch || typeof ch.id !== "string" || typeof ch.name !== "string" || ch.is_archived) continue;
    out.push({ id: ch.id, title: `#${ch.name}`, kind: "channel" });
  }
  for (const m of listOf(u, ["members", "users"])) {
    if (!m || typeof m.id !== "string" || typeof m.name !== "string" || m.deleted || m.is_bot) continue;
    const real = (m.profile && (m.profile.display_name || m.profile.real_name)) || m.real_name || m.name;
    out.push({ id: m.id, title: String(real), kind: "person", subtitle: `@${m.name}` });
  }
  return out;
}

/** A channel or person's id: as given when it is one, else looked up by name. */
async function idOf(/** @type {Awaited<ReturnType<typeof slackServer>>} */ s, /** @type {import("../env.js").Env} */ env, /** @type {string} */ to) {
  const t = String(to).trim();
  if (SLACK_ID.test(t)) return t;
  const want = t.replace(/^[#@]/, "").toLowerCase();
  const hits = (await targetsOf(s, env)).filter(x => x.title.replace(/^[#@]/, "").toLowerCase() === want || (x.subtitle || "").replace(/^@/, "").toLowerCase() === want);
  if (!hits.length) throw new AppsError("not_found", `Slack has no channel or person called ${t}`);
  if (hits.length > 1) throw new AppsError("bad_input", `Slack has ${hits.length} called ${t}; pick one by its id from apps.targets`);
  return hits[0].id;
}

/** Deep equality for JSON-shaped values. */
const same = (/** @type {any} */ a, /** @type {any} */ b) => JSON.stringify(canon(a)) === JSON.stringify(canon(b));
const canon = (/** @type {any} */ v) => Array.isArray(v) ? v.map(canon) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map(k => [k, canon(v[k])])) : v;

/**
 * The item already waiting at the Gate with exactly this call, if any: the one queued send.
 * @param {import("../env.js").Env} env @param {string} server @param {string} tool @param {Record<string, any>} args
 */
async function alreadyHeld(env, server, tool, args) {
  const list = await env.call("approvals.items", {});
  const cards = list && list.data && Array.isArray(list.data.items) ? list.data.items : [];
  const held = cards.filter((/** @type {any} */ c) => c && c.source === "gate" && c.facts).map((/** @type {any} */ c) => c.facts);
  for (const it of held) {
    if (!it || it.via !== `mcp:${server}`) continue;
    const full = await env.call("gate.get", { id: it.id });
    const c = full && full.data ? (full.data.final || full.data.draft) : null;
    // `tried`: an approval of it already failed, so it may have gone out; ask `sent` before again.
    if (c && c.server === server && c.tool === tool && same(c.arguments, args)) return { id: String(it.id), at: Number(it.at) || null, tried: Boolean(full.data.error) };
  }
  return null;
}

/**
 * Hold one post: check the tool is held by the hub, reuse the same message already waiting, and
 * call mcp.call. The answer carries the held item, its preview, and where to look for it later.
 * @param {Awaited<ReturnType<typeof slackServer>>} s @param {any} tool @param {Record<string, any>} args
 * @param {string} preview @param {import("../env.js").Env} env @param {{ channel: string, thread?: string, text: string }} where
 */
async function hold(s, tool, args, preview, env, where) {
  // The hub must hold this call. If it would run it, Vyre stops before anything is sent.
  if (!tool.outward) throw new AppsError("failed", `${s.server}'s ${tool.tool} is set to run without approval, so Vyre stopped: set it to write in the MCP settings`);
  const again = await alreadyHeld(env, s.server, tool.tool, args);
  if (again) return { said: `${preview} · already waiting for your approval`, preview, held: { id: again.id, message: "The same message is already waiting at the Gate.", at: again.at || env.now(), ...(again.tried ? { tried: true } : {}) }, again: true, where };
  const r = await env.call("mcp.call", { server: s.server, tool: tool.tool, arguments: args });
  if (r && r.error) {
    if (DOWN.has(String(r.error.code))) throw down(s.server);
    throw new AppsError(/^[a-z][a-z0-9_]{1,40}$/.test(String(r.error.code)) ? r.error.code : "failed", r.error.message || "the MCP hub refused");
  }
  const held = r && r.data && typeof r.data.held === "string" ? r.data.held : null;
  if (!held) throw new AppsError("failed", `${s.server} answered without holding the message for approval; check Slack before trying again`);
  return { said: `${preview} · waiting for your approval`, preview, held: { id: held, message: String(r.data.message || ""), at: env.now() }, where };
}

/** The line a person approves. */
const previewOf = (/** @type {any} */ args, reply = false) => `Slack → ${String(args.to || "").trim()}${reply ? " (thread)" : ""}: ${String(args.text || "")}`;

const text = { type: "string", maxLength: 4000 };
const to = { type: "string", description: "A channel (#general) or a person, or a Slack id from apps.targets." };
const thread = { type: "string", description: "The thread's ts (the first message's ts, from recent)." };

/** @type {import("./index.js").Adapter} */
export default {
  id: "slack",
  app: "Slack",
  bundleIds: ["com.tinyspeck.slackmacgap"],
  tier: "connector",
  actions: {
    send: {
      title: "Send a message",
      input: { type: "object", required: ["to", "text"], properties: { to, text } },
      sends: true,
      gated: true,
      preview: args => previewOf(args),
      async run(args, env) {
        const s = await slackServer(env);
        const post = /** @type {any} */ (s.post);
        const channel = await idOf(s, env, args.to);
        const call = { [keyOf(post, CHANNEL_KEYS)]: channel, [keyOf(post, TEXT_KEYS)]: String(args.text) };
        return hold(s, post, call, previewOf(args), env, { channel, text: String(args.text) });
      },
    },
    reply: {
      title: "Reply in a thread",
      input: { type: "object", required: ["to", "thread", "text"], properties: { to, thread, text } },
      sends: true,
      gated: true,
      preview: args => previewOf(args, true),
      async run(args, env) {
        const ts = String(args.thread).trim();
        if (!TS.test(ts)) throw new AppsError("bad_input", "thread must be a message's ts, like 1727430000.123456 (recent lists them)");
        const s = await slackServer(env);
        // A reply tool when the server has one; else the post tool, when it takes a thread.
        const tool = /** @type {any} */ (s.reply || (THREAD_KEYS.some(k => hasKey(s.post, k)) ? s.post : null));
        if (!tool) throw new AppsError("not_supported", `${s.server} has no way Vyre knows to reply in a thread`);
        const channel = await idOf(s, env, args.to);
        const call = { [keyOf(tool, CHANNEL_KEYS)]: channel, [keyOf(tool, THREAD_KEYS)]: ts, [keyOf(tool, TEXT_KEYS)]: String(args.text) };
        return hold(s, tool, call, previewOf(args, true), env, { channel, thread: ts, text: String(args.text) });
      },
    },
    recent: {
      title: "Recent messages in a channel, or a thread's replies",
      input: { type: "object", required: ["to"], properties: { to, thread, limit: { type: "integer", minimum: 1, maximum: 50 } } },
      sends: false,
      async run(args, env) {
        const s = await slackServer(env);
        const channel = await idOf(s, env, args.to);
        const messages = await messagesIn(s, env, channel, args.thread ? String(args.thread) : "", Number(args.limit) || 20);
        return { said: `${messages.length} recent in ${String(args.to).trim()}${args.thread ? "'s thread" : ""}`, messages };
      },
    },
    sent: {
      title: "Whether a message is in Slack already",
      input: { type: "object", required: ["to", "text"], properties: { to, thread, text, since: { type: "number", description: "When it was held, ms since 1970: older messages do not count." } } },
      sends: false,
      async run(args, env) {
        const s = await slackServer(env);
        const channel = await idOf(s, env, args.to);
        const since = Number(args.since) || 0;
        const hit = (await messagesIn(s, env, channel, args.thread ? String(args.thread) : "", 50))
          .find(m => m.text === String(args.text) && (!since || Number(m.ts) * 1000 >= since - 60_000));
        return hit ? { said: `It is in Slack already: ${previewOf(args, Boolean(args.thread))}`, sent: true, ts: hit.ts } : { said: "Not in Slack", sent: false };
      },
    },
  },
  /** Whether a Slack server is there to send through, for the "Which app?" question. */
  async ready(env) {
    try { await slackServer(env); return true; } catch { return false; }
  },
  async targets(q, env) {
    const s = await slackServer(env);
    const all = await targetsOf(s, env);
    const k = String(q || "").replace(/^[#@]/, "").toLowerCase();
    return k ? all.filter(t => t.title.toLowerCase().includes(k) || (t.subtitle || "").toLowerCase().includes(k)) : all;
  },
};

/**
 * A channel's recent messages, or a thread's replies, newest first: ts, text, who, and for a
 * thread's first message how many replies it has.
 * @param {Awaited<ReturnType<typeof slackServer>>} s @param {import("../env.js").Env} env
 * @param {string} channel @param {string} ts @param {number} limit
 */
async function messagesIn(s, env, channel, ts, limit) {
  const tool = ts ? s.replies : s.history;
  if (!tool) throw new AppsError("not_supported", `${s.server} has no way Vyre knows to read ${ts ? "a thread" : "a channel"}`);
  const args = { [keyOf(tool, CHANNEL_KEYS)]: channel, ...(ts ? { [keyOf(tool, THREAD_KEYS)]: ts } : {}), ...(hasKey(tool, "limit") || hasKey(tool, "count") ? { [keyOf(tool, LIMIT_KEYS)]: limit } : {}) };
  const d = await read(env, s.server, tool, args);
  if (d === null) throw new AppsError("failed", `${s.server} did not answer with messages`);
  return listOf(d, ["messages", "replies"])
    .filter((/** @type {any} */ m) => m && typeof m.ts === "string" && typeof m.text === "string")
    .map((/** @type {any} */ m) => ({ ts: m.ts, text: m.text, ...(m.user ? { user: String(m.user) } : {}), ...(m.reply_count ? { replies: Number(m.reply_count) } : {}) }))
    .sort((/** @type {any} */ a, /** @type {any} */ b) => Number(b.ts) - Number(a.ts))
    .slice(0, limit);
}
