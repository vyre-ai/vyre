// @ts-check
// bridge — Mattermost and Vyre's threads, kept as one thing (floor rule 3).
//
// A channel per project and a thread per session. Out: switchboard and Gate events become posts
// (a session's root, its replies, questions with buttons, held drafts with Send, Edit, Discard),
// and resolved ones are patched in place with their buttons gone. In: the owner's posts, found
// by polling each mapped channel with `since`, become threads.send or threads.start, and their
// button presses become threads.answer, gate.approve and gate.reject.
//
// Why polling and not the websocket: it needs no dependency, it survives Mattermost restarting
// with nothing to reconnect, and `since` makes a missed interval cost a delay, never a message.
// Dedupe is by post id, so seeing a post twice (edits bump update_at) changes nothing.
//
// Everything runs through one serial queue: events, polls and presses. A thread that Chat itself
// started is mapped to the owner's root post before its thread.started event is handled, which
// is what stops that event from making a second root.
//
// Only the owner is obeyed. Posts from anyone else, and the bot's own, are recorded as seen and
// otherwise ignored; a stranger's reply in a thread never reaches a session.

import crypto from "node:crypto";
import { askPost, heldPost, heldPatch, resolvedPatch, textPost, cut } from "./posts.js";

export const MIGRATIONS = [
  `CREATE TABLE chat_channels (project TEXT PRIMARY KEY, channel_id TEXT NOT NULL UNIQUE, name TEXT NOT NULL, since INTEGER NOT NULL);
   CREATE TABLE chat_threads (thread TEXT PRIMARY KEY, channel_id TEXT NOT NULL, root_id TEXT NOT NULL UNIQUE, at INTEGER NOT NULL);
   CREATE TABLE chat_posts (post_id TEXT PRIMARY KEY, direction TEXT NOT NULL, at INTEGER NOT NULL);
   CREATE TABLE chat_items (kind TEXT NOT NULL, item_id TEXT NOT NULL, post_id TEXT NOT NULL, channel_id TEXT NOT NULL, root_id TEXT,
     message TEXT NOT NULL, state TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (kind, item_id));
   CREATE TABLE chat_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);`,
];

/** The events Chat mirrors, and the module each must come from. */
const MIRRORED = {
  "thread.started": "threads", "thread.text": "threads", "thread.sent": "threads", "thread.stopped": "threads",
  "lease.changed": "threads", "ask.raised": "threads", "ask.answered": "threads",
  "gate.held": "gate", "gate.revised": "gate", "gate.released": "gate", "gate.failed": "gate", "gate.rejected": "gate",
};

/** A Mattermost channel name: lowercase letters, digits, dashes; 2 to 64 characters. @param {string} s */
export function channelName(s) {
  const n = String(s || "").toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^[-_]+|[-_]+$/g, "").slice(0, 64);
  return n.length >= 2 ? n : `project-${n || "x"}`;
}

/** Compare two strings in constant time. @param {unknown} a @param {unknown} b */
export function same(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || !a || !b) return false;
  const h = s => crypto.createHash("sha256").update(s).digest();
  return crypto.timingSafeEqual(h(a), h(b));
}

/** Is this surface Chat's own? @param {unknown} s */
const ours = s => typeof s === "string" && (s === "chat" || s.startsWith("chat:"));

/** How a surface reads in a sentence. @param {string|null|undefined} s */
function surfaceLabel(s) {
  if (!s) return "nobody";
  if (s === "cli") return "the terminal";
  if (s === "chat" || s.startsWith("chat:")) return "Chat";
  if (s.startsWith("agent:")) return s.slice(6);
  return `the ${s}`;
}

/**
 * @typedef {{ post: (p: any) => Promise<any>, patch: (id: string, p: any) => Promise<any>, postsSince: (c: string, since: number) => Promise<any[]>,
 *   channelByName: (t: string, n: string) => Promise<any>, createChannel: (c: any) => Promise<any>, addMember: (c: string, u: string) => Promise<any>,
 *   me: () => Promise<any>, team: (n: string) => Promise<any>, user: (n: string) => Promise<any> }} MM
 */

