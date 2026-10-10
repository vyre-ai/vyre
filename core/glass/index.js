// @ts-check
// glass: a remote computer a person can watch, take over, sign in on and browse (docs/adr/0005).
//
// This is the person-facing layer. Computers owns the machine (containers, the RFB relay, the
// keyboard and the shield's enforcement) and Glass reaches it through ctx.call only, never by
// importing its files, so every take-over passes the Rules like any other call. What is Glass's
// own: which targets can be opened, who is watching from where (glass_sessions), a person's
// take-over and hand-back, the note in the agent's thread afterwards, and the file browser with
// its guard (guard.js) and byte routes (streams.js).
//
// Targets: `computer:<agent>` (a screen, and files under /home/agent through computerd) and
// `box` (files only, under config glass.roots). The box has no screen.
//
// A person's surface ("deck:<device>", "phone:<device>", "glass:<device>", "capsule:<device>")
// is a claim only a person's screen makes. An agent caller may not name one, so no model can
// open, take or hand back a screen as if it were someone.
//
// No timers: tickets are swept when used, and sessions are rows.

import crypto from "node:crypto";
import path from "node:path";
import { BoxProvider } from "./providers/box.js";
import { ComputerProvider } from "./providers/computer.js";
import { Tickets, register } from "./streams.js";
import { checkRel, checkName, MAX_PREVIEW, DEFAULT_UPLOAD_MB, KEY_SNIFF, isKeyBytes } from "./guard.js";
import { INLINE, isText, mimeOf } from "./mime.js";
import { within } from "../../lib/within.js";
import { callerKind } from "../modules/index.js";

export const MIGRATIONS = [
  `CREATE TABLE glass_sessions (
     id TEXT PRIMARY KEY, target TEXT NOT NULL, surface TEXT NOT NULL, caller TEXT NOT NULL,
     opened INTEGER NOT NULL, closed INTEGER
   );
   CREATE INDEX glass_sessions_open ON glass_sessions (target, closed);`,
];

export const SURFACE = /^(deck|glass|phone|capsule):[A-Za-z0-9._-]{1,64}$/;
const COMPUTER = /^computer:([a-z][a-z0-9-]{0,40})$/;

const str = { type: "string" };
const obj = (properties, required = []) => ({ type: "object", properties, required });

/** Does this caller name an agent ("mcp:agent:kit", "harness:agent:kit")? */
const isAgent = caller => /(?:^|[\s:])agent:/.test(String(caller || ""));

