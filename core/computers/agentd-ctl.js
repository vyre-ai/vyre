// @ts-check
// agentd-ctl: vyred's side of agentd. Implements the Ctl port of agent-users.js over HTTP to the agent computer's agentd. Secrets (the agentd
// token, each agent's VNC password) are derived or held in memory by the caller and never logged or put in an error.

import crypto from "node:crypto";
export { RELAY_PORT } from "./image/agentd-relay.js";

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
    startScreen: async u => post("start", { user: u.user, uid: u.uid, display: u.display, name: u.name, limits: deps.limits ? deps.limits() : {}, vncPassword: vncPasswordFor(await deps.vncKey(), u.agentId) }),
    stopScreen: u => post("stop", { user: u.user, uid: u.uid, display: u.display }),
    wipeAgentHome: u => post("wipe", { user: u.user, uid: u.uid, display: u.display }),
    /** register a one-use ticket for a viewer's connection to the relay (agentd-relay.js) */
    screenTicket: (u, ticket) => post("ticket", { user: u.user, uid: u.uid, display: u.display, ticket }),
    /** register a one-use ticket for the agent's Chrome (its debugging pipe, through the relay) */
    cdpTicket: (u, ticket) => post("ticket", { user: u.user, uid: u.uid, display: u.display, ticket, kind: "cdp" }),
    /** register a one-use ticket to run one command as the agent and stream it (a harness session): what to run rides with the ticket, checked again by the helper */
    runTicket: (u, ticket, spec) => post("ticket", { user: u.user, uid: u.uid, display: u.display, ticket, kind: "run", argv: spec.argv, cwd: spec.cwd, env: spec.env }),
    /** register a one-use ticket for one terminal (a tmux session of the agent) */
    terminalTicket: (u, ticket, session) => post("ticket", { user: u.user, uid: u.uid, display: u.display, ticket, session }),
    /** run a command as the agent (agentd.js planExec): { code, signal, stdout, stderr, truncated } */
    exec: async (u, req) => {
      const r = await deps.transport("exec", { user: u.user, uid: u.uid, display: u.display, limits: deps.limits ? deps.limits() : {}, ...req });
      if (r.status < 200 || r.status >= 300 || !r.json) throw new Error(`the agent computer could not run that (${r.status}${r.json && r.json.error ? `: ${r.json.error.message}` : ""})`);
      return r.json;
    },
    /** the agent's tmux sessions */
    terminals: async u => {
      const r = await deps.transport("terminals", { user: u.user, uid: u.uid, display: u.display });
      if (r.status < 200 || r.status >= 300 || !r.json || !Array.isArray(r.json.sessions)) throw new Error(`the agent computer could not list terminals (${r.status})`);
      return r.json.sessions;
    },
  };
}

/**
 * vyred's way into agentd: `exec(input)` runs /opt/agentd/client in the computer (docker exec -i as agentctl, the one shape policy.js allows) and returns its status and output. The request goes on standard input.
 * @param {(input: string) => Promise<{ stdout: string }>} exec
 */
export const execTransport = exec => async (action, body) => {
  const r = await exec(JSON.stringify({ action, body }));
  let out = null; try { out = JSON.parse(r.stdout); } catch { /* not json */ }
  return out && Number.isInteger(out.status) ? { status: out.status, json: out.body } : { status: 502, json: null };
};