export class Bridge {
  /**
   * @param {{ db: import("node:sqlite").DatabaseSync, mm: MM, call: (tool: string, input: any) => Promise<any>,
   *   log: (m: string) => void, team: string, owner: string, hook: string, deck?: string, slashToken?: () => Promise<string>, now?: () => number }} o
   */
  constructor(o) {
    this.db = o.db; this.mm = o.mm; this.call = o.call; this.log = o.log;
    this.teamName = o.team; this.ownerName = o.owner; this.hook = o.hook.replace(/\/+$/, "");
    this.deck = o.deck ? String(o.deck).replace(/\/+$/, "") : "";
    // The switchboard's lease names the surface and who is at it, so another surface can say
    // "Chat (alex) has the keyboard". Anything starting with "chat" is ours.
    this.surface = `chat:${o.owner}`;
    this.slashToken = o.slashToken || (async () => "");
    this.now = o.now || Date.now;
    /** @type {Promise<any>} */
    this.q = Promise.resolve();
    this.botId = ""; this.ownerId = ""; this.teamId = "";
    this.secret = this.state("hook-secret") || this.setState("hook-secret", crypto.randomBytes(24).toString("hex"));
  }

  /** @param {string} k */
  state(k) { const r = /** @type {any} */ (this.db.prepare("SELECT value FROM chat_state WHERE key = ?").get(k)); return r ? String(r.value) : null; }
  /** @param {string} k @param {string} v */
  setState(k, v) { this.db.prepare("INSERT OR REPLACE INTO chat_state (key, value) VALUES (?, ?)").run(k, v); return v; }

  get h() { return { hook: this.hook, secret: this.secret, ...(this.deck ? { deck: this.deck } : {}) }; }

  /** Find the bot, the team and the owner. Throws with Mattermost's reason when one is missing. */
  async connect() {
    const me = await this.mm.me();
    const team = await this.mm.team(this.teamName);
    const owner = await this.mm.user(this.ownerName);
    this.botId = me.id; this.teamId = team.id; this.ownerId = owner.id;
    await this.channelFor(null);
  }

  /**
   * Run a job after every job before it. Resolves to its result; a failure is logged and
   * rethrown to the one caller waiting for it, never to the queue.
   * @template T @param {() => Promise<T>} job @returns {Promise<T>}
   */
  enqueue(job) {
    const run = this.q.then(job);
    this.q = run.catch(e => this.log(`chat: ${/** @type {Error} */ (e).message}`));
    return run;
  }

  /** Wait until everything queued so far has run. */
  idle() { return this.q.then(() => undefined); }

  /** What vyred's bus hands us. Unknown types and impostor sources are dropped here. @param {any} e */
  onEvent(e) {
    if (!e || MIRRORED[e.type] !== e.source || !this.ownerId) return;
    this.enqueue(() => this.out(e)).catch(() => {});
  }

  // ---- channels and threads --------------------------------------------------------------

  /** The channel for a project (null: the `sessions` channel), made on first use. @param {string|null} project */
  async channelFor(project) {
    const key = project || "";
    const row = /** @type {any} */ (this.db.prepare("SELECT * FROM chat_channels WHERE project = ?").get(key));
    if (row) return row;
    const name = project ? channelName(project) : "sessions";
    let display = project || "Sessions";
    if (project) {
      const r = await this.call("projects.list", {});
      const p = r && Array.isArray(r.data) ? r.data.find(x => x.slug === project || x.name === project) : null;
      if (p && p.name) display = String(p.name);
    }
    let ch = await this.mm.channelByName(this.teamId, name);
    if (!ch) ch = await this.mm.createChannel({ team_id: this.teamId, name, display_name: cut(display, 64),
      purpose: project ? `Vyre project ${display}. One thread per session.` : "Vyre sessions outside a project. One thread per session." });
    try { await this.mm.addMember(ch.id, this.ownerId); } catch (e) { this.log(`chat: adding the owner to ${name}: ${/** @type {Error} */ (e).message}`); }
    // Only posts from now on: a channel that already had history is not replayed into sessions.
    this.db.prepare("INSERT OR REPLACE INTO chat_channels (project, channel_id, name, since) VALUES (?,?,?,?)").run(key, ch.id, name, this.now() - 1);
    return /** @type {any} */ (this.db.prepare("SELECT * FROM chat_channels WHERE project = ?").get(key));
  }

