// @ts-check
// previews: a server an agent started on a port becomes a preview you can open, share and keep running (R031-22, R031-23; team/0.3.1/DESIGN-previews.md).
//
// A preview is a row. Two modes:
//   session     the agent started the server itself; Vyre only proxies to its port, and the preview ends with the session (the process is the agent's, in its own walls).
//   supervised  Vyre runs the command (a person's own start, or "keep it running" on something an agent started), on a port Vyre leased and gave it as PORT; it survives the session and a restart of vyred.
// It is opened on its own origin, pv-<id>.<the host Vyre is served at>, through the SAME front, ticket and cookie as an installed app (core/appmods/proxy.js): this module decides who may open it and asks
// appmods for the one-time address (appmods.ticket); appmods asks this module where a host leads (previews.resolve). There is no second proxy.
//
// Who: a person's own surface opens, starts, keeps, shares and stops. An agent may open a preview of a port (it never starts a command through here: it already has its own walls for that, and a command Vyre runs
// is outside them); the command it says started it is only remembered, so "keep it running" can offer to run it again on the person's tap.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { isPerson, PERSON_SURFACES } from "../../lib/caller.js";
import { createSupervisor, lease, answers } from "./supervisor.js";
import { createStatic } from "./static.js";
import { createBridge } from "./bridge.js";
import { findChrome, capture } from "./thumb.js";
import { poster } from "./poster.js";
import os from "node:os";
import { createDocs } from "./docs.js";
import { mayOpen, mayManage, ACCESS } from "./access.js";
import { siteOf } from "./site.js";

const str = { type: "string" };
const obj = (/** @type {any} */ properties, required = []) => ({ type: "object", properties, required });
const refuse = (/** @type {string} */ message, /** @type {string} */ code) => Object.assign(new Error(message), { code });
const PERSON_ONLY = [...PERSON_SURFACES, "tailnet", "device"];

export const MIGRATIONS = [
  `CREATE TABLE previews_items (
     id TEXT PRIMARY KEY, space TEXT, project TEXT, thread TEXT, title TEXT NOT NULL, source TEXT NOT NULL, mode TEXT NOT NULL,
     command TEXT, cwd TEXT, port INTEGER, upstream INTEGER, state TEXT NOT NULL, error TEXT, access TEXT NOT NULL, created_by TEXT,
     created INTEGER NOT NULL, updated INTEGER NOT NULL, wanted INTEGER NOT NULL DEFAULT 1
   );
   CREATE INDEX previews_items_thread ON previews_items (thread);
   CREATE INDEX previews_items_project ON previews_items (project);`,
  // A preview of files: the folder it serves (and the one file at its root), and the capabilities it declared (JSON), none by default.
  `ALTER TABLE previews_items ADD COLUMN root TEXT; ALTER TABLE previews_items ADD COLUMN file TEXT; ALTER TABLE previews_items ADD COLUMN caps TEXT;`,
  // What each viewer allowed a preview to use: nothing is on by default; a no is kept too.
  `ALTER TABLE previews_items ADD COLUMN thumb INTEGER;`,
  `CREATE TABLE previews_grants (preview TEXT NOT NULL, who TEXT NOT NULL, cap TEXT NOT NULL, allowed INTEGER NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (preview, who, cap));`,
];

/** The preview's name on the front: pv- and eight hex digits. */
export const nameOf_ = (/** @type {string} */ id) => `pv-${id}`;
const ID = /^[0-9a-f]{8}$/;

