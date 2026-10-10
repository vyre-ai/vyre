// @ts-check
// runner: the module around core/runner's library. It adds nothing of its own: every call goes to a createRunner()
// per space, and the three things it needs from other teams arrive as ports (vault, space sync, grants). Until those
// teams land the real ones, the ports are absent and runner.status says so in plain words.

import { createRunner, reconcile } from "./runner.js";
import { unavailable } from "./sandbox.js";
import { workspaceUnavailable } from "./workspace.js";
import { createTurnSeal } from "./ownserver.js";
import { createFolders } from "./folders.js";
import { createResumeLent } from "./resume-lent.js";
import { startPreviewPump } from "./preview-pump.js";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { createLenderHost } from "./lender-host.js";
import { registerPlaceTools, settingsReader, SETTING_DEFAULTS } from "./place-tools.js";
import { startPump } from "./pipe-pump.js";
import { within, withinOrThrow } from "../../lib/within.js";
/** The folder this Vyre is installed in: its MCP server (harness/mcp/run.js) is what a chat's session on this computer talks to. */
const VYRE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
/** Where this install's node_modules really are, when they are a link to another folder (a checkout): the MCP server in the sandbox must read them too. */
const harnessThere = () => { try { return fs.existsSync(path.join(VYRE_ROOT, "harness", "hooks", "run.js")); } catch { return false; } };
const realModules = () => { try { const m = path.join(VYRE_ROOT, "node_modules"), r = fs.realpathSync(m); return r === m ? [] : [r]; } catch { return []; } };
import { hereBlock, deviceState } from "./placement.js";
import { HEARTBEAT_MS } from "./placement-book.js";
import { BEAT_MAX } from "./lent-home.js";
import { createMover, sleepReason } from "./mover.js";

/** Test and wiring seam, keyed by the module's root folder: { ports: { vault, sync, grants, server, requestServer }, platform }. */
export const seams = new Map();

/**
 * The caller must be the person this device belongs to: never a module, a guest, an agent (not even the person's own assistant), or a chain carrying one.
 * With the kernel on, the person comes from `ctx.kernel.chain(meta)` and nothing else (a verified token's chain, or the facts the daemon proved about the connection):
 * a chain whose only hop is a person, no viewer chain, no agent or service hop. A caller label decides nothing: a web, setup or unknown `device:` label gets no chain and is refused.
 * SHIM(legacy labels): with the kernel off there is no chain, so the old label refusal stays until the cut-over removes it.
 */
const AGENT = /(?:^|[\s:])agent:/;
const denied = (c, what) => Object.assign(new Error(`"${c}" is not the person this computer belongs to; ${what} is theirs`), { code: "denied" });
const person = async (ctx, meta, what) => {
  const c = String((meta && meta.caller) || "");
  if (ctx.kernel && typeof ctx.kernel.chain === "function") {
    let chain = null;
    try { chain = await ctx.kernel.chain(meta || {}); } catch { chain = null; }
    const hops = chain && Array.isArray(chain.hops) ? chain.hops : [];
    if (!hops.length || chain.viewer === true || hops.some(h => !h || !h.actor || h.actor.kind !== "person")) throw denied(c, what);
    // The computer belongs to the home's owner: another member's person chain reaching this runner is not them (reviewer-2 RN-2). No known owner is a refusal.
    let owner = null; try { owner = typeof ctx.kernel.owner === "function" ? await ctx.kernel.owner() : ctx.kernel.owner; } catch { owner = null; }
    const id = String(hops[0].actor.id);
    if (!owner || String(owner) !== id) throw denied(c, what);
    return id;
  }
  if ((meta && (meta.agent || meta.assistant)) || AGENT.test(c) || /^(module|hook|anonymous|onboard|mcp|harness)\b/.test(c) || c.startsWith("tailnet:guest")) throw denied(c, what);
  return null;
};
const obj = (properties = {}, required = []) => ({ type: "object", properties, required });
const str = { type: "string" };

/**
 * The program a Space's definition names, on THIS computer. A name with no folder in it ("claude") is the agent the person has here: `VYRE_CLAUDE_BIN`, else the program of that name on PATH; the Space never
 * names a path on a computer it cannot see. A script (.js) runs under this computer's node. Its folder (and node's) is readable inside the sandbox, nothing else is added.
 * @param {{ command: string, args?: string[], readOnly?: string[] }} spec
 */
export function resolveAgent(spec) {
  const args = Array.isArray(spec.args) ? spec.args : [];
  const ro = Array.isArray(spec.readOnly) ? spec.readOnly : [];
  if (spec.command.includes("/")) return { command: spec.command, args, readOnly: ro };
  let bin = spec.command === "claude" && process.env.VYRE_CLAUDE_BIN ? process.env.VYRE_CLAUDE_BIN : "";
  if (!bin) for (const d of String(process.env.PATH || "").split(path.delimiter)) { const f = path.join(d, spec.command); try { fs.accessSync(f, fs.constants.X_OK); bin = f; break; } catch { /* next */ } }
  if (!bin) throw Object.assign(new Error(`this computer has no ${spec.command} to run the session with`), { code: "unavailable" });
  const dirs = [...new Set([path.dirname(bin), ...ro])];
  if (bin.endsWith(".js")) return { command: process.execPath, args: [bin, ...args], readOnly: [...new Set([...dirs, path.dirname(process.execPath)])] };
  return { command: bin, args, readOnly: dirs };
}