/** "2 min 14 s", "40 s", "1 h 3 min": how long, for a person to read. */
export function duration(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${Math.floor(s / 60)} min${s % 60 ? ` ${s % 60} s` : ""}`;
  return `${Math.floor(s / 3600)} h${Math.floor((s % 3600) / 60) ? ` ${Math.floor((s % 3600) / 60)} min` : ""}`;
}

const FROM = { deck: "the Deck", phone: "phone", glass: "Glass", capsule: "the Capsule" };

/** How long glass.open waits for link.health before opening without it. */
const HEALTH_WAIT = 1500;

/** A link slow enough that the screen should send fewer frames: relayed, or over 150 ms. */
export const isSlow = link => Boolean(link && (link.path === "relay" || link.path === "peer-relay" || (typeof link.latencyMs === "number" && link.latencyMs > 150)));

/** @type {{ start(ctx: any): Promise<any> }} */
export default {
  async start(ctx) {
    ctx.store.migrate(MIGRATIONS);
    const db = ctx.store.db;
    const cfg = (ctx.config && ctx.config.glass) || {};
    const dirs = (Array.isArray(cfg.roots) ? cfg.roots : []).filter(d => {
      const ok = typeof d === "string" && path.isAbsolute(d);
      if (!ok) ctx.log(`glass.roots: "${d}" is not an absolute folder; skipped`);
      return ok;
    });
    const box = dirs.length ? new BoxProvider(dirs) : null;
    const capMb = Number(cfg.maxUploadMb) > 0 ? Number(cfg.maxUploadMb) : DEFAULT_UPLOAD_MB;
    const cap = Math.floor(capMb * 1024 * 1024);
    const tickets = new Tickets();
    const now = () => Date.now();
    const emit = (type, payload, where) => ctx.events.emit(type, payload, where);

    /** The agent a computer target names, or null for the box. Throws for anything else. */
    const agentOf = target => {
      if (target === "box") return null;
      const m = COMPUTER.exec(String(target || ""));
      if (!m) throw new Error(`"${target}" is not a target; use box or computer:<agent>`);
      return m[1];
    };

    /**
     * Where a target's files are, for this caller. Glass's file browser is a person's: an agent
     * may reach only its own computer's files through it, never the box or another agent's, and a model with no agent behind it reaches none.
     */
    const filesFor = (target, caller) => {
      const said = /(?:^|[\s:])agent:([A-Za-z0-9_-]*)/.exec(String(caller || ""));
      if (said && target !== `computer:${said[1]}`) throw new Error("an agent may browse only its own computer's files through Glass");
      // A model caller with no agent behind it (a plain mcp or harness session) has no computer of its own: it is held like a named agent, which leaves it nothing (Glass's file browser is a person's,
      // or an agent's own computer).
      if (!said && ["mcp", "harness"].includes(callerKind(String(caller).trim().toLowerCase()))) throw new Error("a model caller with no agent behind it has no computer of its own, so it may browse no files through Glass");
      return providerFor(target);
    };

    /** Where a target's files are. */
    const providerFor = target => {
      const agent = agentOf(target);
      if (agent) return new ComputerProvider(agent, ctx.call);
      if (!box) throw new Error("the box has no folders open to Glass; set glass.roots in config");
      return box;
    };

    /** Refuse a file whose first bytes are a private key, whatever its name (as link does). */
    const notAKey = async (p, rel, st) => {
      if (!(Number(st.size) > 0)) return;
      const r = await p.read(rel, `bytes=0-${KEY_SNIFF - 1}`);
      const chunks = [];
      for await (const c of r.stream) chunks.push(c);
      if (isKeyBytes(Buffer.concat(chunks))) throw Object.assign(new Error(`"${rel}" is a private key; Glass does not open keys, so the person opens it by hand outside Glass`), { code: "denied" });
    };

    /** A person's surface, from someone allowed to name one. */
    const surfaceOf = (surface, caller) => {
      if (isAgent(caller)) throw new Error("an agent cannot act as a person's screen; open, take and release are for people");
      if (!SURFACE.test(String(surface || ""))) throw new Error("surface must name a person's screen: deck:<device>, phone:<device>, glass:<device> or capsule:<device>");
      return String(surface);
    };

    /** Call another module's tool; its error becomes ours. */
    const need = async (tool, input) => {
      const r = await ctx.call(tool, input);
      if (r.error) throw Object.assign(new Error(r.error.message), { code: r.error.code });
      return r.data;
    };

    /** Take-overs this module started, by agent: when, from where, and whether shielded. */
    /** @type {Map<string, { surface: string, since: number, private: boolean }>} */
    const takes = new Map();

    // A take-over can end without glass.release: the lease lapsed, or the tab closed. Then a
    // shield Glass raised comes down too; computers should do this itself, and this is the
    // belt to its braces.
    const off = ctx.events.on("computer.handed-back", e => {
      const agent = e && e.payload && e.payload.agent;
      const t = agent && takes.get(agent);
      if (!t) return;
      takes.delete(agent);
      if (t.private) ctx.call("computers.shield", { agent, on: false }).catch(() => {});
    });

    // The file tools that change a target (upload, move, mkdir, trash) are open to the person's surfaces and to a model: filesFor holds a model to its own computer's files and gives a plain mcp or harness session none.
    const FILE_WRITERS = new Set(["glass.files.upload", "glass.files.move", "glass.files.mkdir", "glass.files.trash"]);
    const FILE_WRITE_CALLERS = ["cli", "local", "deck", "capsule", "mobile", "tailnet", "device", "module", "mcp", "harness"];
    const tool = (name, description, input, run, extra = {}) => ctx.tool(name, { description, input, run, ...(FILE_WRITERS.has(name) ? { callers: FILE_WRITE_CALLERS } : {}), ...extra });

    // ---- screens -------------------------------------------------------------------------

    tool("glass.targets", "What Glass can open: each agent's computer (screen and files) and the box (files only, when glass.roots is set).",
      obj({}), async () => {
        const out = [];
        const r = await ctx.call("computers.list", {});
        if (!r.error && r.data) {
          const screens = r.data.driver !== "none";
          for (const c of r.data.computers || []) {
            out.push({ target: `computer:${c.agent}`, label: String(c.agent), screen: screens, files: true, state: String(c.state || "none"),
              viewers: Number(c.viewers) || 0, takeover: c.takeover || null });
          }
        }
        if (box) out.push({ target: "box", label: "box", screen: false, files: true, state: "running", viewers: 0, takeover: null });
        return out;
      });

    tool("glass.open", "Open a target on a person's screen. For an agent's computer the answer carries a one-use ticket for its screen stream.",
      obj({ target: str, surface: str }, ["target", "surface"]), async (i, { caller, peer }) => {
        const surface = surfaceOf(i.surface, caller);
        const agent = agentOf(i.target);
        /** @type {any} */
        let screen;
        /** @type {{ path: string, latencyMs: number|null } | null} */
        let link = null;
        if (agent) {
          link = await viewerLink(peer);
          screen = await need("computers.watch", { agent, surface, ...(link && isSlow(link) ? { slow: true } : {}) });
        }
        else if (!box) throw new Error("the box has no folders open to Glass; set glass.roots in config");
        const session = crypto.randomUUID();
        db.prepare("INSERT INTO glass_sessions (id, target, surface, caller, opened, closed) VALUES (?, ?, ?, ?, ?, NULL)")
          .run(session, i.target, surface, String(caller), now());
        emit("glass.opened", { session, target: i.target, surface });
        const roots = agent ? [{ name: "home", path: "" }] : /** @type {BoxProvider} */ (box).roots();
        return { session, ...(screen ? { screen } : {}), ...(link ? { link } : {}), roots };
      });

    /**
     * How the box reaches the viewer's device, for a tailnet viewer: link.health, best effort. A
     * first check can take seconds (a ping), so the open waits at most HEALTH_WAIT for it; the
     * check goes on and its cached answer serves the next open. Never fails the open.
     * @param {any} peer the node the tailnet listener identified, or undefined on the socket
     */
    const viewerLink = async peer => {
      if (!peer || !peer.stableId) return null;
      try {
        const r = await within(ctx.call("link.health", { node: String(peer.stableId) }), HEALTH_WAIT);
        const d = r && !r.error ? r.data : null;
        return d && d.path ? { path: String(d.path), latencyMs: typeof d.latencyMs === "number" ? d.latencyMs : null } : null;
      } catch { return null; }
    };

    tool("glass.close", "Close a Glass session.", obj({ session: str }, ["session"]), async (i, { caller } = {}) => {
      const row = /** @type {any} */ (db.prepare("SELECT * FROM glass_sessions WHERE id = ? AND closed IS NULL").get(i.session));
      // A guest closes only the sessions it opened, never the owner's.
      if (!row || (String(caller).startsWith("tailnet-guest:") && row.caller !== String(caller))) return { closed: false };
      const at = now();
      db.prepare("UPDATE glass_sessions SET closed = ? WHERE id = ?").run(at, i.session);
      emit("glass.closed", { session: row.id, target: row.target, surface: row.surface, seconds: Math.round((at - Number(row.opened)) / 1000) });
      return { closed: true };
    });

    tool("glass.take", "Take the keyboard of an agent's computer for a person's screen; the agent's hands wait. private: also shield the agent's eyes, for signing in.",
      obj({ target: str, surface: str, private: { type: "boolean" } }, ["target", "surface"]), async (i, { caller }) => {
        const surface = surfaceOf(i.surface, caller);
        const agent = agentOf(i.target);
        if (!agent) throw new Error("the box has no screen to take over");
        const shielded = i.private === true;
        await need("computers.takeover", { agent, surface });
        if (shielded) {
          const s = await ctx.call("computers.shield", { agent, on: true });
          if (s.error) {
            // A private take-over that cannot shield is not private: undo it rather than leave a
            // person typing a password the agent can still read.
            await ctx.call("computers.giveback", { agent, surface });
            if (s.error.code === "no_such_tool") throw new Error("private sign-in needs the computers shield, which is not running");
            throw new Error(`could not shield ${agent}'s computer: ${s.error.message}`);
          }
        }
        const prev = takes.get(agent);
        const since = prev && prev.surface === surface ? prev.since : now();
        takes.set(agent, { surface, since, private: shielded || Boolean(prev && prev.surface === surface && prev.private) });
        emit("glass.taken", { target: i.target, surface, private: shielded });
        return { target: i.target, surface, since, private: shielded };
        // No presence, private or not (core/presence PERSON_ONLY): the owner is never asked for a
        // passkey to take the keyboard. An agent still cannot take a person's screen (surfaceOf).
      });

    tool("glass.release", "Hand the keyboard back to the agent. note: a line for the agent's thread about what changed.",
      obj({ target: str, surface: str, note: str }, ["target", "surface"]), async (i, { caller }) => {
        const surface = surfaceOf(i.surface, caller);
        const agent = agentOf(i.target);
        if (!agent) throw new Error("the box has no screen to hand back");
        const t = takes.get(agent);
        if (t && t.surface === surface && t.private) {
          const s = await ctx.call("computers.shield", { agent, on: false });
          if (s.error && s.error.code !== "no_such_tool") ctx.log(`could not lower ${agent}'s shield: ${s.error.message}`);
        }
        const g = await need("computers.giveback", { agent, surface });
        if (!g || !g.handed_back) return { released: false, held_ms: 0 };
        const held = t && t.surface === surface ? now() - t.since : 0;
        takes.delete(agent);
        emit("glass.released", { target: i.target, surface, held_ms: held, why: "gave back" });
        const noted = await noteThread(agent, surface, held, i.note);
        // `noted` says whether the agent's thread was told: false when it has no thread open, so a screen can say where the note went instead of claiming it arrived.
        return { released: true, held_ms: held, noted };
        // No presence: giving the agent its keyboard back only returns what it had, and a person
        // at the Deck must never be stuck in control. An agent still cannot call it for a person's
        // surface (surfaceOf).
      });

    /**
     * Tell the agent its keyboard was taken and given back: who, for how long, and the person's
     * note. Never anything typed. Best effort: no thread, or no switchboard, and it is skipped. True when the thread was told.
     */
    const noteThread = async (agent, surface, held, note) => {
      try {
        const c = await ctx.call("computers.get", { agent });
        const thread = c.data && c.data.thread;
        if (!thread) return false;
        const from = FROM[surface.split(":")[0]] || surface.split(":")[0];
        const clean = typeof note === "string" ? note.replace(/\s+/g, " ").trim().slice(0, 500) : "";
        const text = `Someone had your keyboard from ${from} for ${duration(held)} and handed it back. The screen may have changed; look before acting.`
          + (clean ? ` Their note: ${clean}` : "");
        const r = await ctx.call("threads.send", { thread: String(thread), text });
        if (r.error && r.error.code !== "no_such_tool") ctx.log(`could not note the hand-back in ${agent}'s thread: ${r.error.message}`);
        return !r.error;
      } catch (e) { ctx.log(`could not note the hand-back in ${agent}'s thread: ${/** @type {Error} */ (e).message}`); return false; }
    };

    // ---- files ---------------------------------------------------------------------------

    const target = { target: str };

    tool("glass.files.list", "List a folder on a target. The box's top level lists its roots; private places are never shown.",
      obj({ ...target, path: str }, ["target"]), async (i, { caller }) => filesFor(i.target, caller).list(i.path || ""));

    tool("glass.files.stat", "One file or folder on a target: name, kind, size, mtime, mime.",
      obj({ ...target, path: str }, ["target", "path"]), async (i, { caller }) => {
        const st = await filesFor(i.target, caller).stat(i.path);
        return { name: st.name, kind: st.kind, size: Number(st.size) || 0, mtime: st.mtime, mime: st.mime || (st.kind === "file" ? mimeOf(st.name) : "inode/directory") };
      });

    tool("glass.files.preview", "Preview a file: text up to 256 KB, or a one-use path for an image or PDF.",
      obj({ ...target, path: str }, ["target", "path"]), async (i, { caller }) => {
        const p = filesFor(i.target, caller);
        const st = await p.stat(i.path);
        if (st.kind !== "file") throw new Error(`"${i.path}" is not a file`);
        await notAKey(p, i.path, st);
        const mime = mimeOf(st.name);
        if (INLINE.has(mime)) {
          const ticket = tickets.issue({ op: "raw", target: i.target, path: i.path, size: Number(st.size) || 0, overwrite: false, caller: String(caller), name: st.name });
          return { kind: mime === "application/pdf" ? "pdf" : "image", path: `/v1/glass/raw?ticket=${ticket}` };
        }
        const r = await p.read(i.path, Number(st.size) > 0 ? `bytes=0-${MAX_PREVIEW - 1}` : undefined);
        const chunks = [];
        let n = 0;
        for await (const c of r.stream) {
          chunks.push(c); n += c.length;
          if (n >= MAX_PREVIEW) { r.stream.destroy(); break; }
        }
        const buf = Buffer.concat(chunks).subarray(0, MAX_PREVIEW);
        if (!isText(mime) && buf.subarray(0, 8192).includes(0)) return { kind: "binary", mime, size: Number(st.size) || 0 };
        // Cut on a character boundary, not mid-way through one.
        let text = buf.toString("utf8");
        if (buf.length === MAX_PREVIEW && text.endsWith("�")) text = text.slice(0, -1);
        return { kind: "text", text, truncated: Number(st.size) > buf.length };
      });

    tool("glass.files.download", "A one-use path (60 s) to download a file from a target.",
      obj({ ...target, path: str }, ["target", "path"]), async (i, { caller }) => {
        const p = filesFor(i.target, caller);
        const st = await p.stat(i.path);
        if (st.kind !== "file") throw new Error(`"${i.path}" is not a file`);
        await notAKey(p, i.path, st);
        const ticket = tickets.issue({ op: "raw", target: i.target, path: i.path, size: Number(st.size) || 0, overwrite: false, caller: String(caller), name: st.name });
        return { path: `/v1/glass/raw?ticket=${ticket}`, name: st.name, size: Number(st.size) || 0 };
      });

    tool("glass.files.upload", "A one-use path (60 s) to PUT a file of exactly `size` bytes into a target folder. Refuses to replace a file unless overwrite.",
      obj({ ...target, dir: str, name: str, size: { type: "integer" }, overwrite: { type: "boolean", description: "allow replacing an existing file" } }, ["target", "dir", "name", "size"]), async (i, { caller }) => {
        const name = checkName(i.name);
        if (i.size < 0) throw new Error("size must be zero or more");
        if (i.size > cap) throw new Error(`that file is larger than the ${capMb} MB Glass accepts (glass.maxUploadMb)`);
        const dirSegs = checkRel(i.dir);
        if (i.target === "box" && !dirSegs.length) throw new Error("say which root: the box's top level only holds its roots");
        const full = [...dirSegs, name].join("/");
        checkRel(full);
        const p = filesFor(i.target, caller);
        const d = await p.stat(dirSegs.join("/"));
        if (d.kind !== "dir") throw new Error(`"${i.dir}" is not a folder`);
        let exists = true;
        try { await p.stat(full); } catch { exists = false; }
        if (exists && !i.overwrite) throw new Error(`"${full}" already exists; say overwrite to replace it`);
        const ticket = tickets.issue({ op: "put", target: i.target, path: full, size: i.size, overwrite: i.overwrite === true, caller: String(caller), name });
        return { path: `/v1/glass/put?ticket=${ticket}` };
      });

    tool("glass.files.move", "Move or rename a file or folder within a target. Never replaces an existing name.",
      obj({ ...target, from: str, to: str }, ["target", "from", "to"]), async (i, { caller }) => {
        const p = filesFor(i.target, caller);
        const st = await p.stat(i.from);
        await p.move(i.from, i.to);
        emit("file.moved", { target: i.target, from: checkRel(i.from).join("/"), to: checkRel(i.to).join("/"), size: st.kind === "file" ? Number(st.size) || 0 : null, by: String(caller) });
        return { moved: true };
      });

    tool("glass.files.mkdir", "Make a folder on a target.", obj({ ...target, path: str }, ["target", "path"]), async (i, { caller }) => {
      await filesFor(i.target, caller).mkdir(i.path);
      emit("file.created", { target: i.target, path: checkRel(i.path).join("/"), kind: "dir", size: 0, by: String(caller) });
      return { created: true };
    });

    tool("glass.files.trash", "Move a file or folder into the target's trash. There is no hard delete.",
      obj({ ...target, path: str }, ["target", "path"]), async (i, { caller }) => {
        const p = filesFor(i.target, caller);
        const st = await p.stat(i.path);
        const r = await p.trash(i.path);
        emit("file.trashed", { target: i.target, path: checkRel(i.path).join("/"), to: r.to, size: st.kind === "file" ? Number(st.size) || 0 : null, by: String(caller) });
        return { trashed: true, to: r.to };
      });

    register(ctx, { tickets, providerFor, emit: (type, payload) => emit(type, payload) });

    return {
      tickets, takes,
      async stop() { off(); tickets.map.clear(); },
    };
  },
};
