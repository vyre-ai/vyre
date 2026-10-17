// @ts-check
// agentd-ctl: vyred's side of agentd. Implements the Ctl port of agent-users.js over HTTP to the agent computer's agentd. Secrets (the agentd
// token, each agent's VNC password) are derived or held in memory by the caller and never logged or put in an error.

import crypto from "node:crypto";

/** An agent's VNC password, derived from a vault-held key so it is never stored: stable for the agent, different for every agent. @param {string} key @param {string} agentId */
export const vncPasswordFor = (key, agentId) => crypto.createHmac("sha256", key).update(`agent-vnc\n${agentId}`).digest("base64url").slice(0, 24);

/** @param {{ url: string, token: string, vncKey: () => Promise<string>, fetch?: typeof fetch, limits?: () => { memoryMb?: number, procs?: number, size?: string } }} deps @returns {import("./agent-users.js").Ctl} */
export function agentdCtl(deps) {
  const f = deps.fetch || fetch;
  /** @param {string} action @param {any} body */
  const post = async (action, body) => {
    const r = await f(new URL(`/agents/${action}`, deps.url), {
      method: "POST", headers: { authorization: `Bearer ${deps.token}`, "content-type": "application/json" },
      body: JSON.stringify(body), signal: AbortSignal.timeout(30_000),
    });
    if (!r.ok) {
      const j = /** @type {any} */ (await r.json().catch(() => null));
      throw new Error(`the agent computer could not ${action} (${r.status}${j && j.error ? `: ${j.error.message}` : ""})`);
    }
  };
  return {
    createUser: u => post("create", { user: u.user, uid: u.uid, display: u.display }),
    removeUser: u => post("remove", { user: u.user, uid: u.uid, display: u.display }),
    startScreen: async u => post("start", { user: u.user, uid: u.uid, display: u.display, limits: deps.limits ? deps.limits() : {}, vncPassword: vncPasswordFor(await deps.vncKey(), u.agentId) }),
    stopScreen: u => post("stop", { user: u.user, uid: u.uid, display: u.display }),
    wipeHome: u => post("wipe", { user: u.user, uid: u.uid, display: u.display }),
  };
}
