// @ts-check
// runner: the module around core/runner's library. It adds nothing of its own: every call goes to a createRunner()
// per space, and the three things it needs from other teams arrive as ports (vault, space sync, grants). Until those
// teams land the real ones, the ports are absent and runner.status says so in plain words.

import { createRunner, reconcile } from "./runner.js";
import { unavailable } from "./sandbox.js";
import { workspaceUnavailable } from "./workspace.js";

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
    return String(hops[0].actor.id);
  }
  if ((meta && (meta.agent || meta.assistant)) || AGENT.test(c) || /^(module|hook|anonymous|onboard|mcp|harness)\b/.test(c) || c.startsWith("tailnet:guest")) throw denied(c, what);
  return null;
};
const obj = (properties = {}, required = []) => ({ type: "object", properties, required });
const str = { type: "string" };

export default {
  async start(ctx) {
    const seam = (ctx.paths && seams.get(ctx.paths.root)) || {};
    const ports = () => seam.ports || ctx.kernel?.runnerPorts?.() || null;
    // A workspace left open by a runner that died must not stay readable: close any nobody holds a lease for.
    try { await reconcile({ base: ctx.paths.root + "/runner", platform: seam.platform }); } catch {}
    /** @type {Map<string, any>} one runner per space */
    const runners = new Map();
    const emit = (space, e) => { try { ctx.events.emit(`runner.${e.type === "checkpoint" ? "checkpoint" : e.type}`, { space, ...e }); } catch {} };
    const forSpace = space => {
      const p = ports();
      if (p && (typeof p.device !== "string" || !p.device)) throw Object.assign(new Error("the runner needs this computer's device key identity"), { code: "unavailable" });
      if (!p) throw Object.assign(new Error("running a space's work here is not connected yet: the space's vault and sync are not available"), { code: "unavailable" });
      let r = runners.get(space);
      if (!r) {
        r = createRunner({ platform: seam.platform, base: ctx.paths.root + "/runner", space, device: p.device, vault: p.vault, sync: p.sync,
          grants: () => p.grants(space), server: () => p.server?.(space), requestServer: s => p.requestServer?.(space, s), onEvent: e => emit(space, e) });
        runners.set(space, r);
      }
      return r;
    };

    ctx.tool("runner.status", {
      description: "Whether this computer can run a space's sessions, and what is running here.",
      input: obj(),
      run: async () => {
        const why = unavailable(seam.platform) || workspaceUnavailable(seam.platform, { base: ctx.paths.root + "/runner" });
        return { ready: !why && !!ports(), why: why || (ports() ? "" : "the space's vault and sync are not connected yet"), spaces: [...runners].map(([space, r]) => { const { dir, ...rest } = r.status(); return { space, ...rest }; }) };
      },
    });
    ctx.tool("runner.place", {
      description: "Where a session in this space would run now: here, the server or waiting, with the reason in words.",
      input: obj({ space: str, pinned: { type: "boolean" } }, ["space"]),
      run: async ({ space, pinned }) => forSpace(space).decide({ pinnedToServer: Boolean(pinned) }),
    });
    ctx.tool("runner.start", {
      description: "Start a session here. The space's own definition of the session decides the program, the routes and the credentials it may use; the caller names only the space and the session. Needs both grants and a held key lease.",
      input: obj({ space: str, session: str, resume: { type: "boolean" } }, ["space", "session"]),
      run: async ({ space, session, resume }, meta) => {
        await person(ctx, meta, "starting a session here");
        const p = ports(); const r = forSpace(space);
        const spec = await p.spec({ space, session });
        if (!spec || !spec.command || !Array.isArray(spec.routes)) throw Object.assign(new Error("the space has no definition for that session"), { code: "not_found" });
        const h = await r.start({ session, resume: Boolean(resume), command: spec.command, args: spec.args, env: spec.env, routes: spec.routes, readOnly: spec.readOnly, labels: spec.labels, network: spec.network });
        return { session, pid: h.pid, resumed: h.resumed ? { turn: h.resumed.turn, seq: h.resumed.seq, state: h.resumed.state } : null };
      },
    });
    ctx.tool("runner.stop", { description: "Stop a session running here.", input: obj({ space: str, session: str }, ["space", "session"]),
      run: async ({ space, session }, meta) => {
        await person(ctx, meta, "stopping a session here"); await forSpace(space).stop(session); return { stopped: true }; } });
    ctx.tool("runner.lock", { description: "Close the workspace on this computer. The data stays encrypted.", input: obj({ space: str }, ["space"]),
      run: async ({ space }, meta) => {
        await person(ctx, meta, "closing the workspace"); await forSpace(space).lock(); return { locked: true }; } });
    ctx.tool("runner.move", { description: "Move a session to the space's server, after a last checkpoint here.", input: obj({ space: str, session: str }, ["space", "session"]),
      run: async ({ space, session }, meta) => {
        await person(ctx, meta, "moving a session"); await forSpace(space).moveToServer(session); return { moved: true }; } });

    // Revoking is the kernel's reaction to a withdrawn offer or a removed member, never a tool anyone can call.
    const off = ports()?.onRevoke?.(async () => {
      for (const [space, r] of runners) { const g = ports().grants(space); if (!g.spaceAllows || !g.memberAccepts) { try { await r.revoke(); } catch {} } }
    });

    return { async stop() { try { off?.(); } catch {} for (const r of runners.values()) { try { await r.stopAll(); await r.lock(); } catch {} } runners.clear(); } };
  },
};
