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
import { isPerson } from "../../lib/caller.js";
import { createSupervisor, lease, answers } from "./supervisor.js";
import { mayOpen, mayManage, ACCESS } from "./access.js";

const str = { type: "string" };
const obj = (/** @type {any} */ properties, required = []) => ({ type: "object", properties, required });
const refuse = (/** @type {string} */ message, /** @type {string} */ code) => Object.assign(new Error(message), { code });
const PERSON_ONLY = ["cli", "local", "deck", "capsule", "tailnet", "device", "mobile"];

export const MIGRATIONS = [
  `CREATE TABLE previews_items (
     id TEXT PRIMARY KEY, space TEXT, project TEXT, thread TEXT, title TEXT NOT NULL, source TEXT NOT NULL, mode TEXT NOT NULL,
     command TEXT, cwd TEXT, port INTEGER, upstream INTEGER, state TEXT NOT NULL, error TEXT, access TEXT NOT NULL, created_by TEXT,
     created INTEGER NOT NULL, updated INTEGER NOT NULL, wanted INTEGER NOT NULL DEFAULT 1
   );
   CREATE INDEX previews_items_thread ON previews_items (thread);
   CREATE INDEX previews_items_project ON previews_items (project);`,
];

/** The preview's name on the front: pv- and eight hex digits. */
export const nameOf = (/** @type {string} */ id) => `pv-${id}`;
const ID = /^[0-9a-f]{8}$/;

