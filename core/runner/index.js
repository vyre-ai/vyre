// @ts-check
// runner: the module around core/runner's library. It adds nothing of its own: every call goes to a createRunner()
// per space, and the three things it needs from other teams arrive as ports (vault, space sync, grants). Until those
// teams land the real ones, the ports are absent and runner.status says so in plain words.

import { createRunner } from "./runner.js";
import { unavailable } from "./sandbox.js";
import { workspaceUnavailable } from "./workspace.js";

/** Test and wiring seam, keyed by the module's root folder: { ports: { vault, sync, grants, server, requestServer }, platform }. */
export const seams = new Map();

const obj = (properties = {}, required = []) => ({ type: "object", properties, required });
const str = { type: "string" };

export default {
  async start(ctx) {
    const seam = (ctx.paths && seams.get(ctx.paths.root)) || {};
    const ports = () => seam.ports || null;
    /** @type {Map<string, any>} one runner per space */
    const runners = new Map();
    const emit = (space, e) => { try { ctx.events.emit(`runner.${e.type === "checkpoint" ? "checkpoint" : e.type}`, { space, ...e }); } catch {} };
    const forSpace = space => {
      const p = ports();
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
        const why = unavailable(seam.platform) || workspaceUnavailable(seam.platform);
        return { ready: !why && !!ports(), why: why || (ports() ? "" : "the space's vault and sync are not connected yet"), spaces: [...runners].map(([space, r]) => ({ space, ...r.status() })) };
      },
    });
    ctx.tool("runner.place", {
      description: "Where a session in this space would run now: here, the server or waiting, with the reason in words.",
      input: obj({ space: str, pinned: { type: "boolean" } }, ["space"]),
      run: async ({ space, pinned }) => forSpace(space).decide({ pinnedToServer: Boolean(pinned) }),
    });
    ctx.tool("runner.start", {
      description: "Start a session here. Needs both grants and a held key lease.",
      input: obj({ space: str, session: str, command: str, args: { type: "array", items: str }, routes: { type: "array" }, resume: { type: "boolean" } }, ["space", "session", "command", "routes"]),
      run: async ({ space, session, command, args, routes, resume }) => { const h = await forSpace(space).start({ session, command, args, routes, resume }); return { session, pid: h.pid }; },
    });
    ctx.tool("runner.stop", { description: "Stop a session running here.", input: obj({ space: str, session: str }, ["space", "session"]),
      run: async ({ space, session }) => { await forSpace(space).stop(session); return { stopped: true }; } });
    ctx.tool("runner.lock", { description: "Close the workspace on this computer. The data stays encrypted.", input: obj({ space: str }, ["space"]),
      run: async ({ space }) => { await forSpace(space).lock(); return { locked: true }; } });
    ctx.tool("runner.revoke", { description: "Access to the space ended: lock and delete the workspace.", input: obj({ space: str }, ["space"]),
      run: async ({ space }) => { await forSpace(space).revoke(); return { deleted: true }; } });
    ctx.tool("runner.move", { description: "Move a session to the space's server, after a last checkpoint here.", input: obj({ space: str, session: str }, ["space", "session"]),
      run: async ({ space, session }) => { await forSpace(space).moveToServer(session); return { moved: true }; } });

    return { async stop() { for (const r of runners.values()) { try { await r.stopAll(); await r.lock(); } catch {} } runners.clear(); } };
  },
};
