// @ts-check
// stream: the session stream as a module (ADR 0052). It listens to the switchboard's thread.* and
// ask.* events, maps them to frames (adapter.js), keeps one gapless log per session (log.js) in
// memory and in the module's own table, and serves them on the WebSocket
// /v1/streams/stream/session. One tool, stream.open, hands the screen a one-use ticket (15 s) and
// the log's head and floor, the same shape as term.open and Glass. Nothing polls: frames are sent
// the moment an event lands.
//
// The ticket is the whole authority, as for term: it is spent before the handshake completes. It is
// made only after access.js says the caller may read the session, and it is bound to that caller: the
// upgrade must come from the same caller (and device, where the router names one) or it is refused.

import crypto from "node:crypto";
import { Logs } from "./log.js";
import { createAdapter, pipe } from "./adapter.js";
import { serveWS } from "./server.js";
import { createGroups } from "./group.js";
import { createAccess } from "./access.js";

export { SessionLog, Logs } from "./log.js";
export { serve, serveSSE, serveWS, HEARTBEAT_MS } from "./server.js";
export { connect, wsDuplex, sseDuplex, trim } from "./client.js";
export { createAdapter, pipe } from "./adapter.js";
export * from "./protocol.js";
export { whoAnswers, mentionedIn } from "./routing.js";
export { createDoorAdapter, pipeDoor, drainDoor } from "./door-adapter.js";
export { createGroups } from "./group.js";
export { render, forViewer, forViewerAsync, hiddenFrame, resolveRefs, hasRefs, mayView, assertAskerCanRead, canRead, placeholder, cutData } from "./viewer.js";
export { createPresence, presenceFor, PRESENCE_MS } from "./presence.js";
export { createReadMarkers } from "./readmarks.js";

const str = { type: "string" };
const int = { type: "integer" };
const obj = (/** @type {any} */ properties, required = []) => ({ type: "object", properties, required });
const PEOPLE = ["cli", "local", "deck", "capsule"];
const EVENTS = /^(thread\.|ask\.|term\.command$)/;

