// @ts-check
// runner: the module around core/runner's library. It adds nothing of its own: every call goes to a createRunner()
// per space, and the three things it needs from other teams arrive as ports (vault, space sync, grants). Until those
// teams land the real ones, the ports are absent and runner.status says so in plain words.

import { createRunner, reconcile } from "./runner.js";
import { unavailable } from "./sandbox.js";
import { workspaceUnavailable } from "./workspace.js";
import { createTurnSeal } from "./ownserver.js";
import path from "node:path";
import fs from "node:fs";
import { createLenderHost } from "./lender-host.js";

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
  if ((meta && (meta.agent || meta.assistant)) || AGENT.test(c) || /^(module|hook|anonymous|onboard|mcp|harness)\b/.test(c)) throw denied(c, what);
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
        await h.identity();   // this computer has claimed an identity (it may lend at all)
        // The Offers for this computer are made under the id the Space's home gives it, read from what the transport proved: the home answers it, this computer never chooses it.
        const me = await k.call("lent.whoami", []);
        if (!me || typeof me.device !== "string" || !me.device) throw Object.assign(new Error("the Space's home did not say which computer this is"), { code: "unavailable" });
        l = createLenderHost({ invoke: k.call, deviceId: me.device, deviceKey: me.device, ...(h.lenderCap ? { lenderCap: h.lenderCap } : {}) });
        await l.ready; lenders.set(space, l);
        l.ports.onRevoke(async () => { const r = runners.get(space); if (r) { try { await r.revoke(); } catch {} runners.delete(space); } });
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
      input: obj({ space: str, session: str, resume: { type: "boolean" }, chat: { ...str, description: "The chat this work belongs to (chat_<id>), so the chat can say where it runs." } }, ["space", "session"]),
      run: async ({ space, session, resume, chat }, meta) => {
        if (chat !== undefined && !(typeof chat === "string" && /^chat_[0-9a-f-]{36}$/.test(chat))) throw Object.assign(new Error("a chat is named by its id"), { code: "bad_input" });
        await person(ctx, meta, "starting a session here");
        const p = await portsFor(space); const r = await forSpace(space);
        // The key lease is taken first: the home binds the session's credential routes to the lease it is given, so a definition asked for before the lease would map nothing.
        await r.open();
        const spec = await p.spec({ space, session, ...(chat ? { chat } : {}) });
        if (!spec || !spec.command || !Array.isArray(spec.routes)) throw Object.assign(new Error("the space has no definition for that session"), { code: "not_found" });
        const run = resolveAgent(spec);
        const h = await r.start({ session, resume: Boolean(resume), command: run.command, args: run.args, env: spec.env, routes: spec.routes, readOnly: run.readOnly, labels: spec.labels, network: spec.network });
        return { session, pid: h.pid, resumed: h.resumed ? { turn: h.resumed.turn, seq: h.resumed.seq, state: h.resumed.state } : null };
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
        if (!meta || meta.caller !== "module:wink") throw Object.assign(new Error("the Wink module calls this"), { code: "denied" });
        const r = runners.get(space); if (!r) return { revoked: false, why: "nothing here for that space" };
        await r.revoke(); runners.delete(space); return { revoked: true };
      } });
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

    // After a restart: the workspaces on this computer. Each names its Space (`space.id` beside the encrypted folder); the Space's home is asked whether this computer still has access. Access ended (an Offer
    // withdrawn, the member removed or gone, while this computer was off or the daemon was down) deletes the workspace now, as a pushed revoke would; access that stands leaves it locked and encrypted, and a
    // session on it is resumed from its last checkpoint with runner.start. A home that cannot be reached leaves it be and is asked again each minute (never faster).
    let sweepTimer = null, stoppedSweep = false;
    const sweepSpaces = async () => {
      sweepTimer = null;
      if (stoppedSweep || (ctx.config && ctx.config.role === "box")) return;
      const root = path.join(ctx.paths.root, "runner", "spaces");
      let dirs = []; try { dirs = fs.readdirSync(root); } catch { return; }
      let unsure = 0;
      for (const d of dirs) {
        let id = ""; try { id = fs.readFileSync(path.join(root, d, "space.id"), "utf8").trim(); } catch { continue; }
        if (!/^spc_[a-z0-9]{1,40}$/.test(id) || runners.has(id)) continue;
        try {
          const h = hostOf(); const k = ctx.kernel?.for?.(id);
          if (!h || typeof h.identity !== "function" || !k || typeof k.call !== "function") { unsure++; continue; }
          await h.identity();
          const me = await k.call("lent.whoami", []);
          const st = await k.call("lent.status", [{ device_key: me.device }]);
          if (st && st.spaceAllows && st.memberAccepts) continue;   // access stands: the workspace stays locked and encrypted until runner.start
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
    return { async stop() { stoppedSweep = true; if (sweepTimer) clearTimeout(sweepTimer); try { off?.(); } catch {} try { offTurns?.(); } catch {} for (const l of lenders.values()) { try { l.stop(); } catch {} } for (const r of runners.values()) { try { await r.stopAll(); await r.lock(); } catch {} } runners.clear(); } };
  },
};