export default {
  async start(ctx) {
    const seam = (ctx.paths && seams.get(ctx.paths.root)) || {};
    // What the host (the daemon, through the kernel handle) gives the runner: ready `ports`, or the pieces to build them (`runnerPorts`), or this computer's identity alone
    // (`identity()` -> { deviceId, deviceKey }), from which the runner builds one lender host per Space whose home is another computer, over the kernel's remote call
    // (`ctx.kernel.for(space).call`: the one remote path). Until the host gives anything, building throws: that is "not connected yet", never a module that fails to start (walk step 11, 4 Oct).
    const hostOf = () => { try { return ctx.kernel?.runnerHost?.() || null; } catch { return null; } };
    const lenders = new Map();
    /** @type {() => any} the ports for ONE Space, built without asking for a Space (the test seam and the kernel's own pieces) */
    const ports = () => {
      if (seam.ports) return seam.ports;
      try { const h = hostOf(); return (h && h.ports) || (h && !h.identity && ctx.kernel?.runnerPorts?.(h)) || null; } catch { return null; }
    };
    const portsFor = async space => {
      const p = ports(); if (p) return p;
      const h = hostOf(); if (!h || typeof h.identity !== "function") return null;
      if (ctx.config && ctx.config.role === "box") return null;   // a server seals its own sessions (below); lending a computer to a Space is a person's computer
      let l = lenders.get(space);
      if (!l) {
        const k = ctx.kernel?.for?.(space);
        if (!k || typeof k.call !== "function") return null;   // a Space this computer hosts itself: not lent over a wire
        const mine = await h.identity();   // this computer has claimed an identity (it may lend at all)
        // The Offers for this computer are made under the id the Space's home gives it, read from what the transport proved: the home answers it, this computer never chooses it.
        const me = await k.call("lent.whoami", []);
        if (!me || typeof me.device !== "string" || !me.device) throw Object.assign(new Error("the Space's home did not say which computer this is: reconnect this computer to the home and try again"), { code: "unavailable" });
        l = createLenderHost({ invoke: k.call, deviceId: me.device, deviceKey: me.device, ...(mine && typeof mine.deviceId === "string" && mine.deviceId ? { eid: mine.deviceId } : {}), ...(h.lenderCap ? { lenderCap: h.lenderCap } : {}) });
        await l.ready; lenders.set(space, l); nudgeLoop(space);
        l.ports.onRevoke(async () => { const r = runners.get(space); if (r) { try { await r.revoke(); } catch {} runners.delete(space); } });
        // the home took a session of this computer (it moved, or this computer went quiet): stop it here, writing nothing more
        l.ports.onFenced(session => { const r = runners.get(space); if (r) r.fence(session).catch(() => {}); });
      }
      return l.ports;
    };
    const hasHost = () => Boolean(seam.ports || (hostOf() && !(ctx.config && ctx.config.role === "box")));
    // A workspace left open by a runner that died must not stay readable: close any nobody holds a lease for.
    try { await reconcile({ base: ctx.paths.root + "/runner", platform: seam.platform }); } catch {}
    /** @type {Map<string, any>} one runner per space */
    const runners = new Map();
    /** The folders of this computer the person approved for chats (folders.js): the home only ever hears their ids and labels. */
    const folders = createFolders(path.join(ctx.paths.root, "runner", "folders.json"), seam.home ? { home: seam.home } : {});
    /** The pump of each chat process on this computer (lent spawn), until the home has heard it end. @type {Map<string, { done: Promise<void> }>} */ const pumps = new Map();
    const emit = (space, e) => {
      try { ctx.events.emit(`runner.${e.type === "checkpoint" ? "checkpoint" : e.type}`, { space, ...e }); } catch {}
      if (e.type === "stopped") endOnHome(space, e.session, e.why);
    };
    // A session that ends tells the Space's home, or the home would count its silence and take it back to life on the server twenty seconds later. The person stopped it, or the program finished: the home forgets
    // it. The program died: its chat hears the exit it really had, then the home takes it from the last whole turn (reason crash). Handed over or fenced: the home already knows.
    const endOnHome = (/** @type {string} */ space, /** @type {string} */ session, /** @type {string} */ why) => {
      const p = lenders.get(space)?.ports; if (!p) return;
      // a chat's process (lent spawn) says how it ended through its pump first, so the SDK hears the exit it really had; the home forgetting the session comes after
      if (why === "stopped" || why === "finished") { const pump = pumps.get(session); within(pump ? pump.done : null, 10_000).then(() => p.stop?.(session)).catch(() => {}); }
      else if (why === "crashed") { const pump = pumps.get(session); within(pump ? pump.done : null, 10_000).then(() => p.requestServer?.(space, session, "crash")).catch(() => {}); }   // the SDK hears the exit code the program really had, then the home takes the session (reason crash) to carry on from the last whole turn
    };
    const forSpace = async space => {
      const p = await portsFor(space);
      if (p && (typeof p.device !== "string" || !p.device)) throw Object.assign(new Error("the runner needs this computer's device key identity"), { code: "unavailable" });
      if (!p) throw Object.assign(new Error("running a space's work here is not connected yet: the space's vault and sync are not available; pair this computer with the space's home first"), { code: "unavailable" });
      let r = runners.get(space);
      if (!r) {
        r = createRunner({ platform: seam.platform, base: ctx.paths.root + "/runner", space, device: p.device, vault: p.vault, sync: p.sync, seedFile: async (/** @type {string} */ work, /** @type {string} */ cwd, /** @type {string} */ session) => { try { const x = /** @type {any} */ (await ctx.call("threads.work-transcript", { work, cwd, session })); return x && x.data && x.data.file ? String(x.data.file) : null; } catch { return null; } },
          grants: () => p.grants(space), ...(p.lenderCap ? { lenderCap: p.lenderCap } : {}), server: () => p.server?.(space), requestServer: (s, reason) => p.requestServer?.(space, s, reason), limits: () => ({ onlyOnPower: limits.pluggedInOnly }), ...(seam.now ? { now: seam.now } : {}), ...(seam.state ? { state: seam.state } : {}), onEvent: e => emit(space, e) });
        runners.set(space, r);
      }
      return r;
    };

    ctx.tool("runner.status", {
      description: "Whether this computer can run a space's sessions, and what is running here.",
      input: obj(),
      run: async () => {
        const why = unavailable(seam.platform) || workspaceUnavailable(seam.platform, { base: ctx.paths.root + "/runner" });
        if (ctx.config && ctx.config.role === "box") return { ready: false, why: "this server seals its own sessions at every turn; running a Space's work is for a person's computer", ownServer: Boolean(ownServerOf()), spaces: [] };
        let ident = ""; const h = !why && !seam.ports ? hostOf() : null;
        if (h && typeof h.identity === "function") { try { await h.identity(); } catch (e) { ident = String(/** @type {any} */ (e).message || "this computer has no device identity yet"); } }
        return { ready: !why && hasHost() && !ident, why: why || ident || (hasHost() ? "" : "the space's vault and sync are not connected yet"), spaces: [...runners].map(([space, r]) => { const { dir, ...rest } = r.status(); return { space, ...rest }; }) };
      },
    });
    ctx.tool("runner.place", {
      description: "Where a session in this space would run now: here, the server or waiting, with the reason in words.",
      input: obj({ space: str, pinned: { type: "boolean" } }, ["space"]),
      run: async ({ space, pinned }) => (await forSpace(space)).decide({ pinnedToServer: Boolean(pinned) }),
    });
    /** The limits the person set for this computer, as last read. */
    const limits = { ...SETTING_DEFAULTS };
    const readSettings = settingsReader(key => ctx.call("settings.get", { key }));
    const refreshSettings = async () => { Object.assign(limits, await readSettings()); return limits; };
    /** Is running here switched on? A settings module that has never answered gives no switch to honour (nothing moves for want of one); one that answers is believed. */
    const enabledNow = () => !readSettings.known() || limits.enabled;
    /** Titles of the chats the sessions here belong to, as the home told this computer when it lent them. @type {Map<string, string>} */ const titles = new Map();
    /** Start (or resume) a session here: the Space's own definition says what runs. Both the person's tool and the home's "start it" (the person brought a session back) come here. */
    const startSession = async (space, { session, resume, chat }) => {
      await refreshSettings();
      if (!enabledNow()) throw Object.assign(new Error("Running sessions on this computer is switched off. Turn it on in Settings, This computer."), { code: "refused" });
      for (const r0 of runners.values()) if (r0.paused) throw Object.assign(new Error("Sessions on this computer are paused: resume them first."), { code: "conflict" });
      const p = await portsFor(space); const r = await forSpace(space);
      // The key lease is taken first: the home binds the session's credential routes to the lease it is given, so a definition asked for before the lease would map nothing.
      await r.open();
      const spec = await p.spec({ space, session, ...(chat ? { chat } : {}), ...(p.lenderCap ? { cap: p.lenderCap } : {}) });
      if (spec && spec.skew) throw Object.assign(new Error("This Mac runs an older Vyre than this Space needs, so the session runs on the server. Update Vyre on this Mac, then bring it back."), { code: "unavailable" });
      if (!spec || !spec.command || !Array.isArray(spec.routes)) throw Object.assign(new Error("the space has no definition for that session: check the session id, or ask the space's owner"), { code: "not_found" });
      if (typeof spec.title === "string" && spec.title) titles.set(session, spec.title);
      let h;
      try {
        const run = resolveAgent(spec);
        // a chat given one of this computer's folders works in it and goes nowhere: the id is the home's, the path is only ever this computer's
        const folder = spec.folder ? folders.resolve(String(spec.folder)) : null;
        // a chat's session (lent spawn) gets Vyre's tools through the home: the runner's door in the sandbox, and Vyre's own MCP server beside Claude
        const vyre = spec.vyre === true && typeof p.http === "function" ? { call: (/** @type {any} */ q) => p.http({ session, ...q }), entry: path.join(VYRE_ROOT, "harness", "mcp", "run.js"), root: VYRE_ROOT, also: realModules(), ...(harnessThere() ? { plugin: path.join(VYRE_ROOT, "harness") } : {}) } : undefined;
        h = await r.start({ session, resume: Boolean(resume), ...(folder ? { folder } : {}), ...(spec.preview === true && spec.pipe === true ? { preview: true } : {}), ...(spec.seed ? { seed: spec.seed } : {}), ...(chat ? { chat } : {}), command: run.command, args: run.args, env: spec.env, routes: spec.routes, readOnly: run.readOnly, labels: spec.labels, network: spec.network, ...(vyre && fs.existsSync(vyre.entry) ? { vyre } : {}) });
      } catch (e) {
        // A start refused because the session is already running or being started here is that other start's business: nothing is told. Any other failure leaves the home believing the session runs on this computer
        // (it would be taken, as "offline", twenty seconds later), so it is told: a session that was resuming goes back to the server to carry on from its checkpoint, a new one is forgotten.
        if (!(e && /** @type {any} */ (e).code === "conflict") && !r.info().some((/** @type {any} */ x) => x.session === session)) {
          Promise.resolve(resume && !spec.folder ? p.requestServer?.(space, session, "crash") : p.stop?.(session)).catch(() => {});
        }
        throw e;
      }
      // A chat's process (lent spawn, contracts/lent-spawn.md): its bytes ride `lent.pipe` between the SDK on the home and this sandbox. The pump ends itself once the home has heard the process end.
      if (spec.pipe === true && typeof p.pipe === "function" && h.child) { const pump = startPump({ child: h.child, session, pipe: i => p.pipe(i), isFrozen: () => r.frozenNow, onFenced: () => { r.fence(session).catch(() => {}); }, onKill: () => { r.stop(session).catch(() => {}); } }); pumps.set(session, pump); pump.done.finally(() => { if (pumps.get(session) === pump) pumps.delete(session); }); }
      // a dev server the chat starts may be previewed from the home (lent.preview): the pump runs while the program does
      if (spec.pipe === true && spec.preview === true && typeof p.preview === "function" && h.child) {
        const pv = startPreviewPump({ session, poll: i => p.preview(i), run: job => r.previewRequest(session, job), onFenced: () => { r.fence(session).catch(() => {}); } });
        h.child.once("close", () => pv.stop());
      }
      return { session, pid: h.pid, resumed: h.resumed ? { turn: h.resumed.turn, seq: h.resumed.seq, state: h.resumed.state } : null };
    };
    ctx.tool("runner.start", {
      description: "Start a session here. The space's own definition of the session decides the program, the routes and the credentials it may use; the caller names only the space and the session. Needs both grants and a held key lease.",
      input: obj({ space: str, session: str, resume: { type: "boolean" }, chat: { ...str, description: "The chat this work belongs to (chat_<id>), so the chat can say where it runs." } }, ["space", "session"]),
      run: async ({ space, session, resume, chat }, meta) => {
        if (chat !== undefined && !(typeof chat === "string" && /^chat_[0-9a-f-]{36}$/.test(chat))) throw Object.assign(new Error("a chat is named by its id"), { code: "bad_input" });
        await person(ctx, meta, "starting a session here");
        return startSession(space, { session, resume, chat });
      },
    });
    // Where each chat's work runs, for the chips on a chat: on this server, or on a member's own computer, with its name and whether it is connected. Rows only for chats the caller is in (the kernel's own
    // list of a person's chats), so a chat id is never proof of anything: a caller sees where their own chats run and nothing else. A chat with no row runs on the server.
    ctx.tool("runner.places", {
      description: "Where the chats of a space run: the sessions lent to a computer, each with its chat, the computer's name and whether it is connected. Only your own chats.",
      input: obj({ space: str }, ["space"]),
      run: async ({ space }, meta) => {
        const h = hostOf(); const rows = h && typeof h.lentRows === "function" ? h.lentRows(String(space)) : [];
        const chain = await (typeof ctx.kernel?.chainIn === "function" ? ctx.kernel.chainIn(String(space), meta) : ctx.kernel.chain(meta));
        // any member sees where THEIR chats run: one person in the chain, no model or assistant; the owner check of starting a session here does not apply
        const hops = chain && Array.isArray(chain.hops) ? chain.hops : [];
        if (hops.length !== 1 || !hops[0].actor || hops[0].actor.kind !== "person") throw Object.assign(new Error("only a person sees where their chats run"), { code: "denied" });
        if (!rows.length) return { places: [] };
        const mine = typeof ctx.kernel?.chats?.mine === "function" ? new Set((await ctx.kernel.chats.mine(chain)).map((/** @type {any} */ c) => String(c.chat || c.id))) : new Set();   // no chat list: no row (fail closed)
        const devs = /** @type {any} */ (await ctx.call("relay.devices.all", {}).catch(() => null));
        const list = devs && devs.data && Array.isArray(devs.data.devices) ? devs.data.devices : [];
        return { places: rows.filter((/** @type {any} */ r) => r.chat && mine.has(r.chat)).map((/** @type {any} */ r) => { const d = list.find((/** @type {any} */ x) => x.id === r.device); return { chat: r.chat, session: r.session, computer: d ? String(d.name) : null, device: r.device, online: d ? Boolean(d.online) : false }; }) };
      },
    });
    /** What the place tools need from this module (place-tools.js); `moveThread` is added by them. @type {any} */
    const placeDeps = { person: (meta, what) => person(ctx, meta, what), hostOf, runners, platform: seam.platform || process.platform, readSettings: async () => { const v = await readSettings(); Object.assign(limits, v); return v; }, titles };
    registerPlaceTools(ctx, placeDeps);
    // The server carries a chat on from a person's computer (resume-lent.js): the home hands this tool the lender's view of the session; where the chat's transcript belongs comes from the Switchboard,
    // the server's own store from the host. The daemon's `resume` calls it; nothing else may.
    const resumeLent = createResumeLent({
      target: async thread => { const x = /** @type {any} */ (await ctx.call("threads.transcript-target", { thread })); return x && x.data ? x.data : null; },
      port: space => { try { return hostOf()?.ownServer?.port(space) || null; } catch { return null; } },
      say: (type, payload) => { try { ctx.events.emit(type, payload); } catch { /* a notice */ } },
    });
    ctx.tool("runner.resume-lent", { description: "Carry on a chat from the last whole turn its computer acknowledged. Internal: the daemon, when a lent session goes to the server.", internal: true, callers: ["module"],
      input: obj({ space: str, session: str, thread: str }, ["space", "session"]),
      run: async (i, meta) => {
        if (!meta || meta.caller !== "module:vyred") throw Object.assign(new Error("only the daemon carries a chat on"), { code: "denied" });
        const view = hostOf()?.lentView?.(String(i.space), String(i.session));
        if (!view) throw Object.assign(new Error("that session is not held here"), { code: "not_found" });
        return resumeLent({ ...i, view });
      } });
    // The folders of this computer a chat may be given. Adding one is the person's yes on this computer (a folder widens what a model can reach); the home hears ids and labels, never a path.
    ctx.tool("runner.folders", { description: "The folders of this computer you have approved for chats, each { id, label, path }.", input: obj(),
      run: async (_i, meta) => { await placeDeps.person(meta, "this computer's folders"); return { folders: folders.list() }; } });
    ctx.tool("runner.folders.allow", { description: "Approve a folder of this computer for chats: a chat given it works in it, here, and never leaves this computer. Input: path (absolute), label (optional). Needs your yes.", input: obj({ path: str, label: str }, ["path"]),
      run: async (i, meta) => { await placeDeps.person(meta, "this computer's folders"); const f = folders.add(i.path, i.label); return { id: f.id, label: f.label, path: f.path }; } });
    ctx.tool("runner.folders.remove", { description: "Take a folder of this computer away from chats. Nothing in it is touched; a chat working in it stops. Input: id.", input: obj({ id: str }, ["id"]),
      run: async (i, meta) => { await placeDeps.person(meta, "this computer's folders"); return folders.remove(String(i.id)); } });
    ctx.tool("runner.stop", { description: "Stop a session running here.", input: obj({ space: str, session: str }, ["space", "session"]),
      run: async ({ space, session }, meta) => {
        await person(ctx, meta, "stopping a session here"); await (await forSpace(space)).stop(session); return { stopped: true }; } });
    ctx.tool("runner.lock", { description: "Close the workspace on this computer. The data stays encrypted.", input: obj({ space: str }, ["space"]),
      run: async ({ space }, meta) => {
        await person(ctx, meta, "closing the workspace"); await (await forSpace(space)).lock(); return { locked: true }; } });
    // The Space's home tells this computer at once that its grant ended (an Offer withdrawn, the member removed or left): stop the sessions and delete the workspace, now, without waiting for the next
    // poll. Only the Wink module calls it, for a message that arrived down the connection this computer holds to that Space's home (core/wink/index.js).
    ctx.tool("runner.revoke", { description: "The home says this computer's grant for a space ended: stop its sessions and delete the local work and keys.", input: obj({ space: str }, ["space"]),
      run: async ({ space }, meta) => {
        if (!meta || meta.caller !== "module:wink") throw Object.assign(new Error("the Wink module calls this: the home ends a computer's grant, so ask the space's owner to revoke it"), { code: "denied" });
        const r = runners.get(space); if (!r) return { revoked: false, why: "nothing here for that space" };
        await r.revoke(); runners.delete(space); return { revoked: true };
      } });
    ctx.tool("runner.move", { description: "Move a chat's session to the server or back to a computer. Input: thread and to (server or mac). Answers where it runs now.",
      input: obj({ thread: str, to: { type: "string", enum: ["server", "mac"] }, space: str, session: str }, []),
      run: async (i, meta) => {
        // the chat's own words: the home asks the computer to hand the session over, or lets it come back (place-tools.js)
        if (i.thread !== undefined) {
          // this daemon keeps the place of the sessions lent to it (it is the Space's home): ask it. A computer that only lends hands its own session over, whichever chat it belongs to.
          const h = hostOf();
          if (h && h.placements) return placeDeps.moveThread(i, meta);
          await person(ctx, meta, "moving a session");
          if (i.to !== "server") throw Object.assign(new Error("Coming in this release: bringing a session back to a computer is done from the Space's server: do it there"), { code: "unavailable" });
          for (const [, r] of runners) for (const x of r.info()) if (x.chat === i.thread || x.session === i.thread) {
            const out = await r.moveToServer(x.session, "you");
            return out.moved === false ? { where: "mac", computer: null, state: "here", reason: null, since: null, offer: null, pinned: false, pin: null } : { where: "server", computer: null, state: "server", reason: "you", since: Date.now(), offer: null, pinned: false, pin: null };
          }
          throw Object.assign(new Error("no such session on this computer (runner.places shows where each chat runs)"), { code: "not_found" });
        }
        // the computer's own: a last checkpoint here, then the server takes it
        if (typeof i.space !== "string" || typeof i.session !== "string") throw Object.assign(new Error("name the chat to move, or the space and session on this computer"), { code: "bad_input" });
        await person(ctx, meta, "moving a session"); const r = await (await forSpace(i.space)).moveToServer(i.session, "you"); return r.moved === false ? r : { moved: true }; } });

    // Revoking is the kernel's reaction to a withdrawn offer or a removed member, never a tool anyone can call.
    const off = ports()?.onRevoke?.(async () => {
      for (const [space, r] of runners) { const g = ports().grants(space); if (!g.spaceAllows || !g.memberAccepts) { try { await r.revoke(); } catch {} } }
    });

    // A session on this person's own server is sealed at every turn into the same checkpoint store (ownserver.js). The sessions side says which
    // transcript a finished turn belongs to: ports.ownServer.resolve(event) -> { space, session, file, root, state } | null, and .port(space) is the store's port.
    const seals = new Map();
    // The own-server seal's two ports come from the test seam / kernel ports, or from the host (the daemon's own-server half).
    const ownServerOf = () => ports()?.ownServer || hostOf()?.ownServer || null;
    const sealFor = (o, r) => {
      const key = `${r.space}/${r.session}`;
      let seal = seals.get(key);
      if (!seal) { seal = createTurnSeal({ port: o.port(r.space), session: r.session, file: r.file, root: r.root }); seals.set(key, seal); }
      return { key, seal };
    };
    // Always subscribed: whether this computer seals its own sessions is asked at each turn (the daemon's kernel is not up yet when this module starts).
    const offTurns = ctx.events.on("thread.finished", async e => {
      const o = ownServerOf(); let r = null;
      try { r = o && await o.resolve(e); } catch { r = null; }
      if (!r) return;
      const { key, seal } = sealFor(o, r);
      try { const done = await seal.seal({ state: r.state }); emit(r.space, { type: "sealed", session: r.session, ...done }); }
      catch (err) { seals.delete(key); emit(r.space, { type: "seal-failed", session: r.session, code: err.code || "error", message: String(err.message || err).slice(0, 200) }); }
    });

    ctx.tool("runner.recover", {
      description: "Put a session on this server back to its last whole turn before it is resumed after an unclean stop: the provider's transcript is rewritten to exactly the sealed lines (a torn last line and an unfinished turn are dropped). Answers the sealed turn and its state, or nothing when the session was never sealed. Call it only while no process of the session is running.",
      input: obj({ session: str }, ["session"]),
      run: async ({ session }) => {
        const o = ownServerOf();
        if (!o) throw Object.assign(new Error("this computer does not seal its own sessions: run this on the server that holds them"), { code: "unavailable" });
        const r = await o.resolve({ payload: { session } });
        if (!r) throw Object.assign(new Error("no such session here (threads.list shows the sessions)"), { code: "not_found" });
        const { key, seal } = sealFor(o, r);
        try { return (await seal.recover()) || { sealed: false }; } catch (e) { seals.delete(key); throw e; }
      },
    });

    // After a restart: the workspaces on this computer. Each names its Space (`space.id` beside the encrypted folder); the Space's home is asked whether this computer still has access. Access ended (an Offer
    // withdrawn, the member removed or gone, while this computer was off or the daemon was down) deletes the workspace now, as a pushed revoke would; access that stands leaves it locked and encrypted, and a
    // session on it is resumed from its last checkpoint with runner.start. A home that cannot be reached leaves it be and is asked again each minute (never faster).
    let sweepTimer = null, stoppedSweep = false;
    const sweepSpaces = async () => {
      sweepTimer = null;
      if (stoppedSweep || (ctx.config && ctx.config.role === "box")) return;
      const root = path.join(ctx.paths.root, "runner", "spaces");
      let unsure = 0;
      // An enrolled lender beats, and waits to be told what to start, for EVERY Space this computer is set to lend to, whether or not it has ever run a session for it: the first chat on a Mac runs there.
      try { const hh = hostOf(); const ids = hh && typeof hh.lentTo === "function" ? await hh.lentTo() : []; for (const id of ids) { if (!lenders.has(id)) { try { await portsFor(id); } catch { unsure++; } } } } catch { unsure++; }
      let dirs = []; try { dirs = fs.readdirSync(root); } catch { dirs = []; }
      for (const d of dirs) {
        let id = ""; try { id = fs.readFileSync(path.join(root, d, "space.id"), "utf8").trim(); } catch { continue; }
        if (!/^spc_[a-z0-9]{1,40}$/.test(id) || runners.has(id)) continue;
        try {
          const h = hostOf(); const k = ctx.kernel?.for?.(id);
          if (!h || typeof h.identity !== "function" || !k || typeof k.call !== "function") { unsure++; continue; }
          await h.identity();
          const me = await k.call("lent.whoami", []);
          const st = await k.call("lent.status", [{ device_key: me.device }]);
          if (st && st.spaceAllows && st.memberAccepts) { await portsFor(id).catch(() => {}); continue; }   // access stands: the workspace stays locked and encrypted until runner.start; the home hears from this computer again
          const r = await forSpace(id); await r.revoke(); runners.delete(id);
        } catch (e) {
          const code = String(/** @type {any} */ (e) && /** @type {any} */ (e).code || "");
          if (code === "not_a_member" || code === "not_found" || code === "no_lease") { try { const r = await forSpace(id); await r.revoke(); runners.delete(id); } catch { unsure++; } }
          else unsure++;
        }
      }
      if (unsure && !stoppedSweep) { sweepTimer = setTimeout(() => { sweepSpaces().catch(() => {}); }, 60_000); sweepTimer.unref?.(); }
    };
    void sweepSpaces().catch(() => {});
    // the person turned a lend on or off for a computer: this one finds out at once
    const offLent = ctx.events.on("space.device-lent", () => { if (!sweepTimer) sweepSpaces().catch(() => {}); });
    /** The standing long call to each Space's home: it comes back the moment the home has a chat for this computer to start. @type {Map<string, boolean>} */ const nudges = new Map();
    const nudgeLoop = (/** @type {string} */ space) => {
      if (nudges.has(space)) return;
      nudges.set(space, true);
      void (async () => {
        const nap = (/** @type {number} */ ms) => new Promise(res => { const t = setTimeout(res, ms); t.unref?.(); });
        while (!stoppedSweep && nudges.get(space)) {
          const p = lenders.get(space)?.ports;
          if (!p || typeof p.wait !== "function") break;
          if (!enabledNow() || sleeping) { await nap(2000); continue; }
          try {
            const ans = await p.wait({ wait_ms: 20_000 });
            if (ans && Array.isArray(ans.directives) && ans.directives.length) settle(space, runners.get(space), { fenced: [], directives: ans.directives });
          } catch { await nap(2000); }
        }
        nudges.delete(space);
      })();
    };

    // The heartbeat: every few seconds this computer tells each Space's home which sessions it runs, at which epoch and with what use, and whether nothing holds them back now. The answer says which of them the home
    // no longer has (stopped here), and what it wants done: hand a session over (the person's move), or start one the person brought back. A home that cannot be reached changes nothing here: after a lapse it
    // takes the sessions itself, and this computer is fenced when it is heard from again. The moves run apart from the beat, so a slow final checkpoint never makes this computer look dead.
    const asked = new Set();
    // Which sessions go to the server and why (mover.js), from the person's limits and this computer's conditions. A session is handed over apart from the beat (freeze, last checkpoint, release), once; a
    // move the server held back (its cooldown) or that could not be made waits before it is tried again.
    const mover = createMover();
    /** @type {"lid-closed" | "asleep" | null} */ let sleeping = null;
    let sleepingAt = 0;
    const SLEEP_LIMIT_MS = 10 * 60_000, BEAT_TIMEOUT_MS = seam.beatTimeoutMs || 6000;
    const handing = new Set();
    const holdOff = new Map();
    const handOver = (/** @type {string} */ space, /** @type {string} */ session, /** @type {string} */ reason) => {
      const key = `${space}/${session}`, r = runners.get(space);
      if (!r || handing.has(key) || (holdOff.get(key) || 0) > Date.now()) return;
      handing.add(key);
      (async () => {
        try { const out = await r.moveToServer(session, reason); if (out && out.moved === false) holdOff.set(key, Date.now() + 30_000); }
        catch { holdOff.set(key, Date.now() + 10_000); }
        finally { handing.delete(key); }
      })();
    };
    /** What runs here now, asked once per beat: each ask samples every process of every session. @returns {any[]} */
    const snapshot = () => { /** @type {any[]} */ const rows = []; for (const [space, r] of runners) for (const x of r.info()) rows.push({ space, ...x }); return rows; };
    const moveTick = (/** @type {any[]} */ rows = snapshot()) => {
      if (!rows.length) { mover.reset(); return; }   // nothing runs here: nothing to ask the machine about
      // a settings module that has never answered gives no switch to honour: nothing moves for want of one
      // A chat working in a folder of this computer never goes to the server (its files are only here): whatever would move it freezes it, and it runs again when the condition clears. A cap passed is not a reason to stop it.
      const decisions = mover.tick({ settings: { ...limits, enabled: enabledNow() }, sleeping, onPower: (seam.state || deviceState)().onPower, sessions: rows });
      const held = new Set(decisions.filter(d => rows.find(y => y.session === d.session)?.bound && d.reason !== "cpu-cap" && d.reason !== "mem-cap").map(d => rows.find(y => y.session === d.session)?.space));
      for (const [sp, r] of runners) r.holdBound(held.has(sp));
      for (const d of decisions.filter(d => !rows.find(y => y.session === d.session)?.bound)) { const x = rows.find(y => y.session === d.session); if (x) handOver(x.space, d.session, d.reason); }
    };
    // The Mac says it is about to sleep (the Capsule calls link.sleep): hand everything over now, before the lid shuts. What is not handed over waits, frozen, until this computer has been heard by its home again
    // (a woken computer must not run ahead of a server that may have taken its sessions); when it wakes, it checks in at once.
    const offSleep = ctx.events.on("link.sleeping", () => { sleeping = sleepReason(); sleepingAt = Date.now(); moveTick(); for (const [space, r] of runners) if (typeof lenders.get(space)?.ports?.beat === "function") r.freeze("sleep"); });
    // a wake: the connections of before the sleep are dead, so a call still out is forgotten and the check-in goes at once
    const offWake = ctx.events.on("link.woke", () => { sleeping = null; inflight.clear(); beatAgain = true; beatOnce().catch(() => {}); });
    /** Consecutive beats a Space's home did not answer, and the beat to each that is still out. @type {Map<string, number>} */ const missed = new Map();
    /** @type {Map<string, { call: Promise<any>, at: number }>} */ const inflight = new Map();
    let beating = false, beatTimer = null, beatAgain = false;
    /** One Space's heartbeat: its sessions (in as many calls as it takes), then what the home answered. */
    const beatSpace = async (/** @type {string} */ space, /** @type {any} */ l, /** @type {any[]} */ rows, /** @type {boolean} */ well) => {
      const p = l.ports, r = runners.get(space);
      const mine = rows.filter(x => x.space === space && Number.isInteger(p.epochOf(x.session))).map(x => ({ session: x.session, epoch: p.epochOf(x.session), cpuPercent: x.cpuPercent, memoryMb: x.memoryMb, paused: x.paused === true }));
      // a heartbeat names a bounded number of sessions: more than that go in several calls, so none looks dead
      const per = Math.max(1, Math.min(BEAT_MAX, seam.beatMax || BEAT_MAX));
      /** @type {{ fenced: string[], directives: any[] }} */ const got = { fenced: [], directives: [] };
      for (let at = 0; at === 0 || at < mine.length; at += per) {
        const ans = await p.beat({ sessions: mine.slice(at, at + per), well, folders: folders.visible() });
        if (ans && Array.isArray(ans.fenced)) got.fenced.push(...ans.fenced);
        if (ans && Array.isArray(ans.directives)) got.directives.push(...ans.directives);
      }
      return got;
    };
    /** What a home's answer to a heartbeat means here: the sessions it fenced end, the sessions it kept run again (a Mac that waited to be heard has been), and what it wants done is done. */
    const settle = (/** @type {string} */ space, /** @type {any} */ r, /** @type {{ fenced: string[], directives: any[] }} */ ans) => {
      missed.set(space, 0);
      if (r) {
        for (const sid of ans.fenced) r.fence(sid).catch(() => {});
        r.thaw("offline");
        if (!sleeping) r.thaw("sleep");   // not while the Mac is still about to sleep: it waits to be heard AFTER it wakes
      }
      for (const d of ans.directives) {
        const key = `${space}/${d.do}/${d.session}`;
        if (asked.has(key)) continue;
        asked.add(key);
        (async () => {
          try {
            if (d.do === "release" && r) await r.moveToServer(d.session, d.reason || "you");
            else if (d.do === "start" && enabledNow()) await startSession(space, { session: d.session, resume: d.pipe !== true, ...(d.chat ? { chat: d.chat } : {}) });
          } catch { /* asked again at a later beat */ } finally { asked.delete(key); }
        })();
      }
    };
    const beatOnce = async () => {
      if (beating) return;
      beating = true; beatAgain = false;
      try {
        // an idle computer (no Space lent to, no session) does nothing at all: no settings read, no power query, every few seconds for ever
        if (!lenders.size && !runners.size) return;
        if (sleeping && Date.now() - sleepingAt > SLEEP_LIMIT_MS) sleeping = null;   // a wake that never came is not a reason to hand everything over for ever
        await refreshSettings().catch(() => {});
        const rows = snapshot();
        moveTick(rows);
        const well = readSettings.known() && limits.enabled && !sleeping && hereBlock({ spaceAllows: true, memberAccepts: true, state: (seam.state || deviceState)(), limits: { onlyOnPower: limits.pluggedInOnly } }) === "";
        await Promise.all([...lenders].map(async ([space, l]) => {
          if (typeof l.ports.beat !== "function") return;
          const r = runners.get(space);
          const missOne = () => { const n = (missed.get(space) || 0) + 1; missed.set(space, n); if (n >= 2 && r) r.freeze("offline"); };
          // the last beat to this home is still out (the call hangs): that is a miss too, and no second call piles on it. One that has been out for two timeouts is given up, so a call that never returns cannot
          // stop the heartbeat for good; the next tick asks again.
          const out = inflight.get(space);
          if (out) { missOne(); if (Date.now() - out.at > 2 * BEAT_TIMEOUT_MS) inflight.delete(space); return; }
          const call = beatSpace(space, l, rows, well);
          inflight.set(space, { call, at: Date.now() });
          // An answer is acted on whenever it arrives, even after the beat gave up waiting for it: a home that answers in seven seconds is a home that answers.
          const answered = call.then(ans => { settle(space, r, ans); return ans; });
          answered.catch(() => {}).finally(() => { if (inflight.get(space)?.call === call) inflight.delete(space); });
          try { await withinOrThrow(answered, BEAT_TIMEOUT_MS, () => new Error("the home did not answer")); }
          catch { missOne(); }
        }));
      } finally {
        beating = false;
        // a wake that arrived while a beat was out asks for its own, at once
        if (beatAgain) { beatAgain = false; beatOnce().catch(() => {}); }
      }
    };
    if (!(ctx.config && ctx.config.role === "box")) { beatTimer = setInterval(() => { beatOnce().catch(() => {}); }, seam.heartbeatMs || HEARTBEAT_MS); beatTimer.unref?.(); }
    return { async stop() { stoppedSweep = true; for (const k of nudges.keys()) nudges.set(k, false); try { offLent?.(); } catch { /* gone */ } if (sweepTimer) clearTimeout(sweepTimer); if (beatTimer) clearInterval(beatTimer); try { offSleep?.(); offWake?.(); } catch { /* gone */ } try { off?.(); } catch {} try { offTurns?.(); } catch {} for (const l of lenders.values()) { try { l.stop(); } catch {} } for (const r of runners.values()) { try { await r.stopAll(); await r.lock(); } catch {} } runners.clear(); } };
  },
};