  /** @param {string} thread */
  threadRow(thread) { return /** @type {any} */ (this.db.prepare("SELECT * FROM chat_threads WHERE thread = ?").get(thread)) || null; }

  /** @param {string} thread @param {string} channel @param {string} root */
  mapThread(thread, channel, root) {
    this.db.prepare("INSERT OR IGNORE INTO chat_threads (thread, channel_id, root_id, at) VALUES (?,?,?,?)").run(thread, channel, root, this.now());
  }

  /**
   * The Mattermost thread for a session, made when first needed. A session that started before
   * Chat was connected still gets one the first time it says something.
   * @param {string} thread @param {string|null} project @param {{ name?: string, cwd?: string, agent?: string }} [about]
   */
  async ensureThread(thread, project, about = {}) {
    const have = this.threadRow(thread);
    if (have) return have;
    const ch = await this.channelFor(project);
    const head = [`**${cut(about.name || `Session ${thread.slice(0, 8)}`, 120)}**${about.agent ? ` · ${about.agent}` : ""}`];
    if (about.cwd) head.push("`" + cut(about.cwd, 200) + "`");
    head.push("_Reply in this thread to type into the session._");
    const root = await this.send(textPost({ channel: ch.channel_id, message: head.join("\n") }));
    this.mapThread(thread, ch.channel_id, root.id);
    return this.threadRow(thread);
  }

  /** Post, and remember the post as ours. @param {any} p */
  async send(p) {
    const post = await this.mm.post(p);
    if (post && post.id) this.db.prepare("INSERT OR IGNORE INTO chat_posts (post_id, direction, at) VALUES (?, 'out', ?)").run(post.id, this.now());
    return post;
  }

  /** A reply in a session's thread. @param {any} t the chat_threads row @param {string} message */
  reply(t, message) { return this.send(textPost({ channel: t.channel_id, root: t.root_id, message })); }

  // ---- out: events to posts --------------------------------------------------------------

