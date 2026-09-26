// @ts-check
// chat — Mattermost as a surface over the same real Claude Code sessions (docs/SPEC.md section 9).
//
// Chat imitates nothing. A post in a session's thread types into that session through the
// switchboard, exactly as the terminal does, and what the session says comes back as replies.
// Questions and held drafts are posts with buttons, because on the phone that is all that works.
//
// It depends on nothing at start. The switchboard, the Gate and Projects are reached through
// ctx.call, and each may be missing: Chat then says so in the thread instead of failing. An
// unconfigured Chat starts idle and chat.status names what is missing; Mattermost being down
// is a `failed` state that retries, never a failed vyred.
//
// config.json:
//   "chat": { "url": "http://mattermost:8065", "team": "vyre", "owner": "alex",
//             "listen": { "host": "0.0.0.0", "port": 8766 }, "callback": "http://vyred:8766", "poll_ms": 2000 }
// Vault: chat-bot-token (the bot's access token) and chat-slash-token (the /vyre command's
// token), both granted to chat. See SETUP.md.

import { client } from "./mattermost.js";
import { Bridge, MIGRATIONS } from "./bridge.js";
import { listen } from "./listener.js";

const RETRY_MS = 30_000;

/** @type {{ start(ctx: any): Promise<{ stop(): Promise<void> }> }} */
export default {
  async start(ctx) {
    ctx.store.migrate(MIGRATIONS);
    const db = ctx.store.db;
    const cfg = (ctx.config && ctx.config.chat) || {};
    const missing = ["url", "team", "owner"].filter(k => !cfg[k]);

    /** @type {{ state: "idle"|"connecting"|"running"|"failed", error: string|null, listening: string|null }} */
    const s = { state: missing.length ? "idle" : "connecting", error: null, listening: null };
    /** @type {Bridge|null} */
    let bridge = null;
    let listener = null, timer = null, off = null, lastTry = 0;

    const connect = async () => {
      if (!bridge) return;
      lastTry = Date.now();
      try { await bridge.connect(); s.state = "running"; s.error = null; ctx.log(`chat connected to ${cfg.url}`); }
      catch (e) { s.state = "failed"; s.error = /** @type {Error} */ (e).message; ctx.log(`chat could not connect: ${s.error}`); }
    };

    if (!missing.length) {
      const l = cfg.listen || {};
      listener = await listen({
        host: l.host || "127.0.0.1", port: Number(l.port ?? 8766), log: ctx.log,
        handlers: {
          action: b => (bridge ? bridge.action(b) : Promise.resolve({ status: 503, body: {} })),
          dialog: b => (bridge ? bridge.dialog(b) : Promise.resolve({ status: 503, body: {} })),
          slash: f => (bridge ? bridge.slash(f) : Promise.resolve({ status: 503, body: {} })),
        },
      });
      s.listening = listener.url;
      const mm = client({ base: cfg.url, getToken: () => ctx.vault.fetch("chat-bot-token") });
      bridge = new Bridge({
        db, mm, log: ctx.log, team: String(cfg.team), owner: String(cfg.owner), hook: String(cfg.callback || listener.url),
        call: (tool, input) => ctx.call(tool, input),
        slashToken: () => ctx.vault.fetch("chat-slash-token"),
      });
      off = ctx.events.on("*", e => bridge && bridge.onEvent(e));
      await connect();
      timer = setInterval(() => {
        if (!bridge) return;
        if (s.state === "running") bridge.poll().catch(() => {});
        else if (Date.now() - lastTry > RETRY_MS) connect();
      }, Math.max(250, Number(cfg.poll_ms || 2000)));
      timer.unref();
    }

    const count = t => Number(/** @type {any} */ (db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get()).n);
    const status = () => ({
      state: s.state, ...(missing.length ? { missing: missing.map(k => `chat.${k} in config.json`) } : {}), error: s.error,
      url: cfg.url || null, team: cfg.team || null, owner: cfg.owner || null, listening: s.listening,
      channels: count("chat_channels"), threads: count("chat_threads"),
      open: Number(/** @type {any} */ (db.prepare("SELECT COUNT(*) AS n FROM chat_items WHERE state = 'open'").get()).n),
    });

    ctx.tool("chat.status", {
      description: "Whether Chat is connected to Mattermost, what is missing if not, and how many channels, threads and open questions it mirrors.",
      input: { type: "object", properties: {} },
      run: async () => status(),
    });

    ctx.tool("chat.sync", {
      description: "Connect if needed, make a channel for every project, read new posts now and wait until everything queued has run.",
      input: { type: "object", properties: {} },
      run: async () => {
        if (!bridge) return status();
        if (s.state !== "running") await connect();
        if (s.state === "running") {
          const b = bridge;
          await b.enqueue(async () => {
            const r = await ctx.call("projects.list", {});
            for (const p of r && Array.isArray(r.data) ? r.data : []) if (p && p.slug) await b.channelFor(String(p.slug));
          }).catch(() => {});
          await b.poll().catch(() => {});
          await b.idle();
        }
        return status();
      },
    });

    return {
      async stop() {
        if (timer) clearInterval(timer);
        if (off) off();
        if (bridge) await bridge.idle();
        bridge = null;
        if (listener) await listener.close();
      },
    };
  },
};
