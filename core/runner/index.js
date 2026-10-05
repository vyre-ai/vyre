// @ts-check
// runner: the module around core/runner's library. It adds nothing of its own: every call goes to a createRunner()
// per space, and the three things it needs from other teams arrive as ports (vault, space sync, grants). Until those
// teams land the real ones, the ports are absent and runner.status says so in plain words.

import { createRunner, reconcile } from "./runner.js";
import { unavailable } from "./sandbox.js";
import { workspaceUnavailable } from "./workspace.js";
import { createTurnSeal } from "./ownserver.js";
import { createLenderHost } from "./lender-host.js";

/** Test and wiring seam, keyed by the module's root folder: { ports: { vault, sync, grants, server, requestServer }, platform }. */
export const seams = new Map();

/**
 * The caller must be the person this device belongs to: never a module, a guest, an agent (not even the person's own assistant), or a chain carrying one.
 * With the kernel on, the person comes from `ctx.kernel.chain(meta)` and nothing else (a verified token's chain, or the facts the daemon proved about the connection):
 * a chain whose only hop is a person, no viewer chain, no agent or service hop. A caller label decides nothing: a web, setup or unknown `device:` label gets no chain and is refused.
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
  throw denied(c, what); // no kernel chain, no person
};
const obj = (properties = {}, required = []) => ({ type: "object", properties, required });
const str = { type: "string" };

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
        const id = await h.identity();
        l = createLenderHost({ invoke: k.call, deviceId: id.deviceId, deviceKey: id.deviceKey, ...(h.lenderCap ? { lenderCap: h.lenderCap } : {}) });
        await l.ready; lenders.set(space, l);
        l.ports.onRevoke(async () => { const r = runners.get(space); if (r) { try { await r.revoke(); } catch {} } });
      }
      return l.ports;
    };
    const hasHost = () => Boolean(seam.ports || (hostOf() && !(ctx.config && ctx.config.role === "box")));
    // A workspace left open by a runner that died must not stay readable: close any nobody holds a lease for.
    try { await reconcile({ base: ctx.paths.root + "/runner", platform: seam.platform }); } catch {}
    /** @type {Map<string, any>} one runner per space */
    const runners = new Map();
    const emit = (space, e) => { try { ctx.events.emit(`runner.${e.type === "checkpoint" ? "checkpoint" : e.type}`, { space, ...e }); } catch {} };
    const forSpace = async space => {
      const p = await portsFor(space);
      if (p && (typeof p.device !== "string" || !p.device)) throw Object.assign(new Error("the runner needs this computer's device key identity"), { code: "unavailable" });
      if (!p) throw Object.assign(new Error("running a space's work here is not connected yet: the space's vault and sync are not available"), { code: "unavailable" });
      let r = runners.get(space);
      if (!r) {
        r = createRunner({ platform: seam.platform, base: ctx.paths.root + "/runner", space, device: p.device, vault: p.vault, sync: p.sync,
          grants: () => p.grants(space), ...(p.lenderCap ? { lenderCap: p.lenderCap } : {}), server: () => p.server?.(space), requestServer: s => p.requestServer?.(space, s), onEvent: e => emit(space, e) });
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
    ctx.tool("runner.start", {
      description: "Start a session here. The space's own definition of the session decides the program, the routes and the credentials it may use; the caller names only the space and the session. Needs both grants and a held key lease.",
      input: obj({ space: str, session: str, resume: { type: "boolean" } }, ["space", "session"]),
      run: async ({ space, session, resume }, meta) => {
        await person(ctx, meta, "starting a session here");
        const p = await portsFor(space); const r = await forSpace(space);
        const spec = await p.spec({ space, session });
        if (!spec || !spec.command || !Array.isArray(spec.routes)) throw Object.assign(new Error("the space has no definition for that session"), { code: "not_found" });
        const h = await r.start({ session, resume: Boolean(resume), command: spec.command, args: spec.args, env: spec.env, routes: spec.routes, readOnly: spec.readOnly, labels: spec.labels, network: spec.network });
        return { session, pid: h.pid, resumed: h.resumed ? { turn: h.resumed.turn, seq: h.resumed.seq, state: h.resumed.state } : null };
      },
    });
    ctx.tool("runner.stop", { description: "Stop a session running here.", input: obj({ space: str, session: str }, ["space", "session"]),
      run: async ({ space, session }, meta) => {
        await person(ctx, meta, "stopping a session here"); await (await forSpace(space)).stop(session); return { stopped: true }; } });
    ctx.tool("runner.lock", { description: "Close the workspace on this computer. The data stays encrypted.", input: obj({ space: str }, ["space"]),
      run: async ({ space }, meta) => {
        await person(ctx, meta, "closing the workspace"); await (await forSpace(space)).lock(); return { locked: true }; } });
    ctx.tool("runner.move", { description: "Move a session to the space's server, after a last checkpoint here.", input: obj({ space: str, session: str }, ["space", "session"]),
      run: async ({ space, session }, meta) => {
        await person(ctx, meta, "moving a session"); await (await forSpace(space)).moveToServer(session); return { moved: true }; } });

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
        if (!o) throw Object.assign(new Error("this computer does not seal its own sessions"), { code: "unavailable" });
        const r = await o.resolve({ payload: { session } });
        if (!r) throw Object.assign(new Error("no such session here"), { code: "not_found" });
        const { key, seal } = sealFor(o, r);
        try { return (await seal.recover()) || { sealed: false }; } catch (e) { seals.delete(key); throw e; }
      },
    });

    return { async stop() { try { off?.(); } catch {} try { offTurns?.(); } catch {} for (const l of lenders.values()) { try { l.stop(); } catch {} } for (const r of runners.values()) { try { await r.stopAll(); await r.lock(); } catch {} } runners.clear(); } };
  },
};
