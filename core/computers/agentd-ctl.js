// @ts-check
// agentd-ctl: vyred's side of agentd. Implements the Ctl port of agent-users.js over HTTP to the agent computer's agentd. Secrets (the agentd
// token, each agent's VNC password) are derived or held in memory by the caller and never logged or put in an error.

import crypto from "node:crypto";

/** An agent's VNC password, derived from a vault-held key so it is never stored: stable for the agent, different for every agent. @param {string} key @param {string} agentId */
export const vncPasswordFor = (key, agentId) => {
  // its own derived key, so a leak of one use of the member-token key never maps to the other
  const derived = Buffer.from(crypto.hkdfSync("sha256", key, "", "vyre agent computer vnc password v1", 32));
  return crypto.createHmac("sha256", derived).update(`agent-vnc\n${agentId}`).digest("base64url").slice(0, 24);
};

/**
 * @param {{ transport: (action: string, body: any) => Promise<{ status: number, json: any }>, vncKey: () => Promise<string>, limits?: () => { memoryMb?: number, procs?: number, size?: string } }} deps
 * @returns {import("./agent-users.js").Ctl}
 */
export function agentdCtl(deps) {
  /** @param {string} action @param {any} body */
  const post = async (action, body) => {
    const r = await deps.transport(action, body);
    if (r.status < 200 || r.status >= 300) throw new Error(`the agent computer could not ${action} (${r.status}${r.json && r.json.error ? `: ${r.json.error.message}` : ""})`);
  };
  return {
    createUser: u => post("create", { user: u.user, uid: u.uid, display: u.display }),
    removeUser: u => post("remove", { user: u.user, uid: u.uid, display: u.display }),
    startScreen: async u => post("start", { user: u.user, uid: u.uid, display: u.display, limits: deps.limits ? deps.limits() : {}, vncPassword: vncPasswordFor(await deps.vncKey(), u.agentId) }),
    stopScreen: u => post("stop", { user: u.user, uid: u.uid, display: u.display }),
    wipeHome: u => post("wipe", { user: u.user, uid: u.uid, display: u.display }),
  };
}

/**
 * vyred's way into agentd: `exec(input)` runs /opt/agentd/client in the computer (docker exec -i as agentctl, the one shape policy.js allows) and returns its status and output. The request goes on standard input.
 * @param {(input: string) => Promise<{ code: number, stdout: string }>} exec
 */
export const execTransport = exec => async (action, body) => {
  const r = await exec(JSON.stringify({ action, body }));
  let json = null; try { json = JSON.parse(r.stdout); } catch { /* not json */ }
  return { status: r.code === 0 ? 200 : (json && json.error ? 400 : 502), json };
};
