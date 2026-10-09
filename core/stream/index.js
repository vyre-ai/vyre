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
import { refuseKey } from "../../lib/secure-paste.js";
import { Logs } from "./log.js";
import { createAdapter, pipe } from "./adapter.js";
import { serve, serveWS } from "./server.js";
import { createGroups } from "./group.js";
import { createActivity } from "./activity.js";
import { createAccess } from "./access.js";
import { newPrefixedId } from "../../lib/id.js";

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
    // A hand-off to a teammate, and the teammate's steps, in the asker's conversation (team/0.3/IFACE-activity.md).
    const activity = createActivity({ ctx, logs, groups });
    const offSummon = ctx.events.on("*", (/** @type {any} */ e) => { if (e && typeof e.type === "string" && e.type.startsWith("summon.")) activity.onSummon(e); });

    const off = ctx.events.on("*", (/** @type {any} */ e) => {
      if (!e || !e.thread || !EVENTS.test(e.type)) return;
      if (groups) groups.onEvent(e);
      activity.onThread(e);
      const waiting = held.get(e.thread);
      if (waiting) { waiting.push(e); return; }
      if (!seen.has(e.thread)) {
        seen.add(e.thread);
        if (logs.get(e.thread).head === 0 && e.type !== "thread.started") { void seed(e.thread, [e]); return; }
      }
      feed(e);
    });

    /**
     * Who may read a session and the viewer that draws it: the one authorisation both ways of opening a stream use (the WebSocket ticket and the peer wire), so a device gets exactly what a ticket would.
     * Nothing below runs, and no log or set entry is made, for a session the caller may not read.
     * @param {any} i @param {any} meta
     */
    const prepare = async (i, meta) => {
      const asked = String(i.chat || "");
      if (!/^[A-Za-z0-9_.:-]{1,128}$/.test(asked)) { const e = /** @type {any} */ (new Error("chat must be a chat id")); e.code = "bad_input"; throw e; }
      const { viewer: who0, chain, chat: kchat } = await access.read(asked, meta, i);
      // A person who opens a chat after a restart gives the assistants answering them a session again; the group's list follows the kernel's.
      if (kchat && groups) await groups.mirror(asked, { people: [...kchat.people], assistants: [...(kchat.assistants || [])] }, meta, who0.id, chain);
      // One Chat: a chat nobody has spoken in through the stream (a run the CLI, a terminal or a Flow started, which is the only run in it) is that run's own log, so the one chat id opens it. The person was
      // already checked against the chat above; the run's log is then served as the chat's.
      let session = asked;
      if (kchat && !(groups && groups.bound(asked))) {
        const runs = await ctx.call("threads.of-chat", { chat: asked }).then((/** @type {any} */ r) => (r && r.data && r.data.runs) || []).catch(() => []);
        if (runs.length === 1) session = String(runs[0].thread);
      }
      // A chat of the kernel's: the viewer receives a reply only if they were in the chat at its membership version (asked of the reply port, never decided here), and sees the chat from their own join.
      const who = { ...who0, resolve: resolverFor(who0, chain), ...(kchat && groups && groups.known(asked) ? groups.viewerFor(asked, who0.id, chain) : {}) };
      if (!seen.has(session)) { seen.add(session); if (logs.get(session).head === 0) await seed(session); }
      else if (seeding.has(session)) await seeding.get(session);
      const from = Number.isInteger(i.from) && i.from >= 0 ? i.from : null;
      return { chat: asked, session, who, from };
    };

    ctx.tool("stream.open", {
      description: "A one-use ticket (15 s) for a chat's stream at path, resuming after cursor from (0 for everything the log holds). Also the log's head and floor: a from below floor will be sent a reset.",
      input: obj({ chat: str, from: int, as: str }, ["chat"]),
      callers: PEOPLE,
      run: async (/** @type {any} */ i, /** @type {any} */ meta) => {
        const { chat, session, who, from } = await prepare(i, meta);
        for (const [k, v] of tickets) if (v.expires <= now()) tickets.delete(k);
        const ticket = crypto.randomBytes(24).toString("base64url");
        const viewer = who.id;
        const peer = meta && meta.peer;
        const device = peer && (peer.stableId || peer.node) ? String(peer.stableId || peer.node) : "";
        tickets.set(ticket, { session, expires: now() + ticketMs, from, person: viewer, caller: String((meta && meta.caller) || ""), device, viewer: who });
        const log = logs.get(session);
        return { chat, session, ticket, viewer, path: `/v1/streams/stream/session?ticket=${encodeURIComponent(ticket)}${from === null ? "" : `&from=${from}`}`, head: log.head, floor: log.floor };
      },
    });

    // The same stream over the Wink peer wire (a paired phone or browser has no WebSocket to its server): the session's frames, drawn for THIS viewer exactly as the socket would draw them, go to the
    // door's stream as messages tagged with the stream's id. Authorised by the person in the call's own chain (prepare), the door ends it when the device's paired session ends, and `from` resumes.
    ctx.tool("stream.open-peer", {
      description: "Open the session's stream over the Wink peer wire (for a paired device): answers { stream, session, viewer, head, floor }; the frames then arrive as peer stream messages for `stream`, resuming after cursor from. Only over the peer wire.",
      input: obj({ chat: str, from: int, as: str }, ["chat"]),
      callers: PEOPLE,
      run: async (/** @type {any} */ i, /** @type {any} */ meta) => {
        if (!meta || !meta.peerStream || typeof meta.peerStream.open !== "function") throw Object.assign(new Error("this stream opens only over a paired device's peer wire"), { code: "bad_input" });
        const { chat, session, who, from } = await prepare(i, meta);
        const log = logs.get(session);
        const id = newPrefixedId("st");
        // PS-A: the viewer and chain were decided at open, but access can end while the stream runs (a grant revoked, the person out of the chat, the role changed). So no frame leaves until
        // access has been asked again, AFTER the frame was appended: frames wait in a queue, one re-check serves every frame queued while it ran (so a burst costs one ask, never one each),
        // a refusal ends the stream with `access_ended` and sends nothing more, and the roles the viewer is drawn with are the ones the re-check just read.
        const recheck = async () => {
          const r = await access.read(chat, meta, i);
          if (r.viewer.id !== who.id) throw new Error("the viewer changed");
          who.roles.splice(0, who.roles.length, ...r.viewer.roles);
        };
        meta.peerStream.open(id, ({ emit, end }) => {
          /** @type {(() => void)[]} */ const closers = [];
          /** @type {any[]} */ let queue = [];
          let pumping = false, gone = false, closing = false;
          const pump = async () => {
            if (pumping) return;
            pumping = true;
            try {
              while (queue.length && !gone) {
                const batch = queue; queue = [];
                try { await recheck(); } catch { gone = true; queue = []; end("access_ended"); return; }
                for (const f of batch) { if (gone) return; if (!emit(f)) { gone = true; queue = []; return; } }
              }
              // the serve asked to close (a reset frame is its last word): the frames queued before it go out first
              if (closing && !gone) end("done");
            } finally { pumping = false; if (queue.length && !gone) void pump(); }
          };
          const conn = { send: (/** @type {any} */ f) => { if (gone) throw new Error("the stream is closed"); queue.push(f); void pump(); }, onClose: (/** @type {() => void} */ cb) => { closers.push(cb); }, close: () => { closing = true; if (!pumping && !queue.length) end("done"); }, buffered: () => 0 };
          const h = serve(log, conn, { viewer: who, ...(from === null ? {} : { from }), ...(groups ? { also: (/** @type {any} */ send) => groups.hear(who.id, (/** @type {any} */ f) => { if (f.session === session) send(f); }) } : {}) });
          return () => { gone = true; queue = []; try { h.close(); } catch { /* closed */ } for (const c of closers.splice(0)) { try { c(); } catch { /* closed */ } } };
        });
        return { stream: id, chat, session, viewer: who.id, head: log.head, floor: log.floor };
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
      const session = String((i && i.chat) || "");
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
        if (method === "send") refuseKey(i.text); // appended to the chat first, so refused before it is written
        await kernelGate(i, meta);
        return /** @type {any} */ (groups)[method](i, meta);
      },
    });
    const bool = { type: "boolean" };
    tool("stream.send", "Say something in a group chat (a stream session with several people and assistants). The words are the caller's, appended first; then routing decides who answers (an @mention, the default assistant when no person is talking to a person, or the assistants named in to) and each gets the words in its own thread; its replies appear in the group with that assistant as author and the caller as acts_for. Two or more answering assistants make a fan-out set. People and assistants join by being named in people and assistants (an assistant needs a cwd to work in). Retry with the same message id and nothing is said twice. A private message is sent with enc { alg, kid, ct } and no text: an opaque ciphertext made on the person's device, stored and relayed as it is, never parsed, routed to no assistant and kept out of search, memory and export.",
      obj({ chat: str, text: str, enc: obj({ alg: str, kid: str, ct: str }, ["alg", "kid", "ct"]), message: str, mentions: { type: "array", items: str }, to: { type: "array", items: str }, people: { type: "array", items: {} }, assistants: { type: "array", items: {} }, default: str, cwd: str, group: str, surface: str, mode: { type: "string", enum: ["steer", "queue"] }, reply_to: str, tz: str, as: str, name: str }, ["chat"]), "send");
    tool("stream.second-opinion", "Ask another assistant or model of this chat for its own answer to the same question, on an answer you are reading: { chat, message, to }. The chat shows one short line from you; the other assistant is also given the question, the answer and the last turns from the chat itself. A model the chat does not have yet (codex, grok, provider/model) joins in the same step.", obj({ chat: str, message: str, to: str, surface: str, as: str }, ["chat", "message", "to"]), "secondOpinion");
    tool("stream.catchup", "What happened in a chat since you last read it: the last messages (who said what), the steps taken, questions still open, who joined or left. Plain facts from the chat's own log; nothing is summarised by a model.", obj({ chat: str, as: str }, ["chat"]), "catchup");
    tool("stream.typing", "Tell the chat you are typing (on: false: you stopped). Others see \"typing\" for a few seconds; nothing is kept.", obj({ chat: str, on: bool, as: str }, ["chat"]), "typing");
    tool("stream.react", "React to a message in a group chat with an emoji (on: false takes it back).", obj({ chat: str, message: str, emoji: str, on: bool, as: str }, ["chat", "message", "emoji"]), "react");
    tool("stream.pin", "Pin a message in a group chat (on: false unpins it).", obj({ chat: str, message: str, on: bool, as: str }, ["chat", "message"]), "pin");
    tool("stream.keep", "Keep one answer of a fan-out set; the others stay, quieter.", obj({ chat: str, group: str, keep: str, as: str }, ["chat", "group", "keep"]), "keep");
    tool("stream.mark-read", "Move the caller's read marker in a session forward to a cursor. The caller's other open connections hear it; nobody else does.", obj({ chat: str, upto: int, as: str }, ["chat", "upto"]), "markRead");

    // The chat's frames and who answers in it, to leave this device with the chat and be put back on the other (core/work/chat-upgrade.js). Modules only: the work module has checked the person is in the chat.
    const db = ctx.store && ctx.store.db;
    // the work module's door and no other: any other module, an added one included, could read every chat's frames or forge some
    const workOnly = (/** @type {any} */ m, /** @type {string} */ what) => { if (!m || m.caller !== "module:work" || m.firstParty === false) throw Object.assign(new Error(`${what} is the work module's alone`), { code: "denied" }); };
    ctx.tool("stream.export-chat", {
      description: "A chat's logged frames and member rows, for the chat upgrade. First-party modules only.", internal: true, callers: ["module"],
      input: obj({ chat: str }, ["chat"]),
      run: async (/** @type {any} */ i, /** @type {any} */ m) => {
        workOnly(m, "reading a chat's history");
        if (!db) return { frames: [], members: [] };
        try { logs.get(String(i.chat)).flush(); } catch { /* nothing logged yet */ }
        return { frames: db.prepare("SELECT cur, first, json FROM stream_frames WHERE session = ? ORDER BY cur").all(String(i.chat)), members: db.prepare("SELECT * FROM stream_groups_members WHERE grp = ?").all(String(i.chat)) };
      },
    });
    ctx.tool("stream.import-chat", {
      description: "Put a chat's frames and member rows back (the other end of the chat upgrade); with fresh: true, a chat that already has frames here is left as it is. First-party modules only.", internal: true, callers: ["module"],
      input: obj({ chat: str, frames: { type: "array" }, members: { type: "array" }, fresh: { type: "boolean" } }, ["chat", "frames", "members"]),
      run: async (/** @type {any} */ i, /** @type {any} */ m) => {
        workOnly(m, "putting a chat's history back");
        if (!db) throw Object.assign(new Error("the stream has no store here"), { code: "unavailable" });
        const chat = String(i.chat);
        logs.get(chat); // the log's table is made the first time any log is opened
        db.exec("CREATE TABLE IF NOT EXISTS stream_imports (chat TEXT PRIMARY KEY)");
        // the first chunk of a history: a chat that already has frames of its own here is left as it is (a later chunk is the same import carrying on)
        if (i.fresh === true && db.prepare("SELECT 1 FROM stream_frames WHERE session = ? LIMIT 1").get(chat)) return { frames: 0, members: 0, note: "this chat already has frames here" };
        // a later chunk only carries on an import this door started: frames are never written into a chat that was not put back from its first chunk
        if (i.fresh === true) db.prepare("INSERT OR IGNORE INTO stream_imports (chat) VALUES (?)").run(chat);
        else if (!db.prepare("SELECT 1 FROM stream_imports WHERE chat = ?").get(chat)) throw Object.assign(new Error("that chat's history was not started here"), { code: "denied" });
        let frames = 0, members = 0;
        for (const f of /** @type {any[]} */ (i.frames)) { if (f && Number.isInteger(f.cur) && typeof f.json === "string") { db.prepare("INSERT OR IGNORE INTO stream_frames (session, cur, first, json) VALUES (?,?,?,?)").run(chat, f.cur, Number.isInteger(f.first) ? f.first : f.cur, f.json); frames++; } }
        for (const m of /** @type {any[]} */ (i.members)) { if (m && m.grp === chat && typeof m.who === "string") { db.prepare("INSERT OR IGNORE INTO stream_groups_members (grp, who, thread, cwd, name, asker, answer, last_event, kind) VALUES (?,?,?,?,?,?,?,?,?)").run(chat, m.who, m.thread ?? null, m.cwd ?? null, m.name ?? null, m.asker ?? null, m.answer ?? null, Number(m.last_event) || 0, m.kind ?? null); members++; } }
        logs.drop(chat); // the next reader loads what was put back, not the empty log made above
        return { frames, members };
      },
    });

    if (groups) await groups.start();

    return {
      logs,
      groups,
      /** Where a cited field's value comes from for a viewer: ({ record, field, viewer }) => { label?, kind?, value, read_roles?, seal? } | null. @param {typeof fieldSource} fn */
      setFieldSource(fn) { fieldSource = typeof fn === "function" ? fn : null; },
      async stop() {
        off();
        offSummon();
        if (groups) groups.stop();
        for (const s of sockets) { try { s.destroy(); } catch {} }
        sockets.clear(); tickets.clear();
        logs.close();
      },
    };
  },
};