  /** @param {any} e */
  async out(e) {
    const p = e.payload || {};
    const thread = p.thread || e.thread || null;
    const project = p.project || e.project || null;
    switch (e.type) {
      case "thread.started":
        if (thread) await this.ensureThread(thread, project, { name: p.name, cwd: p.cwd, agent: p.agent });
        return;
      case "thread.text": {
        if (!thread || !p.done || !p.text) return;
        const t = await this.ensureThread(thread, project);
        await this.reply(t, p.notice ? `_${p.text}_` : p.text);
        return;
      }
      case "thread.sent": {
        // What was typed into the session from somewhere else, so this thread reads the same as
        // the terminal. What was typed here is already here.
        if (!thread || !p.text || ours(p.surface)) return;
        const t = await this.ensureThread(thread, project);
        const who = p.surface && String(p.surface).startsWith("agent:") ? `**${String(p.surface).slice(6)}** asked` : `**You**, from ${surfaceLabel(p.surface)}`;
        await this.reply(t, `${who}\n> ${String(p.text).split("\n").join("\n> ")}`);
        return;
      }
      case "lease.changed": {
        const t = thread && this.threadRow(thread);
        if (!t) return;
        if (ours(p.holder) && p.previous && !ours(p.previous)) await this.reply(t, `_Took the keyboard from ${surfaceLabel(p.previous)}. It is read-only there now._`);
        else if (p.holder && !ours(p.holder) && ours(p.previous)) await this.reply(t, `_The keyboard moved to ${surfaceLabel(p.holder)}. Type here to take it back._`);
        return;
      }
      case "thread.stopped": {
        const t = thread && this.threadRow(thread);
        if (t) await this.reply(t, `_Session stopped${p.reason ? `: ${cut(p.reason, 200)}` : ""}._`);
        return;
      }
      case "ask.raised": {
        if (!thread || !p.ask) return;
        const t = await this.ensureThread(thread, project);
        const post = await this.send(askPost(p, { channel: t.channel_id, root: t.root_id, ...this.h }));
        this.item("ask", p.ask, post, t.channel_id, t.root_id);
        return;
      }
      case "ask.answered": {
        const word = p.decision === "allow" ? "Allowed" : p.decision === "deny" ? "Denied" : "Cancelled";
        await this.resolve("ask", p.ask, `${word}${p.by ? ` from ${surfaceLabel(p.by)}` : ""}.`);
        return;
      }
      case "gate.held": {
        if (!p.id || this.itemRow("gate", p.id)) return;
        // The content is not in the event, by design; read it from the Gate for the post.
        const g = await this.call("gate.get", { id: p.id });
        const item = g && g.data ? { ...p, ...g.data } : p;
        // The words Send will send: a revision made before this post existed, else the draft.
        const draft = item.final ?? item.draft ?? item.content ?? null;
        let channel, root = null;
        if (thread) { const t = await this.ensureThread(thread, project); channel = t.channel_id; root = t.root_id; }
        else channel = (await this.channelFor(project)).channel_id;
        const post = await this.send(heldPost(item, draft, { channel, root, ...this.h }));
        this.item("gate", p.id, post, channel, root);
        return;
      }
      case "gate.revised": {
        // The post must show what Send will send, so a revision from any surface patches it.
        const it = this.itemRow("gate", p.id);
        if (!it || it.state !== "open") return;
        const g = await this.call("gate.get", { id: p.id });
        if (!g || !g.data) return;
        const patch = heldPatch(g.data, g.data.final ?? g.data.draft, this.h);
        await this.mm.patch(it.post_id, patch);
        this.db.prepare("UPDATE chat_items SET message = ? WHERE kind = 'gate' AND item_id = ?").run(patch.message, p.id);
        return;
      }
      case "gate.released":
        await this.resolve("gate", p.id, `Sent${p.edited ? ", with your edits" : ""}${p.by ? ` from ${surfaceLabel(p.by)}` : ""}.`);
        return;
      case "gate.rejected":
        await this.resolve("gate", p.id, `Discarded${p.by ? ` from ${surfaceLabel(p.by)}` : ""}. Nothing was sent.`);
        return;
      case "gate.failed": {
        const it = this.itemRow("gate", p.id);
        if (it) await this.send(textPost({ channel: it.channel_id, root: it.root_id || it.post_id,
          message: `Sending failed: ${cut(p.error || "no reason given", 400)}. It is still held; press Send to try again.` }));
        return;
      }
    }
  }

  /** @param {"ask"|"gate"} kind @param {string} id @param {any} post @param {string} channel @param {string|null} root */
  item(kind, id, post, channel, root) {
    this.db.prepare("INSERT OR REPLACE INTO chat_items (kind, item_id, post_id, channel_id, root_id, message, state, at) VALUES (?,?,?,?,?,?, 'open', ?)")
      .run(kind, id, post.id, channel, root, String(post.message || ""), this.now());
  }

  /** @param {string} kind @param {string} id */
  itemRow(kind, id) { return /** @type {any} */ (this.db.prepare("SELECT * FROM chat_items WHERE kind = ? AND item_id = ?").get(kind, id)) || null; }

  /** Patch a question or held item to its outcome, buttons removed. @param {string} kind @param {string} id @param {string} outcome */
  async resolve(kind, id, outcome) {
    const it = id && this.itemRow(kind, id);
    if (!it || it.state !== "open") return;
    await this.mm.patch(it.post_id, resolvedPatch(it.message, outcome));
    this.db.prepare("UPDATE chat_items SET state = 'resolved' WHERE kind = ? AND item_id = ?").run(kind, id);
  }