/** @param {import("node:net").Socket} socket @param {number} status @param {string} reason */
const reject = (socket, status, reason) => { try { socket.end(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\n\r\n`); } catch {} };

/** @type {{ start(ctx: any): Promise<any> }} */
export default {
  async start(ctx) {
    const cfg = (ctx.config && ctx.config.stream) || {};
    const ticketMs = Number(cfg.ticketMs ?? 15_000);
    const now = () => Date.now();
    // A thread session's assistant text and any shell output stay for stream.retainHours (24 by default); a group chat's words stay (log.js expire).
    const logs = new Logs({ db: ctx.store && ctx.store.db, maxFrames: cfg.maxFrames, maxBytes: cfg.maxBytes, ...(cfg.retainHours !== undefined ? { retainMs: Number(cfg.retainHours) * 3600_000 } : {}) });
    /** @type {Map<string, ReturnType<typeof createAdapter>>} */
    const adapters = new Map();
    /** @type {Map<string, { session: string, expires: number, from: number|null, person: string, caller: string, device: string, viewer: import("./viewer.js").Viewer & { id: string, roles: string[] } }>} */
    const tickets = new Map();
    const sockets = new Set();

    /** Pipe one event into its session's log, through that session's adapter. @param {any} e */
    const feed = e => {
      let ad = adapters.get(e.thread);
      if (!ad) { ad = createAdapter(); adapters.set(e.thread, ad); }
      try { pipe(logs.get(e.thread), ad, e); } catch (err) { ctx.log(`stream: ${e.type} for ${e.thread}: ${/** @type {Error} */ (err).message}`); }
      if (e.type === "thread.stopped") adapters.delete(e.thread);
    };

    // A session whose log is empty (it began before this vyred, or before the stream module) is
    // seeded from the switchboard's stored events, oldest first, so a screen that opens it sees its
    // history. Live events for it wait in `held` until the seed is in, then go in after it (an id
    // already seeded is skipped), so the cursor stays gapless and nothing is out of order.
    /** @type {Set<string>} */ const seen = new Set();
    /** @type {Map<string, Promise<void>>} */ const seeding = new Map();
    /** @type {Map<string, any[]>} */ const held = new Map();
    /** @param {string} session @param {any[]} [first] */
    const seed = (session, first = []) => {
      const running = seeding.get(session);
      if (running) return running;
      held.set(session, first);
      const p = (async () => {
        let events = [];
        try {
          const r = await ctx.call("threads.get", { thread: session, limit: 1000 });
          events = r && r.data && Array.isArray(r.data.events) ? r.data.events : [];
        } catch {}
        let top = 0;
        for (const ev of events) {
          top = Math.max(top, Number(ev.id) || 0);
          if (EVENTS.test(ev.type)) feed({ ...ev, thread: session });
        }
        for (const e of held.get(session) || []) if (!(Number(e.id) <= top)) feed(e);
      })().finally(() => { held.delete(session); seeding.delete(session); });
      seeding.set(session, p);
      return p;
    };

    /** Where a cited field's value comes from, per viewer (see resolverFor). Set by whoever owns the records (platform); null reads the kernel's records. @type {null | ((o: { record: string, field: string, viewer: { id: string, roles: string[] } }) => Promise<any>)} */
    let fieldSource = null;
    /**
     * What a viewer's own authority yields for a cited field. The viewer's chain (kernel on) is the caller's own, never the module's: records.get under it hides what that
     * person may not read; the server then draws the field (value or chip) per viewer. Never throws: anything unresolved is a chip.
     * @param {{ id: string, roles: string[] }} who @param {any} chain
     */
    const resolverFor = (who, chain) => async (/** @type {string} */ record, /** @type {string} */ field) => {
      if (fieldSource) return fieldSource({ record, field, viewer: { id: who.id, roles: [...who.roles] } });
      const k = ctx.kernel;
      const m = /^vyre:\/\/[^/]+\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.:-]+)$/.exec(record);
      if (!chain || !k || !k.records || typeof k.records.get !== "function" || !m) return null;
      const r = await k.records.get(chain, m[1], m[2]);
      const data = r && typeof r === "object" ? (r.data ?? r) : null;
      if (!data || typeof data !== "object" || !(field in data)) return null;
      // Draw what the kernel returned for this viewer: a value, or (sealed) the sealed shape, which the viewer module turns into a chip with no ref. A field the viewer may not read is
      // not in `data` at all. No roles of ours here: the kernel already decided.
      const v = data[field];
      const kind = v && typeof v === "object" ? (typeof v.sealed === "string" ? "sealed" : typeof v.amount === "number" && typeof v.currency === "string" ? "money" : "object") : typeof v === "number" ? "number" : typeof v === "boolean" ? "boolean" : "text";
      return { kind, value: v };
    };

    const groups = ctx.store && ctx.store.db ? createGroups({ ctx, logs, db: ctx.store.db }) : null;
    const access = createAccess({ ctx, groups, logs });

    const off = ctx.events.on("*", (/** @type {any} */ e) => {
      if (!e || !e.thread || !EVENTS.test(e.type)) return;
      if (groups) groups.onEvent(e);
      const waiting = held.get(e.thread);
      if (waiting) { waiting.push(e); return; }
      if (!seen.has(e.thread)) {
        seen.add(e.thread);
        if (logs.get(e.thread).head === 0 && e.type !== "thread.started") { void seed(e.thread, [e]); return; }
      }
      feed(e);
    });

    ctx.tool("stream.open", {
      description: "A one-use ticket (15 s) for the session stream at path, resuming after cursor from (0 for everything the log holds). Also the log's head and floor: a from below floor will be sent a reset.",
      input: obj({ session: str, from: int, as: str }, ["session"]),
      callers: PEOPLE,
      run: async (/** @type {any} */ i, /** @type {any} */ meta) => {
        const session = String(i.session || "");
        if (!/^[A-Za-z0-9_.:-]{1,128}$/.test(session)) { const e = /** @type {any} */ (new Error("session must be a thread id")); e.code = "bad_input"; throw e; }
        // Who may read it comes first: nothing below runs, and no log or set entry is made, for a session the caller may not read.
        const { viewer: who0, chain, chat: kchat } = await access.read(session, meta, i);
        // A person who opens a chat after a restart gives the assistants answering them a session again; the group's list follows the kernel's.
        if (kchat && groups) await groups.mirror(session, { people: [...kchat.people], assistants: [...(kchat.assistants || [])] }, meta, who0.id, chain);
        // A chat of the kernel's: the viewer receives a reply only if they were in the chat at its membership version (asked of the reply port, never decided here), and sees the chat from their own join.
        const who = { ...who0, resolve: resolverFor(who0, chain), ...(kchat && groups && groups.known(session) ? groups.viewerFor(session, who0.id, chain) : {}) };
        if (!seen.has(session)) { seen.add(session); if (logs.get(session).head === 0) await seed(session); }
        else if (seeding.has(session)) await seeding.get(session);
        for (const [k, v] of tickets) if (v.expires <= now()) tickets.delete(k);
        const ticket = crypto.randomBytes(24).toString("base64url");
        const from = Number.isInteger(i.from) && i.from >= 0 ? i.from : null;
        const viewer = who.id;
        const peer = meta && meta.peer;
        const device = peer && (peer.stableId || peer.node) ? String(peer.stableId || peer.node) : "";
        tickets.set(ticket, { session, expires: now() + ticketMs, from, person: viewer, caller: String((meta && meta.caller) || ""), device, viewer: who });
        const log = logs.get(session);
        return { session, ticket, viewer, path: `/v1/streams/stream/session?ticket=${encodeURIComponent(ticket)}${from === null ? "" : `&from=${from}`}`, head: log.head, floor: log.floor };
      },
    });

    ctx.upgrade("session", (/** @type {any} */ req, /** @type {import("node:net").Socket} */ socket, /** @type {Buffer} */ head, /** @type {any} */ info) => {
      try {
        const url = (info && info.url) || new URL(req.url || "/", "http://vyred");
        const tk = url.searchParams.get("ticket") || "";
        const held = tickets.get(tk);
        tickets.delete(tk);
        if (!held || held.expires <= now()) { reject(socket, 403, "Forbidden"); return; }
        // Bound to who asked: a ticket from a URL, a proxy log or a screenshot is no use to another caller or device.
        if (String((info && info.caller) || "") !== held.caller || (info && info.peer && (info.peer.stableId || info.peer.node) && String(info.peer.stableId || info.peer.node) !== held.device)) { reject(socket, 403, "Forbidden"); return; }
        const q = url.searchParams.get("from");
        const n = q === null || q === "" ? NaN : Number(q);
        const from = Number.isInteger(n) && n >= 0 ? n : held.from ?? undefined;
        sockets.add(socket);
        socket.on("close", () => sockets.delete(socket));
        serveWS(logs.get(held.session), req, socket, head, { viewer: held.viewer, ...(from === undefined ? {} : { from }), ...(groups ? { also: send => groups.hear(held.person, f => { if (f.session === held.session) send(f); }) } : {}) });
      } catch { reject(socket, 400, "Bad Request"); }
    });

    /**
     * With the kernel on and a session token on the call, a chat is the kernel's and so is its list of people (one store): the caller must be in it (chats.read), the
     * group's people mirror it, and a call cannot add people or assistants the kernel does not list (they are added with the kernel's chats.change, a person in the chat).
     * @param {any} i @param {any} meta
     */
    const kernelGate = async (i, meta) => {
      const session = String((i && i.session) || "");
      if (!groups || !/^[A-Za-z0-9_.:-]{1,128}$/.test(session)) return;
      const kernelOn = Boolean(ctx.kernel && ctx.kernel.chats);
      const kc = await access.chat(session, meta);
      // The kernel is on: a chat is the kernel's, and a call that carries no session of its own cannot speak in one (the 0.2 group path is closed).
      if (!kc) { if (kernelOn) throw Object.assign(new Error("a call needs the person's own session"), { code: "person_session_required" }); return; }
      if (!kc.chat) throw Object.assign(new Error("no such session"), { code: "not_found" });
      // Nobody joins by a call: people and assistants are the kernel's list, changed by a person in the chat acting directly (the kernel's chats.change), never by a send.
      if ((Array.isArray(i.people) && i.people.length) || (Array.isArray(i.assistants) && i.assistants.length)) throw Object.assign(new Error("people and assistants of a chat are added with the kernel's chat change, by a person in it"), { code: "bad_input" });
      await groups.mirror(session, { people: [...kc.chat.people], assistants: [...(kc.chat.assistants || [])] }, meta, `person:${kc.person}`, kc.chain);
    };

    const tool = (/** @type {string} */ name, /** @type {string} */ description, /** @type {any} */ input, /** @type {string} */ method) => ctx.tool(name, {
      description, input, callers: PEOPLE,
      run: async (/** @type {any} */ i, /** @type {any} */ meta) => {
        if (!groups) throw Object.assign(new Error("the stream has no store here"), { code: "unavailable" });
        await kernelGate(i, meta);
        return /** @type {any} */ (groups)[method](i, meta);
      },
    });
    const bool = { type: "boolean" };
    tool("stream.send", "Say something in a group chat (a stream session with several people and assistants). The words are the caller's, appended first; then routing decides who answers (an @mention, the default assistant when no person is talking to a person, or the assistants named in to) and each gets the words in its own thread; its replies appear in the group with that assistant as author and the caller as acts_for. Two or more answering assistants make a fan-out set. People and assistants join by being named in people and assistants (an assistant needs a cwd to work in). Retry with the same message id and nothing is said twice. A private message is sent with enc { alg, kid, ct } and no text: an opaque ciphertext made on the person's device, stored and relayed as it is, never parsed, routed to no assistant and kept out of search, memory and export.",
      obj({ session: str, text: str, enc: obj({ alg: str, kid: str, ct: str }, ["alg", "kid", "ct"]), message: str, mentions: { type: "array", items: str }, to: { type: "array", items: str }, people: { type: "array", items: {} }, assistants: { type: "array", items: {} }, default: str, cwd: str, group: str, surface: str, as: str, name: str }, ["session"]), "send");
    tool("stream.react", "React to a message in a group chat with an emoji (on: false takes it back).", obj({ session: str, message: str, emoji: str, on: bool, as: str }, ["session", "message", "emoji"]), "react");
    tool("stream.pin", "Pin a message in a group chat (on: false unpins it).", obj({ session: str, message: str, on: bool, as: str }, ["session", "message"]), "pin");
    tool("stream.keep", "Keep one answer of a fan-out set; the others stay, quieter.", obj({ session: str, group: str, keep: str, as: str }, ["session", "group", "keep"]), "keep");
    tool("stream.mark-read", "Move the caller's read marker in a session forward to a cursor. The caller's other open connections hear it; nobody else does.", obj({ session: str, upto: int, as: str }, ["session", "upto"]), "markRead");

    if (groups) await groups.start();

    return {
      logs,
      groups,
      /** Where a cited field's value comes from for a viewer: ({ record, field, viewer }) => { label?, kind?, value, read_roles?, seal? } | null. @param {typeof fieldSource} fn */
      setFieldSource(fn) { fieldSource = typeof fn === "function" ? fn : null; },
      async stop() {
        off();
        if (groups) groups.stop();
        for (const s of sockets) { try { s.destroy(); } catch {} }
        sockets.clear(); tickets.clear();
        logs.close();
      },
    };
  },
};
