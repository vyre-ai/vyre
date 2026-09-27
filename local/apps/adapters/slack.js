// @ts-check
// slack: messages to a Slack channel or person, through a Slack MCP server the person added to
// Vyre's MCP hub (ADR 0016). No Slack token lives in this module.
//
// A send is `gated`, not `sends` in the apps.send sense: apps.act runs it, and it calls mcp.call,
// which holds the message at the Gate and returns { held, message }. Nothing reaches Slack until
// the person approves that item (gate.approve, with their proof), and then the hub releases
// exactly the approved arguments, once. apps.send, with its own proof, is for sends no Gate can
// hold (WhatsApp's UI).
//
// Before calling, the adapter checks that the hub counts the send tool as outward. A server that
// told the hub its post tool only reads would otherwise run the send at once, unapproved, so that
// is refused, and so is an answer that comes back without `held`.
//
// Which server: config apps.slack.server, by name. Without one, the server whose tools look like
// Slack's (a post tool and a channel list); two such servers is a question for settings, never a
// guess. Servers differ in names and argument keys, so both are read from the tool's own schema.

import { AppsError } from "../env.js";

/** Post tools of the Slack MCP servers people use, best known first. */
export const POST_TOOLS = ["slack_post_message", "conversations_add_message", "chat_postMessage", "post_message", "send_message"];
/** Channel lists and people lists, read-only. */
export const CHANNEL_TOOLS = ["slack_list_channels", "channels_list", "conversations_list", "list_channels"];
export const USER_TOOLS = ["slack_get_users", "users_list", "list_users"];
const CHANNEL_KEYS = ["channel_id", "channel", "conversation_id", "to"];
const TEXT_KEYS = ["text", "payload", "message", "content"];

/** A Slack id: a channel (C, G), a direct message (D) or a person (U, W). */
const SLACK_ID = /^[CGDUW][A-Z0-9]{6,}$/;

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
    return { server, post: find(list, POST_TOOLS), channels: find(list, CHANNEL_TOOLS), users: find(list, USER_TOOLS) };
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

/** The first of `keys` the tool's input schema has, else the first key. */
function keyOf(/** @type {any} */ tool, /** @type {string[]} */ keys) {
  const props = tool && tool.input && tool.input.properties && typeof tool.input.properties === "object" ? tool.input.properties : {};
  return keys.find(k => Object.prototype.hasOwnProperty.call(props, k)) || keys[0];
}

/** A tool's result, as data: structuredContent, else JSON in its first text part. */
function resultData(/** @type {any} */ r) {
  if (!r || typeof r !== "object") return null;
  if (r.structuredContent && typeof r.structuredContent === "object") return r.structuredContent;
  const text = Array.isArray(r.content) ? r.content.find((/** @type {any} */ c) => c && c.type === "text") : null;
  if (!text || typeof text.text !== "string") return null;
  try { return JSON.parse(text.text); } catch { return null; }
}

/** The array in a list answer: the result itself, or its channels, members or users. */
const listOf = (/** @type {any} */ d, /** @type {string[]} */ keys) => Array.isArray(d) ? d : keys.map(k => d && d[k]).find(Array.isArray) || [];

/** Run a read tool through the hub; nothing when it is not a read (it would be held) or fails. */
async function read(/** @type {import("../env.js").Env} */ env, /** @type {string} */ server, /** @type {any} */ tool) {
  if (!tool || tool.outward) return null;
  const r = await env.call("mcp.call", { server, tool: tool.tool, arguments: {} });
  return r && !r.error ? resultData(r.data) : null;
}

/** The line a person approves. */
const previewOf = (/** @type {any} */ args) => `Slack → ${String(args.to || "").trim()}: ${String(args.text || "")}`;

/** @type {import("./index.js").Adapter} */
export default {
  id: "slack",
  app: "Slack",
  bundleIds: ["com.tinyspeck.slackmacgap"],
  tier: "connector",
  actions: {
    send: {
      title: "Send a message",
      input: { type: "object", required: ["to", "text"], properties: {
        to: { type: "string", description: "A channel (#general) or a person, or a Slack id from apps.targets." },
        text: { type: "string", maxLength: 4000 },
      } },
      sends: true,
      gated: true,
      preview: args => previewOf(args),
      async run(args, env) {
        const s = await slackServer(env);
        const post = /** @type {any} */ (s.post);
        // The hub must hold this call. If it would run it, Vyre stops before anything is sent.
        if (!post.outward) throw new AppsError("failed", `${s.server}'s ${post.tool} is set to run without approval, so Vyre stopped: set it to write in the MCP settings`);
        const to = String(args.to).trim();
        let id = SLACK_ID.test(to) ? to : "";
        if (!id) {
          const want = to.replace(/^[#@]/, "").toLowerCase();
          const hit = (await targetsOf(s, env)).find(t => t.title.replace(/^[#@]/, "").toLowerCase() === want || (t.subtitle || "").replace(/^@/, "").toLowerCase() === want);
          if (!hit) throw new AppsError("not_found", `Slack has no channel or person called ${to}`);
          id = hit.id;
        }
        const r = await env.call("mcp.call", { server: s.server, tool: post.tool, arguments: { [keyOf(post, CHANNEL_KEYS)]: id, [keyOf(post, TEXT_KEYS)]: String(args.text) } });
        if (r && r.error) throw new AppsError(/^[a-z][a-z0-9_]{1,40}$/.test(String(r.error.code)) ? r.error.code : "failed", r.error.message || "the MCP hub refused");
        const held = r && r.data && typeof r.data.held === "string" ? r.data.held : null;
        if (!held) throw new AppsError("failed", `${s.server} answered without holding the message for approval; check Slack before trying again`);
        const preview = previewOf(args);
        return { said: `${preview} · waiting for your approval`, preview, held: { id: held, message: String(r.data.message || "") } };
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
 * Channels, then people, as targets. Archived channels and deleted people or bots are left out.
 * @param {{ server: string, channels: any, users: any }} s @param {import("../env.js").Env} env
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