  // ---- in: posts to threads --------------------------------------------------------------

  /** Read every mapped channel since its cursor. */
  poll() { return this.enqueue(() => this.pollNow()); }

  async pollNow() {
    if (!this.ownerId) return 0;
    let handled = 0;
    const rows = /** @type {any[]} */ (this.db.prepare("SELECT * FROM chat_channels").all());
    for (const row of rows) {
      const posts = await this.mm.postsSince(row.channel_id, row.since);
      let newest = row.since;
      for (const p of posts) {
        newest = Math.max(newest, Number(p.update_at || p.create_at || 0));
        const fresh = this.db.prepare("INSERT OR IGNORE INTO chat_posts (post_id, direction, at) VALUES (?, 'in', ?)").run(p.id, this.now());
        if (!Number(fresh.changes)) continue;
        if (p.user_id !== this.ownerId || p.user_id === this.botId || p.type) continue;
        await this.inbound(row, p);
        handled++;
      }
      if (newest !== row.since) this.db.prepare("UPDATE chat_channels SET since = ? WHERE channel_id = ?").run(newest, row.channel_id);
    }
    return handled;
  }

  /** One post from the owner. @param {any} row the channel @param {any} p the post */
  async inbound(row, p) {
    const text = String(p.message || "").trim();
    if (!text) return;
    if (p.root_id) {
      const t = /** @type {any} */ (this.db.prepare("SELECT * FROM chat_threads WHERE root_id = ?").get(p.root_id));
      if (!t) return; // a reply under a held item or someone's own thread: not a session
      await this.typeInto(t, text);
      return;
    }
    await this.start(row, text, p.id);
  }

  /**
   * The owner typed in a session's thread. Typing is taking the keyboard (floor rule 4 keeps one
   * screen typing at a time), so the lease moves to Chat first and the thread says who had it.
   * @param {any} t @param {string} text
   */
  async typeInto(t, text) {
    const lease = await this.call("threads.lease", { thread: t.thread, surface: this.surface });
    if (lease && lease.error && lease.error.code === "no_such_tool") { await this.reply(t, "_Sessions are not running on this box, so this was not sent._"); return; }
    const r = await this.call("threads.send", { thread: t.thread, text, surface: this.surface });
    if (r && r.error) await this.reply(t, `_Not sent: ${cut(r.error.message, 300)}_`);
    else if (r && r.data && r.data.sent === false) await this.reply(t, `_Not sent: ${surfaceLabel(r.data.holder)} has the keyboard._`);
  }

  /**
   * A new session in a channel's project, mapped to `root` (the owner's post, or one we make).
   * @param {any} row @param {string} prompt @param {string|null} root
   */
  async start(row, prompt, root) {
    if (!root) root = (await this.send(textPost({ channel: row.channel_id, message: `**New session**\n> ${cut(prompt, 2000).split("\n").join("\n> ")}` }))).id;
    const r = await this.call("threads.start", { ...(row.project ? { project: row.project } : {}), prompt, surface: this.surface });
    const id = r && r.data && (r.data.id || r.data.thread);
    if (!id) {
      await this.send(textPost({ channel: row.channel_id, root, message: `_Could not start a session: ${cut(r && r.error ? r.error.message : "no thread came back", 300)}_` }));
      return null;
    }
    // Before the queued thread.started runs, so it finds the thread mapped and makes no second root.
    this.mapThread(String(id), row.channel_id, String(root));
    return String(id);
  }

  // ---- presses and the slash command --------------------------------------------