/** @type {{ start(ctx: any, seam?: any): Promise<{ stop(): Promise<void> }> }} */
export default {
  async start(ctx, seam = {}) {
    ctx.store.migrate(MIGRATIONS);
    const db = ctx.store.db;
    const now = seam.now || Date.now;
    const emit = (/** @type {string} */ type, /** @type {any} */ payload, /** @type {any} */ where) => { try { ctx.events.emit(type, payload, where); } catch { /* an event nobody hears */ } };
    /** The chat's card: the thread's stream draws (and redraws) it from this. */
    const card = (/** @type {any} */ r) => { if (r && r.thread) emit("thread.preview", { id: r.id, title: r.title, state: r.state, source: r.source, mode: r.mode, access: r.access, thumb: r.thumb || 0 }, { thread: r.thread }); };

    const view = (/** @type {any} */ r, detail = false) => ({
      id: r.id, title: r.title, source: r.source, mode: r.mode, state: r.state, access: r.access, thread: r.thread || null, project: r.project || null,
      created_by: r.created_by || null, created: r.created, updated: r.updated, ...(r.error ? { error: r.error } : {}),
      ...(detail ? { command: r.command || null, cwd: r.cwd || null, port: r.upstream || r.port || null } : {}),
    });
    const row = (/** @type {string} */ id) => db.prepare("SELECT * FROM previews_items WHERE id = ?").get(String(id));
    const mustRow = (/** @type {string} */ id) => { const r = row(id); if (!r) throw refuse("no such preview: give the id of one you may open", "not_found"); return r; };
    const setState = (/** @type {string} */ id, /** @type {string} */ state, error = "") => {
      const r = row(id); if (!r) return;
      const was = r.state;
      db.prepare("UPDATE previews_items SET state = ?, error = ?, updated = ? WHERE id = ?").run(state, error || null, now(), id);
      if (state === "live" && was !== "live") soon(id);
      emit("preview.state", { id, state, title: r.title, thread: r.thread || null, project: r.project || null, ...(error ? { error } : {}) });
      card(row(id));
    };

    const sup = seam.supervisor || createSupervisor({
      log: (/** @type {string} */ m) => ctx.log.warn(m),
      onState: (/** @type {string} */ id, /** @type {string} */ state, /** @type {{ error?: string }} */ info) => setState(id, state, info.error || ""),
    });

    // ---- the bridge: what a page that declared capabilities can reach (bridge.js) ------------------------------------------------------------------------------------------------------------
    const viewerKey = crypto.randomBytes(32).toString("hex");
    const K = ctx.kernel;
    const docs = seam.docs || (K && K.records && typeof K.serviceChain === "function" ? createDocs({ store: K.records, chain: () => K.serviceChain() }) : {
      get: async () => { throw refuse("stored data needs the kernel, which this build runs without", "unavailable"); }, set: async () => { throw refuse("stored data needs the kernel, which this build runs without", "unavailable"); },
      update: async () => { throw refuse("stored data needs the kernel, which this build runs without", "unavailable"); }, del: async () => { throw refuse("stored data needs the kernel, which this build runs without", "unavailable"); },
      list: async () => { throw refuse("stored data needs the kernel, which this build runs without", "unavailable"); }, count: async () => 0, purge: async () => {},
    });
    const grants = {
      get: (/** @type {string} */ id, /** @type {string} */ who, /** @type {string} */ cap) => { const g = db.prepare("SELECT allowed FROM previews_grants WHERE preview = ? AND who = ? AND cap = ?").get(id, who, cap); return g ? Number(g.allowed) : null; },
      set: (/** @type {string} */ id, /** @type {string} */ who, /** @type {string} */ cap, /** @type {boolean} */ allowed) => { db.prepare("INSERT INTO previews_grants (preview, who, cap, allowed, at) VALUES (?,?,?,?,?) ON CONFLICT (preview, who, cap) DO UPDATE SET allowed = excluded.allowed, at = excluded.at").run(id, who, cap, allowed ? 1 : 0, now()); },
    };
    /** The name a page's `user` capability shows for a person: not yet known to this module (spaces.members.list is for a person's own call, not a module's), so "Someone". @param {string} _who */
    const nameOf = async _who => "Someone";
    const bridge = createBridge({ row: (/** @type {string} */ id) => row(id), grants, docs, call: (/** @type {string} */ t, /** @type {any} */ i) => ctx.call(t, i), key: viewerKey, nameOf, log: (/** @type {string} */ m) => ctx.log.warn(m) });

    // ---- files: the container -----------------------------------------------------------------------------------------------------------------------------------------------------------------
    // One small server on this machine's loopback serves every files preview, told which by the host the front forwards. Nothing about a page's own format is checked or required.
    const staticSrv = createStatic({
      log: (/** @type {string} */ m) => ctx.log.warn(m),
      api: (/** @type {any} */ req, /** @type {any} */ res, /** @type {string} */ id, /** @type {URL} */ url) => bridge.api(req, res, id, url),
      lookup: (/** @type {string} */ id) => { const r = row(id); return r && r.source === "files" && r.root && r.state !== "stopped" ? { root: r.root, file: r.file || null, caps: Boolean(r.caps) } : null; },
      drawn: async (/** @type {string} */ format, /** @type {string} */ title, /** @type {string} */ text) => {
        const r = await ctx.call("artifacts.render-page", { title, format, text });
        if (r.error) throw new Error(r.error.message);
        return r.data.html;
      },
    });
    await new Promise(resolve => { staticSrv.once("listening", resolve); staticSrv.once("error", resolve); staticSrv.listen(0, "127.0.0.1"); });
    const staticPort = () => { const a = staticSrv.address(); return a && typeof a !== "string" ? a.port : 0; };

    // ---- the picture on the card (thumb.js) ---------------------------------------------------------------------------------------------------------------------------------------------
    const thumbDir = path.join((ctx.paths && ctx.paths.root) || os.tmpdir(), "previews-thumbs");
    try { fs.mkdirSync(thumbDir, { recursive: true, mode: 0o700 }); fs.chmodSync(thumbDir, 0o700); } catch { /* the next write says */ }
    const thumbFile = (/** @type {string} */ id) => path.join(thumbDir, `${id}.png`);
    // config previews.thumbs: false (or VYRE_PREVIEW_THUMBS=0) turns the pictures off; previews.chrome names the browser to use
    const thumbsOn = !(process.env.VYRE_PREVIEW_THUMBS === "0" || (ctx.config && ctx.config.previews && ctx.config.previews.thumbs === false));
    const chrome = seam.chrome !== undefined ? seam.chrome : thumbsOn ? findChrome(process.env, ctx.config && ctx.config.previews && ctx.config.previews.chrome) : null;
    const shoot = seam.capture || capture;
    /** @type {Set<string>} */ const shooting = new Set();
    /** Take the preview's picture: its own address on this machine, one screenshot, the last good one kept. Quiet when there is no Chrome, or the page does not come up. @param {string} id */
    const posterFile = (/** @type {string} */ id) => path.join(thumbDir, `${id}.svg`);
    /** The page's own source for a poster: a files preview's entry, or what a port answers at its root. Empty when it cannot be read. @param {any} r */
    const sourceOf = async r => {
      try {
        if (r.source === "files") {
          const root = r.root || ""; const file = r.file ? path.resolve(root, r.file) : "";
          const f = file && fs.existsSync(file) && fs.statSync(file).isFile() ? file : path.join(root, "index.html");
          return fs.readFileSync(f, "utf8").slice(0, 200_000);
        }
        if (r.upstream) {
          const ac = new AbortController(); const t = setTimeout(() => ac.abort(), 3000);
          try { const res = await fetch(`http://127.0.0.1:${r.upstream}/`, { signal: ac.signal, headers: { accept: "text/html" } }); return (await res.text()).slice(0, 200_000); } finally { clearTimeout(t); }
        }
      } catch { /* the poster falls back to the preview's own name */ }
      return "";
    };
    const drawPoster = async (/** @type {any} */ r) => {
      fs.writeFileSync(posterFile(r.id), poster({ html: await sourceOf(r), title: r.title }), { mode: 0o600 });
      db.prepare("UPDATE previews_items SET thumb = ? WHERE id = ?").run(now(), r.id); card(row(r.id));
    };
    const takeThumb = async id => {
      if (shooting.has(id) || !thumbsOn) return;
      const r = row(id);
      if (!r || r.state !== "live") return;
      if (!chrome) { shooting.add(id); try { await drawPoster(r); } catch (e) { ctx.log.warn(`previews: no poster for ${id}: ${/** @type {Error} */ (e).message}`); } finally { shooting.delete(id); } return; }
      const url = r.source === "files" ? `http://pv-${id}.localhost:${staticPort()}/` : r.upstream ? `http://127.0.0.1:${r.upstream}/` : "";
      if (!url) return;
      shooting.add(id);
      try {
        if (await shoot({ chrome, url, out: thumbFile(id) })) { db.prepare("UPDATE previews_items SET thumb = ? WHERE id = ?").run(now(), id); card(row(id)); }
      } catch (e) { ctx.log.warn(`previews: no picture for ${id}: ${/** @type {Error} */ (e).message}`); } finally { shooting.delete(id); }
    };
    const soon = (/** @type {string} */ id, ms = 1500) => { const t = setTimeout(() => { void takeThumb(id); }, ms); if (typeof t.unref === "function") t.unref(); };

    // ---- who ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
    /** The person behind a call and their role in this Space: { id, role }, or null for anyone who is not a person. @param {any} meta */
    const whoIs = async (/** @type {any} */ meta, /** @type {boolean} */ relayed = false) => {
      if (!relayed && !isPerson(meta)) return null; // relayed: a module carrying the person's own call (the chain below is theirs, from the kernel)
      if (!ctx.kernel || typeof ctx.kernel.chain !== "function") return { id: "owner", role: "owner" }; // a build without its kernel has one person
      const chain = await ctx.kernel.chain(meta).catch(() => null);
      const hop = chain && Array.isArray(chain.hops) ? chain.hops[0] : null;
      if (!hop || !hop.actor || hop.actor.kind !== "person" || chain.hops.length !== 1) return null;
      if (hop.actor.id === ctx.kernel.owner) return { id: String(hop.actor.id), role: "owner" };
      const mem = await ctx.kernel.grants.members.get(chain, hop.actor.id).catch(() => null);
      return { id: String(hop.actor.id), role: mem ? String(mem.role || "member") : null };
    };
    const needPerson = async (/** @type {any} */ meta) => { const w = await whoIs(meta); if (!w) throw refuse("only a person at their own surface does this", "denied"); return w; };
    const manage = async (/** @type {any} */ id, /** @type {any} */ meta) => { const w = await needPerson(meta); const r = mustRow(id); if (!mayManage(r, w)) throw refuse("only its maker, or an owner or admin of this Space, does this", "denied"); return { r, w }; };

    // ---- ports -----------------------------------------------------------------------------------------------------------------------------------------------------------------------------
    /** A port the agent names must be one of its own servers, never one of Vyre's (the front, the daemon) or a system port. */
    const denyPort = async (/** @type {number} */ port) => {
      if (!Number.isInteger(port) || port < 1024 || port > 65535) return "that is not a port a server of yours would use";
      const front = await ctx.call("appmods.front", {}).catch(() => null);
      if (front && front.data && front.data.port === port) return "that port is Vyre's own";
      const cfg = ctx.config || {};
      for (const p of [cfg.port, cfg.daemon && cfg.daemon.port, cfg.appmods && cfg.appmods.listen, cfg.vault && cfg.vault.mcp && cfg.vault.mcp.port]) if (Number(p) === port) return "that port is Vyre's own";
      return "";
    };
    const heldPorts = () => new Set(db.prepare("SELECT port, upstream FROM previews_items").all().flatMap((/** @type {any} */ r) => [r.port, r.upstream]).filter(Boolean));

    const runSupervised = async (/** @type {any} */ r) => {
      const port = r.upstream || (await lease(heldPorts()));
      db.prepare("UPDATE previews_items SET upstream = ?, mode = 'supervised', wanted = 1 WHERE id = ?").run(port, r.id);
      sup.start(r.id, { command: r.command, cwd: r.cwd, port, env: seam.env || {} });
    };

    /** Who may open a new preview. A model's preview is private to its person, or open to the project its own chat belongs to; anything wider is the person's own act (previews.share). @param {any} i @param {any} meta @param {any} person */
    const scopeOf = async (i, meta, person) => {
      const wanted = ACCESS.includes(i.access) ? i.access : null;
      if (person || String((meta && meta.caller) || "").startsWith("module:")) return { access: wanted || (i.project ? "project" : "me"), project: i.project ? String(i.project) : null };
      let own = null;
      if (meta && meta.thread) { const t = await ctx.call("threads.get", { thread: meta.thread, limit: 1 }).catch(() => null); const th = t && t.data && (t.data.thread || t.data); own = th && th.project ? String(th.project) : null; }
      if (i.project && String(i.project) !== own) throw refuse("a preview can be open to the project this chat belongs to and no other: ask the person to share it", "denied");
      const project = i.project ? own : null;
      if (wanted === "team" || (wanted === "project" && !project)) throw refuse("a model opens a preview for its person only, or for its own chat's project: ask the person to share it wider", "denied");
      return { access: wanted || (project ? "project" : "me"), project };
    };

    /** Open a file or folder as a preview of its own. An agent's path must be inside the folder its session works in (a person's own may be anywhere they can read). */
    const openFiles = async (/** @type {any} */ i, /** @type {any} */ meta, /** @type {any} */ person) => {
      let real;
      try { real = fs.realpathSync(String(i.path)); } catch { throw refuse("that path does not exist", "bad_input"); }
      if (!path.isAbsolute(String(i.path))) throw refuse("give an absolute path", "bad_input");
      const st = fs.statSync(real);
      const thread = (person && i.thread ? String(i.thread) : (meta && meta.thread) || null);
      if (!person && !String((meta && meta.caller) || "").startsWith("module:")) {
        const t = thread ? await ctx.call("threads.get", { thread, limit: 1 }).catch(() => null) : null;
        const cwd = t && t.data && ((t.data.thread && t.data.thread.cwd) || t.data.cwd);
        let base = ""; try { base = cwd ? fs.realpathSync(String(cwd)) : ""; } catch { base = ""; }
        if (!base || !(real === base || real.startsWith(base + path.sep))) throw refuse("a preview of files must be inside the folder this session works in", "denied");
      }
      const root = st.isDirectory() ? real : path.dirname(real);
      const file = st.isDirectory() ? null : real;
      // The page declares what it wants, the way a Claude artifact does at publish: in the call, else in .vyre/preview.json beside it. Nothing is on by default, and the viewer allows each one.
      let caps = i.capabilities && typeof i.capabilities === "object" && !Array.isArray(i.capabilities) ? i.capabilities : null;
      if (!caps) { try { const c = JSON.parse(fs.readFileSync(path.join(root, ".vyre", "preview.json"), "utf8")); if (c && c.capabilities && typeof c.capabilities === "object") caps = c.capabilities; } catch { /* none declared */ } }
      const id = crypto.randomBytes(4).toString("hex");
      const t = now();
      const creator = person ? person.id : (ctx.kernel && ctx.kernel.owner ? String(ctx.kernel.owner) : "owner");
      const { access, project } = await scopeOf(i, meta, person);
      const title = String(i.title || "").trim().slice(0, 80) || path.basename(real);
      db.prepare(`INSERT INTO previews_items (id, space, project, thread, title, source, mode, port, upstream, state, access, created_by, created, updated, wanted, root, file, caps)
        VALUES (?,?,?,?,?, 'files', 'session', NULL, ?, 'live', ?, ?, ?, ?, 0, ?, ?, ?)`)
        .run(id, ctx.space || null, project, thread, title, staticPort(), access, creator, t, t, root, file, caps ? JSON.stringify(caps).slice(0, 8000) : null);
      emit("preview.opened", { id, title, thread, project: i.project || null });
      card(row(id));
      soon(id, 500);
      return { id, state: "live", preview: view(row(id)), message: `${title} is a preview now: a card is in the chat, and the person opens it from there.` };
    };

    // ---- tools -----------------------------------------------------------------------------------------------------------------------------------------------------------------------------
    ctx.tool("previews.open", {
      description: "Show the person a server (port) or files you wrote (path) as a card. Needs title and port or path. Returns the id.",
      input: obj({ title: str, port: { type: "integer" }, command: str, cwd: str, path: str, capabilities: { type: "object" }, thread: str, project: str, access: { type: "string", enum: [...ACCESS] } }, ["title"]),
      callers: [...PERSON_ONLY, "module", "mcp", "harness", "agent"],
      run: async (/** @type {any} */ i, /** @type {any} */ meta) => {
        const person = await whoIs(meta);
        const title = String(i.title || "").trim().slice(0, 80) || "Preview";
        const wantsFiles = typeof i.path === "string" && i.path.trim() !== "";
        if (wantsFiles) return openFiles(i, meta, person);
        const wantsCommandRun = typeof i.command === "string" && i.command.trim() && !Number.isInteger(i.port);
        if (wantsCommandRun && !person) throw refuse("starting a command here is the person's own act: start the server yourself and give its port", "denied");
        const cwd = typeof i.cwd === "string" && i.cwd ? i.cwd : null;
        if (wantsCommandRun) { if (!cwd || !path.isAbsolute(cwd) || !fs.existsSync(cwd)) throw refuse("give the folder to run it in (cwd), an absolute path that exists", "bad_input"); }
        if (Number.isInteger(i.port)) { const why = await denyPort(i.port); if (why) throw refuse(why, "bad_input"); }
        else if (!wantsCommandRun) throw refuse("give the port your server listens on, or a command for the person to run", "bad_input");
        const id = crypto.randomBytes(4).toString("hex");
        const t = now();
        // The creator: the person themself, or (a model or module) the thread's person is the box's one person until threads say otherwise. Previews made by an agent are private to that person by default.
        const creator = person ? person.id : (ctx.kernel && ctx.kernel.owner ? String(ctx.kernel.owner) : "owner");
        const { access, project } = await scopeOf(i, meta, person);
        db.prepare(`INSERT INTO previews_items (id, space, project, thread, title, source, mode, command, cwd, port, upstream, state, access, created_by, created, updated, wanted)
          VALUES (?,?,?,?,?, 'port', ?, ?, ?, ?, ?, 'starting', ?, ?, ?, ?, ?)`)
          .run(id, ctx.space || null, project, (person && i.thread ? String(i.thread) : (meta && meta.thread) || null), title, wantsCommandRun ? "supervised" : "session", i.command ? String(i.command).slice(0, 2000) : null, cwd,
            Number.isInteger(i.port) ? i.port : null, Number.isInteger(i.port) ? i.port : null, access, creator, t, t, wantsCommandRun ? 1 : 0);
        emit("preview.opened", { id, title, thread: row(id).thread || null, project: i.project || null });
        card(row(id));
        if (wantsCommandRun) await runSupervised(row(id));
        else setState(id, (await answers(i.port)) ? "live" : "starting");
        return { id, state: row(id).state, preview: view(row(id)), message: `${title} is a preview now: a card is in the chat, and the person opens it from there. ${Number.isInteger(i.port) ? "It ends with this chat; the person can tap Keep it running on the card to have Vyre look after it." : ""}`.trim() };
      },
    });

    ctx.tool("previews.list", {
      description: "The previews in this chat or project: { previews: [...] } (title, state, who may open it). Never an address or a ticket.",
      input: obj({ thread: str, project: str }),
      callers: [...PERSON_ONLY, "module", "mcp", "harness", "agent"],
      run: async (/** @type {any} */ i, /** @type {any} */ meta) => {
        const who = await whoIs(meta);
        const rows = db.prepare("SELECT * FROM previews_items ORDER BY created DESC").all().filter((/** @type {any} */ r) => (!i.thread || r.thread === i.thread) && (!i.project || r.project === i.project));
        // A person sees what they may open; a model (or module) sees the previews of the chat it is in, by title and state only.
        return { previews: rows.filter((/** @type {any} */ r) => (who ? mayOpen(r, who) || mayManage(r, who) : true)).map((/** @type {any} */ r) => view(r, Boolean(who))) };
      },
    });

    ctx.tool("previews.get", {
      description: "One preview: { preview }.", input: obj({ id: str }, ["id"]),
      callers: [...PERSON_ONLY, "module", "mcp", "harness", "agent"],
      run: async (/** @type {any} */ i, /** @type {any} */ meta) => {
        const who = await whoIs(meta); const r = mustRow(i.id);
        if (who && !mayOpen(r, who) && !mayManage(r, who)) throw refuse("no such preview: give the id of one you may open", "not_found");
        return { preview: view(r, Boolean(who)) };
      },
    });

    ctx.tool("previews.folder", {
      description: "The folder a files preview serves, for Publish: { root }. Internal: Publish only, for the person who pressed the card.", internal: true,
      input: obj({ id: str }, ["id"]), callers: ["module"],
      run: async (/** @type {any} */ i, /** @type {any} */ meta) => {
        if (!meta || meta.caller !== "module:publish") throw refuse("only Publish asks for a preview's folder", "denied");
        const who = await whoIs(meta, true), r = mustRow(i.id);
        if (!who) throw refuse("only a person at their own surface does this", "denied");
        if (!mayOpen(r, who) && !mayManage(r, who)) throw refuse("no such preview: give the id of one you may open", "not_found");
        if (r.source !== "files" || !r.root) throw refuse("that preview is a running server, not a folder of files: publish a folder of ready files instead", "bad_input");
        if (r.file) throw refuse("that preview is one file, not a folder: publish the folder it sits in by naming it", "bad_input");
        return { root: String(r.root) };
      },
    });

    ctx.tool("previews.url", {
      description: "The address to open a preview at: { url }, on its own origin, with a one-time sign-in that is good for a minute. embed: true is for a frame inside Vyre's own app (its sign-in works in a frame). A person who may open it, at their own surface.",
      input: obj({ id: str, origin: str, embed: { type: "boolean" } }, ["id"]), callers: PERSON_ONLY,
      run: async (/** @type {any} */ i, /** @type {any} */ meta) => {
        const who = await needPerson(meta); const r = mustRow(i.id);
        if (!mayOpen(r, who) && !mayManage(r, who)) throw refuse("no such preview: give the id of one you may open", "not_found");
        if (r.state === "stopped" || r.state === "crashed") throw refuse(r.state === "stopped" ? "it is stopped: restart it first" : "it is not running: restart it, or look at its log", "unavailable");
        const t = await ctx.call("appmods.ticket", { name: nameOf_(r.id), who: who.id, role: who.role || "", ...(i.embed === true ? { embed: true } : {}), ...(i.origin ? { origin: i.origin } : {}) });
        if (t.error) throw refuse(t.error.message || "the front door did not answer", t.error.code || "unavailable");
        return { url: t.data.url, host: t.data.host };
      },
    });

    ctx.tool("previews.keep", {
      description: "Keep a preview running by itself: Vyre runs the command the agent said it started with, on its own port, so it survives this session and a restart. The person's tap on their own surface. Needs the command and its folder.",
      input: obj({ id: str }, ["id"]), callers: PERSON_ONLY,
      run: async (/** @type {any} */ i, /** @type {any} */ meta) => {
        const { r } = await manage(i.id, meta);
        if (r.mode === "supervised") return { preview: view(r) };
        if (!r.command || !r.cwd || !path.isAbsolute(r.cwd) || !fs.existsSync(r.cwd)) throw refuse("Vyre does not know how this was started, so it cannot keep it running: open it again with its command and folder so Vyre starts it", "unavailable");
        db.prepare("UPDATE previews_items SET upstream = NULL WHERE id = ?").run(r.id);
        await runSupervised(row(r.id));
        return { preview: view(row(r.id)) };
      },
    });

    ctx.tool("previews.restart", {
      description: "Restart a preview Vyre keeps running.", input: obj({ id: str }, ["id"]), callers: PERSON_ONLY,
      run: async (/** @type {any} */ i, /** @type {any} */ meta) => {
        const { r } = await manage(i.id, meta);
        if (r.source === "files") { if (!r.root || !fs.existsSync(r.root)) throw refuse("its folder is gone: put the folder back, or open a new preview", "unavailable"); setState(r.id, "live"); return { preview: view(row(r.id)) }; }
        if (r.mode !== "supervised") throw refuse("this server is the agent's own: ask it to restart it, or keep it running here first", "unavailable");
        db.prepare("UPDATE previews_items SET wanted = 1 WHERE id = ?").run(r.id);
        if (!sup.has(r.id)) await runSupervised(row(r.id)); else sup.restart(r.id);
        setState(r.id, "starting");
        return { preview: view(row(r.id)) };
      },
    });

    ctx.tool("previews.stop", {
      description: "Stop a preview. A server Vyre keeps running is stopped; an agent's own is only taken off the card.", input: obj({ id: str }, ["id"]), callers: PERSON_ONLY,
      run: async (/** @type {any} */ i, /** @type {any} */ meta) => {
        const { r } = await manage(i.id, meta);
        db.prepare("UPDATE previews_items SET wanted = 0 WHERE id = ?").run(r.id);
        if (r.mode === "supervised") sup.stop(r.id);
        setState(r.id, "stopped");
        await ctx.call("appmods.drop", { name: nameOf_(r.id) }).catch(() => {});
        return { preview: view(row(r.id)) };
      },
    });

    ctx.tool("previews.remove", {
      description: "Remove a preview: stop it and forget it.", input: obj({ id: str }, ["id"]), callers: PERSON_ONLY,
      run: async (/** @type {any} */ i, /** @type {any} */ meta) => {
        const { r } = await manage(i.id, meta);
        sup.forget(r.id);
        try { fs.rmSync(thumbFile(r.id), { force: true }); fs.rmSync(posterFile(r.id), { force: true }); } catch { /* none */ }
        bridge.forget(r.id);
        void docs.purge(r.id).catch(() => {});
        db.prepare("DELETE FROM previews_grants WHERE preview = ?").run(r.id);
        db.prepare("DELETE FROM previews_items WHERE id = ?").run(r.id);
        await ctx.call("appmods.drop", { name: nameOf_(r.id) }).catch(() => {});
        emit("preview.removed", { id: r.id, thread: r.thread || null, project: r.project || null });
        return { removed: r.id };
      },
    });

    ctx.tool("previews.log", {
      description: "The last lines of a preview's output (what its server printed), for the person looking at why it does not work.", input: obj({ id: str, lines: { type: "integer" } }, ["id"]), callers: PERSON_ONLY,
      run: async (/** @type {any} */ i, /** @type {any} */ meta) => {
        const w = await needPerson(meta); const r = mustRow(i.id);
        if (!mayOpen(r, w) && !mayManage(r, w)) throw refuse("no such preview: give the id of one you may open", "not_found");
        return { log: sup.tail(r.id, Math.min(Number(i.lines) || 200, 1000)), supervised: r.mode === "supervised" };
      },
    });

    ctx.tool("previews.thumb", {
      description: "The picture on a preview's card: { image (base64 PNG), at }, or { image: null, svg } with a poster drawn from the page's own title, heading and colour where this machine has no browser, or { image: null } before it is up. A person who may open the preview.",
      input: obj({ id: str }, ["id"]), callers: PERSON_ONLY,
      run: async (/** @type {any} */ i, /** @type {any} */ meta) => {
        const who = await needPerson(meta); const r = mustRow(i.id);
        if (!mayOpen(r, who) && !mayManage(r, who)) throw refuse("no such preview: give the id of one you may open", "not_found");
        try { return { image: fs.readFileSync(thumbFile(r.id)).toString("base64"), at: r.thumb || 0 }; } catch { /* no screenshot: the drawn poster, if there is one */ }
        try { return { image: null, svg: fs.readFileSync(posterFile(r.id), "utf8"), at: r.thumb || 0 }; } catch { return { image: null }; }
      },
    });

    ctx.tool("previews.share", {
      description: "Who may open a preview: me (only you), project (the people of its project) or team (everyone in the Space). Taking access away signs out whoever had it open. Anyone-with-the-link waits for the public ingress.",
      input: obj({ id: str, access: { type: "string", enum: [...ACCESS, "public"] } }, ["id", "access"]), callers: PERSON_ONLY,
      run: async (/** @type {any} */ i, /** @type {any} */ meta) => {
        if (i.access === "public") throw refuse("sharing with anyone who has the link is not available yet: it needs the public door, which comes with Publish", "unavailable");
        const { r } = await manage(i.id, meta);
        db.prepare("UPDATE previews_items SET access = ?, updated = ? WHERE id = ?").run(i.access, now(), r.id);
        if (ACCESS.indexOf(i.access) < ACCESS.indexOf(r.access)) await ctx.call("appmods.drop", { name: nameOf_(r.id) }).catch(() => {});
        emit("preview.state", { id: r.id, state: r.state, title: r.title, thread: r.thread || null, project: r.project || null, access: i.access });
        card(row(r.id));
        return { preview: view(row(r.id)) };
      },
    });

    ctx.tool("previews.resolve", {
      description: "Where a preview's host leads, for the front: { origin }. Internal: the appmods module only.", internal: true,
      input: obj({ name: str }, ["name"]), callers: ["module"],
      run: async (/** @type {any} */ i, /** @type {any} */ meta) => {
        if (!meta || meta.caller !== "module:appmods") throw refuse("the front alone asks where a preview leads: open the preview from its own page", "denied");
        const m = /^pv-([0-9a-f]{8})$/.exec(String(i.name));
        const r = m && ID.test(m[1]) ? row(m[1]) : null;
        if (!r || r.state === "stopped" || r.state === "crashed") return { origin: null };
        if (r.source === "files") return { origin: `http://127.0.0.1:${staticPort()}`, viewerKey };
        if (!r.upstream) return { origin: null };
        return { origin: `http://127.0.0.1:${r.upstream}`, viewerKey };
      },
    });

    ctx.tool("previews.site", {
      description: "A folder's files as a static site that runs on its own: a React page becomes its page, compiled files and libraries. Internal: the builder module only.", internal: true,
      input: obj({ files: { type: "array", items: { type: "object" } } }, ["files"]), callers: ["module"],
      run: async (/** @type {any} */ i, /** @type {any} */ meta) => {
        if (!meta || meta.caller !== "module:builder") throw refuse("the builder alone asks for a site: hand the job to the builder", "denied");
        const files = (Array.isArray(i.files) ? i.files : []).map((/** @type {any} */ f) => ({ path: String(f && f.path || ""), content: Buffer.isBuffer(f && f.content) ? f.content : Buffer.from(f && f.content && f.content.data ? f.content.data : []) }));
        return siteOf(files);
      },
    });

    // ---- the live screen: the operator card and the sign-in card (R031-88, R031-91) ---------------------------------------------------------------------------------------------------
    // A computer's live screen is Glass (the card in the app draws it and takes it over); this side only keeps what the CARD says: which computer, what it is doing now (the newest receipt, in words), the last
    // few steps, and a sign-in waiting for the person. In memory: a restart ends the wait, the agent asks again. Whoever drives the computer (Vyre Computer's tools) calls these.
    /** @type {Map<string, { id: string, computer: string, thread: string | null, title: string, state: string, line: string, ask: string, reply: string, steps: { line: string, state: string }[], at: number, waiters: Set<() => void> }>} */
    const operators = new Map();
    /** @type {Map<string, { id: string, computer: string, thread: string | null, site: string, why: string, state: "waiting"|"done"|"cancelled"|"expired", at: number, waiters: Set<() => void> }>} */
    const signins = new Map();
    const STEP_STATES = ["working", "done", "stuck", "paused"];
    const COMPUTER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
    // the event freezes its payload, so it gets a copy of the steps: the run keeps adding to its own
    const operatorCard = (/** @type {any} */ o) => { if (o.thread) emit("thread.operator", { run: o.id, computer: o.computer, title: o.title, state: o.state, line: o.line, ask: o.ask || "", steps: o.steps.map((/** @type {any} */ x) => ({ ...x })) }, { thread: o.thread }); };
    const signinCard = (/** @type {any} */ s) => { if (s.thread) emit("thread.signin", { id: s.id, computer: s.computer, site: s.site, why: s.why, state: s.state }, { thread: s.thread }); };
    const threadOf = (/** @type {any} */ i, /** @type {any} */ meta, /** @type {boolean} */ trusted) => (trusted && i.thread ? String(i.thread) : (meta && meta.thread) || null);
    const asker = (/** @type {any} */ meta) => ({ person: isPerson(meta), module: String((meta && meta.caller) || "").startsWith("module:") });

    ctx.tool("previews.operator", {
      description: "Show a computer's live screen as a card in this chat: { computer, title? }. Returns { run }; narrate with previews.step.",
      input: obj({ computer: str, title: str, run: str, thread: str }, ["computer"]), callers: [...PERSON_ONLY, "module", "mcp", "harness", "agent"],
      run: async (/** @type {any} */ i, /** @type {any} */ meta) => {
        if (!COMPUTER.test(String(i.computer || ""))) throw refuse("name the computer, as Glass lists it", "bad_input");
        const a = asker(meta);
        const existing = i.run ? operators.get(String(i.run)) : null;
        if (existing) { operatorCard(existing); return { run: existing.id, state: existing.state }; }
        const id = crypto.randomBytes(6).toString("hex");
        const o = { id, computer: String(i.computer), thread: threadOf(i, meta, a.person || a.module), title: String(i.title || `${i.computer}'s computer`).replace(/\s+/g, " ").trim().slice(0, 120), state: "working", line: "Getting started", ask: "", reply: "", steps: [], at: now(), waiters: new Set() };
        operators.set(id, o);
        for (const [k, v] of operators) if (now() - v.at > 6 * 3_600_000) operators.delete(k);
        operatorCard(o);
        return { run: id, state: o.state };
      },
    });

    ctx.tool("previews.step", {
      description: "Say what the computer is doing now, in plain words: { run, line, state? } (working, done, stuck, paused). Stuck may add `ask`.",
      input: obj({ run: str, line: str, state: { type: "string", enum: STEP_STATES }, ask: str }, ["run", "line"]), callers: [...PERSON_ONLY, "module", "mcp", "harness", "agent"],
      run: async (/** @type {any} */ i, /** @type {any} */ meta) => {
        const o = operators.get(String(i.run));
        if (!o) throw refuse("no such run: start one first", "not_found");
        // A model may only move a card of its own chat.
        if (!isPerson(meta) && !String((meta && meta.caller) || "").startsWith("module:") && o.thread !== ((meta && meta.thread) || null)) throw refuse("no such run: give the id the run was started with", "not_found");
        const line = String(i.line || "").replace(/\s+/g, " ").trim().slice(0, 160);
        if (!line) throw refuse("say what it is doing", "bad_input");
        const state = STEP_STATES.includes(i.state) ? i.state : "working";
        if (o.steps.length && o.steps[o.steps.length - 1].state === "working") o.steps[o.steps.length - 1].state = "done";
        o.steps.push({ line, state }); o.steps = o.steps.slice(-7);
        o.line = line; o.state = state; o.at = now();
        // A stuck run may say what it needs typed (a code, an answer): the card shows a box for it; the person's reply is read with previews.run-get.
        o.ask = state === "stuck" && typeof i.ask === "string" ? i.ask.replace(/\s+/g, " ").trim().slice(0, 120) : "";
        if (state !== "stuck") o.reply = "";
        operatorCard(o);
        return { run: o.id, state: o.state };
      },
    });

    ctx.tool("previews.reply", {
      description: "The person types what a stuck run asked for (a code, an answer) on its card: { run, text }. The run reads it with previews.run-get. A person at their own surface; never a model.",
      input: obj({ run: str, text: str }, ["run", "text"]), callers: PERSON_ONLY,
      run: async (/** @type {any} */ i, /** @type {any} */ meta) => {
        if (!isPerson(meta)) throw refuse("only a person at their own surface answers", "denied");
        const o = operators.get(String(i.run));
        if (!o) throw refuse("no such run: give the id the run was started with", "not_found");
        const text = String(i.text || "").trim().slice(0, 500);
        if (!text) throw refuse("type the answer", "bad_input");
        o.reply = text; o.state = "working"; o.line = "Got your answer"; o.ask = ""; o.at = now();
        operatorCard(o);
        o.waiters.forEach(w => w());
        return { run: o.id, state: o.state };
      },
    });
    ctx.tool("previews.run-get", {
      description: "State of a run you started: { run, state, reply? }. `reply` is what the person typed when you were stuck; wait_ms waits for it.",
      input: obj({ run: str, wait_ms: { type: "integer" } }, ["run"]), callers: [...PERSON_ONLY, "module", "mcp", "harness", "agent"],
      run: async (/** @type {any} */ i, /** @type {any} */ meta) => {
        const o = operators.get(String(i.run));
        if (!o) throw refuse("no such run: give the id the run was started with", "not_found");
        if (!isPerson(meta) && !String((meta && meta.caller) || "").startsWith("module:") && o.thread !== ((meta && meta.thread) || null)) throw refuse("no such run: give the id the run was started with", "not_found");
        const ms = Math.min(Math.max(Number(i.wait_ms) || 0, 0), 55_000);
        if (ms && !o.reply && o.state === "stuck") await new Promise(resolve => { const done = () => { clearTimeout(t); o.waiters.delete(done); resolve(undefined); }; const t = setTimeout(done, ms); o.waiters.add(done); });
        return { run: o.id, state: o.state, ...(o.reply ? { reply: o.reply } : {}) };
      },
    });
    ctx.tool("previews.frame", {
      description: "A small still of a run's computer for its card: { image (base64 JPEG), mime, at }, or { image: null, why }. A person at their own surface; a Mac's pixels never leave the Mac, so a Mac has none here.",
      input: obj({ run: str, maxWidth: { type: "integer" } }, ["run"]), callers: PERSON_ONLY,
      run: async (/** @type {any} */ i, /** @type {any} */ meta) => {
        await needPerson(meta);
        const o = operators.get(String(i.run));
        if (!o) throw refuse("no such run: give the id the run was started with", "not_found");
        const r = await ctx.call("sight.frame", { target: `agent:${o.computer}`, maxWidth: Math.min(Math.max(Number(i.maxWidth) || 640, 160), 1280) });
        if (r.error) return { image: null, why: r.error.code === "local_only" ? "mac" : r.error.code === "no_such_tool" ? "none" : "later" };
        return { image: r.data.image || null, mime: r.data.mime || "image/jpeg", at: r.data.at || now(), ...(r.data.image ? {} : { why: r.data.why || "none" }) };
      },
    });

    ctx.tool("previews.signin", {
      description: "Ask the person to sign in to a site on the computer, as a card: computer, site, why. You never see the password. Poll previews.signin-get.",
      input: obj({ computer: str, site: str, why: str, thread: str, wait_ms: { type: "integer" } }, ["computer", "site"]), callers: [...PERSON_ONLY, "module", "mcp", "harness", "agent"],
      run: async (/** @type {any} */ i, /** @type {any} */ meta) => {
        if (!COMPUTER.test(String(i.computer || ""))) throw refuse("name the computer, as Glass lists it", "bad_input");
        const site = String(i.site || "").replace(/\s+/g, " ").trim().slice(0, 80);
        if (!site) throw refuse("name the site to sign in to", "bad_input");
        if ([...signins.values()].filter(x => x.state === "waiting").length >= 10) throw refuse("too many sign-ins are waiting: wait for one to be answered, then ask again", "rate_limited");
        const a = asker(meta);
        const s = { id: crypto.randomBytes(6).toString("hex"), computer: String(i.computer), thread: threadOf(i, meta, a.person || a.module), site, why: String(i.why || "").replace(/\s+/g, " ").trim().slice(0, 200), state: /** @type {"waiting"} */ ("waiting"), at: now(), waiters: new Set() };
        signins.set(s.id, s);
        signinCard(s);
        await waitFor(s, Number(i.wait_ms) || 0);
        return { id: s.id, state: s.state };
      },
    });
    /** @param {any} s @param {number} ms */
    const waitFor = (s, ms) => new Promise(resolve => {
      if (s.state !== "waiting" || ms <= 0) return resolve(undefined);
      const done = () => { clearTimeout(t); s.waiters.delete(done); resolve(undefined); };
      const t = setTimeout(done, Math.min(ms, 55_000));
      s.waiters.add(done);
    });
    ctx.tool("previews.signin-get", {
      description: "Whether the person has finished signing in: { id, state } (waiting, done, cancelled, expired). With wait_ms (at most 55 s) it waits.", input: obj({ id: str, wait_ms: { type: "integer" } }, ["id"]),
      callers: [...PERSON_ONLY, "module", "mcp", "harness", "agent"],
      run: async (/** @type {any} */ i) => {
        const s = signins.get(String(i.id));
        if (!s) throw refuse("no such sign-in: give the id the sign-in request returned", "not_found");
        if (s.state === "waiting" && now() - s.at > 30 * 60_000) { s.state = "expired"; signinCard(s); }
        await waitFor(s, Number(i.wait_ms) || 0);
        return { id: s.id, state: s.state };
      },
    });
    ctx.tool("previews.signin-done", {
      description: "The person has signed in (or put the card away): { id, done? }. A person at their own surface.", input: obj({ id: str, done: { type: "boolean" } }, ["id"]), callers: PERSON_ONLY,
      run: async (/** @type {any} */ i, /** @type {any} */ meta) => {
        if (!isPerson(meta)) throw refuse("only a person at their own surface does this", "denied");
        const s = signins.get(String(i.id));
        if (!s) throw refuse("no such sign-in: give the id the sign-in request returned", "not_found");
        if (s.state === "waiting") { s.state = i.done === false ? "cancelled" : "done"; signinCard(s); s.waiters.forEach(w => w()); }
        return { id: s.id, state: s.state };
      },
    });

    // ---- restore -----------------------------------------------------------------------------------------------------------------------------------------------------------------------------
    // What Vyre kept running comes back with it; an agent's own server is looked at (its port may still answer) and left as it is.
    for (const r of db.prepare("SELECT * FROM previews_items").all()) {
      if (r.mode === "supervised" && r.wanted === 1 && r.command && r.cwd && fs.existsSync(r.cwd)) {
        sup.start(r.id, { command: r.command, cwd: r.cwd, port: r.upstream, env: seam.env || {} });
      } else if (r.source === "files") {
        // A folder served by this module comes back with it, on this start's own port.
        db.prepare("UPDATE previews_items SET upstream = ? WHERE id = ?").run(staticPort(), r.id);
        if (r.root && fs.existsSync(r.root) && r.state !== "stopped") setState(r.id, "live"); else if (!r.root || !fs.existsSync(r.root)) setState(r.id, "stopped", "its folder is gone");
      } else if (r.mode === "session") {
        answers(r.upstream).then(up => setState(r.id, up ? "live" : "stopped")).catch(() => setState(r.id, "stopped"));
      }
    }

    return { async stop() { bridge.closeAll(); staticSrv.close(); /** @type {any} */ (staticSrv).closeAllConnections?.(); sup.shutdown(); for (const x of signins.values()) x.waiters.forEach(w => w()); } };
  },
};