/** @type {{ start(ctx: any, seam?: any): Promise<{ stop(): Promise<void> }> }} */
export default {
  async start(ctx, seam = {}) {
    ctx.store.migrate(MIGRATIONS);
    const db = ctx.store.db;
    const now = seam.now || Date.now;
    const emit = (/** @type {string} */ type, /** @type {any} */ payload) => { try { ctx.events.emit(type, payload); } catch { /* an event nobody hears */ } };

    const view = (/** @type {any} */ r, detail = false) => ({
      id: r.id, title: r.title, source: r.source, mode: r.mode, state: r.state, access: r.access, thread: r.thread || null, project: r.project || null,
      created_by: r.created_by || null, created: r.created, updated: r.updated, ...(r.error ? { error: r.error } : {}),
      ...(detail ? { command: r.command || null, cwd: r.cwd || null, port: r.upstream || r.port || null } : {}),
    });
    const row = (/** @type {string} */ id) => db.prepare("SELECT * FROM previews_items WHERE id = ?").get(String(id));
    const mustRow = (/** @type {string} */ id) => { const r = row(id); if (!r) throw refuse("no such preview", "not_found"); return r; };
    const setState = (/** @type {string} */ id, /** @type {string} */ state, error = "") => {
      const r = row(id); if (!r) return;
      db.prepare("UPDATE previews_items SET state = ?, error = ?, updated = ? WHERE id = ?").run(state, error || null, now(), id);
      emit("preview.state", { id, state, title: r.title, thread: r.thread || null, project: r.project || null, ...(error ? { error } : {}) });
    };

    const sup = seam.supervisor || createSupervisor({
      log: (/** @type {string} */ m) => ctx.log.warn(m),
      onState: (/** @type {string} */ id, /** @type {string} */ state, /** @type {{ error?: string }} */ info) => setState(id, state, info.error || ""),
    });

    // ---- who ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
    /** The person behind a call and their role in this Space: { id, role }, or null for anyone who is not a person. @param {any} meta */
    const whoIs = async meta => {
      if (!isPerson(meta)) return null;
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

    // ---- tools -----------------------------------------------------------------------------------------------------------------------------------------------------------------------------
    ctx.tool("previews.open", {
      description: "Show the person something running: a web page or app your server serves on a port. Call it after you start a dev server or an app, with { port, title }. A card appears in this chat; the person opens it on its own address, and can share it with the project or team. Say `command` (how you started it) so Vyre can offer to keep it running after this session ends. Returns { id, state }.",
      input: obj({ title: str, port: { type: "integer" }, command: str, cwd: str, thread: str, project: str, access: { type: "string", enum: [...ACCESS] } }, ["title"]),
      callers: [...PERSON_ONLY, "module", "mcp", "harness", "agent"],
      run: async (/** @type {any} */ i, /** @type {any} */ meta) => {
        const person = await whoIs(meta);
        const byModel = !person && !String((meta && meta.caller) || "").startsWith("module:");
        const title = String(i.title || "").trim().slice(0, 80) || "Preview";
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
        const access = ACCESS.includes(i.access) ? i.access : i.project ? "project" : "me";
        db.prepare(`INSERT INTO previews_items (id, space, project, thread, title, source, mode, command, cwd, port, upstream, state, access, created_by, created, updated, wanted)
          VALUES (?,?,?,?,?, 'port', ?, ?, ?, ?, ?, 'starting', ?, ?, ?, ?, ?)`)
          .run(id, ctx.space || null, i.project ? String(i.project) : null, i.thread ? String(i.thread) : (meta && meta.thread) || null, title, wantsCommandRun ? "supervised" : "session", i.command ? String(i.command).slice(0, 2000) : null, cwd,
            Number.isInteger(i.port) ? i.port : null, Number.isInteger(i.port) ? i.port : null, access, creator, t, t, wantsCommandRun ? 1 : 0);
        emit("preview.opened", { id, title, thread: (meta && meta.thread) || i.thread || null, project: i.project || null });
        if (wantsCommandRun) await runSupervised(row(id));
        else setState(id, (await answers(i.port)) ? "live" : "starting");
        void byModel;
        return { id, state: row(id).state, preview: view(row(id)), message: `${title} is a preview now: a card is in the chat, and the person opens it from there. ${Number.isInteger(i.port) ? "It lasts as long as your server does." : ""}`.trim() };
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
        if (who && !mayOpen(r, who) && !mayManage(r, who)) throw refuse("no such preview", "not_found");
        return { preview: view(r, Boolean(who)) };
      },
    });

    ctx.tool("previews.url", {
      description: "The address to open a preview at: { url }, on its own origin, with a one-time sign-in that is good for a minute. A person who may open it, at their own surface.",
      input: obj({ id: str, origin: str }, ["id"]), callers: PERSON_ONLY,
      run: async (/** @type {any} */ i, /** @type {any} */ meta) => {
        const who = await needPerson(meta); const r = mustRow(i.id);
        if (!mayOpen(r, who) && !mayManage(r, who)) throw refuse("no such preview", "not_found");
        if (r.state === "stopped" || r.state === "crashed") throw refuse(r.state === "stopped" ? "it is stopped: restart it first" : "it is not running: restart it, or look at its log", "unavailable");
        const t = await ctx.call("appmods.ticket", { name: nameOf(r.id), ...(i.origin ? { origin: i.origin } : {}) });
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
        if (!r.command || !r.cwd || !path.isAbsolute(r.cwd) || !fs.existsSync(r.cwd)) throw refuse("Vyre does not know how this was started, so it cannot keep it running", "unavailable");
        db.prepare("UPDATE previews_items SET upstream = NULL WHERE id = ?").run(r.id);
        await runSupervised(row(r.id));
        return { preview: view(row(r.id)) };
      },
    });

    ctx.tool("previews.restart", {
      description: "Restart a preview Vyre keeps running.", input: obj({ id: str }, ["id"]), callers: PERSON_ONLY,
      run: async (/** @type {any} */ i, /** @type {any} */ meta) => {
        const { r } = await manage(i.id, meta);
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
        await ctx.call("appmods.drop", { name: nameOf(r.id) }).catch(() => {});
        return { preview: view(row(r.id)) };
      },
    });

    ctx.tool("previews.remove", {
      description: "Remove a preview: stop it and forget it.", input: obj({ id: str }, ["id"]), callers: PERSON_ONLY,
      run: async (/** @type {any} */ i, /** @type {any} */ meta) => {
        const { r } = await manage(i.id, meta);
        sup.forget(r.id);
        db.prepare("DELETE FROM previews_items WHERE id = ?").run(r.id);
        await ctx.call("appmods.drop", { name: nameOf(r.id) }).catch(() => {});
        emit("preview.removed", { id: r.id, thread: r.thread || null, project: r.project || null });
        return { removed: r.id };
      },
    });

    ctx.tool("previews.log", {
      description: "The last lines of a preview's output (what its server printed), for the person looking at why it does not work.", input: obj({ id: str, lines: { type: "integer" } }, ["id"]), callers: PERSON_ONLY,
      run: async (/** @type {any} */ i, /** @type {any} */ meta) => {
        const w = await needPerson(meta); const r = mustRow(i.id);
        if (!mayOpen(r, w) && !mayManage(r, w)) throw refuse("no such preview", "not_found");
        return { log: sup.tail(r.id, Math.min(Number(i.lines) || 200, 1000)), supervised: r.mode === "supervised" };
      },
    });

    ctx.tool("previews.share", {
      description: "Who may open a preview: me (only you), project (the people of its project) or team (everyone in the Space). Taking access away signs out whoever had it open. Anyone-with-the-link waits for the public ingress.",
      input: obj({ id: str, access: { type: "string", enum: [...ACCESS, "public"] } }, ["id", "access"]), callers: PERSON_ONLY,
      run: async (/** @type {any} */ i, /** @type {any} */ meta) => {
        if (i.access === "public") throw refuse("sharing with anyone who has the link is not available yet: it needs the public door, which comes with Publish", "unavailable");
        const { r } = await manage(i.id, meta);
        db.prepare("UPDATE previews_items SET access = ?, updated = ? WHERE id = ?").run(i.access, now(), r.id);
        if (ACCESS.indexOf(i.access) < ACCESS.indexOf(r.access)) await ctx.call("appmods.drop", { name: nameOf(r.id) }).catch(() => {});
        emit("preview.state", { id: r.id, state: r.state, title: r.title, thread: r.thread || null, project: r.project || null, access: i.access });
        return { preview: view(row(r.id)) };
      },
    });

    ctx.tool("previews.resolve", {
      description: "Where a preview's host leads, for the front: { origin }. Internal: the appmods module only.", internal: true,
      input: obj({ name: str }, ["name"]), callers: ["module"],
      run: async (/** @type {any} */ i, /** @type {any} */ meta) => {
        if (!meta || meta.caller !== "module:appmods") throw refuse("the front alone asks where a preview leads", "denied");
        const m = /^pv-([0-9a-f]{8})$/.exec(String(i.name));
        const r = m && ID.test(m[1]) ? row(m[1]) : null;
        if (!r || !r.upstream || r.state === "stopped" || r.state === "crashed") return { origin: null };
        return { origin: `http://127.0.0.1:${r.upstream}` };
      },
    });

    // ---- restore -----------------------------------------------------------------------------------------------------------------------------------------------------------------------------
    // What Vyre kept running comes back with it; an agent's own server is looked at (its port may still answer) and left as it is.
    for (const r of db.prepare("SELECT * FROM previews_items").all()) {
      if (r.mode === "supervised" && r.wanted === 1 && r.command && r.cwd && fs.existsSync(r.cwd)) {
        sup.start(r.id, { command: r.command, cwd: r.cwd, port: r.upstream, env: seam.env || {} });
      } else if (r.mode === "session") {
        answers(r.upstream).then(up => setState(r.id, up ? "live" : "stopped")).catch(() => setState(r.id, "stopped"));
      }
    }

    return { async stop() { sup.shutdown(); } };
  },
};