  /**
   * A button press, as Mattermost posts it: {user_id, post_id, trigger_id, context}.
   * @param {any} body @returns {Promise<{ status?: number, body: any }>}
   */
  async action(body) {
    const c = (body && body.context) || {};
    if (!same(c.s, this.secret)) return { status: 403, body: { error: "not a Vyre button" } };
    if (!this.ownerId || body.user_id !== this.ownerId) return { body: { ephemeral_text: "Only the owner of this Vyre can answer this." } };
    const id = String(c.id || "");
    return this.enqueue(async () => {
      if (c.kind === "ask" && (c.action === "allow" || c.action === "deny")) {
        const r = await this.call("threads.answer", { ask: id, decision: c.action, surface: this.surface });
        return { body: r && r.error ? { ephemeral_text: `Not answered: ${r.error.message}` } : {} };
      }
      if (c.kind === "gate" && c.action === "send") return { body: await this.approve(id) };
      if (c.kind === "gate" && c.action === "discard") return { body: await this.reject(id) };
      return { body: { ephemeral_text: "That button does nothing here." } };
    });
  }

  /** @param {string} id */
  async approve(id) {
    const r = await this.call("gate.approve", { id, by: "chat" });
    if (!r || r.error) return { ephemeral_text: `Not sent: ${r && r.error ? r.error.message : "the Gate is not running"}` };
    if (r.data && r.data.state === "failed") return { ephemeral_text: `Sending failed: ${cut(r.data.error || "", 300)}` };
    return {};
  }

  /** @param {string} id */
  async reject(id) {
    const r = await this.call("gate.reject", { id, by: "chat" });
    return r && r.error ? { ephemeral_text: `Not discarded: ${r.error.message}` } : {};
  }

  /**
   * `/vyre ...`, as Mattermost posts it (form fields: token, user_id, channel_id, text).
   * @param {Record<string, string>} form @returns {Promise<{ status?: number, body: any }>}
   */
  async slash(form) {
    const want = await this.slashToken().catch(() => "");
    if (!same(form.token, want)) return { status: 401, body: { response_type: "ephemeral", text: "This slash command is not configured for this Vyre." } };
    const say = text => ({ body: { response_type: "ephemeral", text } });
    if (!this.ownerId || form.user_id !== this.ownerId) return say("Only the owner of this Vyre can use /vyre.");
    // verb, then an id, then the rest with its line breaks kept: `/vyre body <id>` takes a letter.
    const m = /^(\S*)\s*([\s\S]*)$/.exec(String(form.text || "").trim()) || [];
    const verb = m[1] || "", arg = (m[2] || "").trim();
    const m2 = /^(\S+)\s+([\s\S]+)$/.exec(arg);
    return this.enqueue(async () => {
      if (verb === "held") {
        const r = await this.call("gate.held", {});
        if (!r || r.error) return say(`The Gate is not answering: ${r && r.error ? r.error.message : "not running"}`);
        const items = Array.isArray(r.data) ? r.data : [];
        if (!items.length) return say("Nothing is held.");
        return say(items.map(i => `\`${i.id}\` ${i.kind} via ${i.via} to ${Array.isArray(i.to) ? i.to.join(", ") : i.to}${i.summary ? `: ${cut(i.summary, 120)}` : ""}`).join("\n"));
      }
      if (verb === "send" && arg) { const o = await this.approve(arg); return say(o.ephemeral_text || "Sent."); }
      if ((verb === "body" || verb === "subject") && m2) {
        const r = await this.call("gate.revise", { id: m2[1], edited: { [verb]: m2[2].trim() }, by: "chat" });
        if (!r || r.error) return say(`Not changed: ${r && r.error ? r.error.message : "the Gate is not running"}`);
        return say(`Changed the ${verb}. The held post shows the new words; Send sends them.`);
      }
      if (verb === "discard" && arg) { const o = await this.reject(arg); return say(o.ephemeral_text || "Discarded. Nothing was sent."); }
      if (verb === "new" && arg) {
        const row = /** @type {any} */ (this.db.prepare("SELECT * FROM chat_channels WHERE channel_id = ?").get(String(form.channel_id || "")))
          || await this.channelFor(null);
        const id = await this.start(row, arg, null);
        return say(id ? "Started. The session has its own thread in this channel." : "Could not start a session; the reason is in the channel.");
      }
      return say("/vyre held · /vyre send <id> · /vyre discard <id> · /vyre body <id> <new text> · /vyre subject <id> <text> · /vyre new <what to do>");
    });
  }
}
