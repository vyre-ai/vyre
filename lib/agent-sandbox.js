// @ts-check
// agent-sandbox: how a Vyre-started session's agent process is confined on the person's own computer (the runner's home sandbox, core/runner/homesandbox.js: reviewer-2's
// D-1 to D-3). The runner owns the rules and the proof; sessions owns what is specific to each provider's agent, in ONE table, so adding a provider is one entry and the runner
// never hard-codes Claude's paths:
//   settingsPaths  the agent's own sign-in and settings (read and write: it must still sign in and keep its login)
//   hosts          its sign-in and API hosts, for the Linux egress routes and the self-test ("can still start and sign in")
//   versionArgs    how to prove the agent starts inside the sandbox
// The launcher does three things, in this order: `selfTest` (before EACH session; any failure and the session does not start, with one plain reason), then for each process the
// session spawns `planHome` and `launch`, with the session's own socket as the only way back into Vyre. The runner is passed in as a port (no import: parts talk through ports).

import path from "node:path";

/** @typedef {{ settingsPaths: (home: string) => string[], hosts: string[], versionArgs: string[] }} AgentEntry */

/** @type {Record<string, AgentEntry>} one entry per provider that runs its own agent process. API-key chat providers (openrouter, openai-compatible) run inside Vyre through the inference door, with no agent process to confine. */
export const AGENTS = {
  claude: { settingsPaths: h => [path.join(h, ".claude"), path.join(h, ".claude.json")], hosts: ["api.anthropic.com:443", "claude.ai:443", "console.anthropic.com:443"], versionArgs: ["--version"] },
  codex: { settingsPaths: h => [path.join(h, ".codex")], hosts: ["api.openai.com:443", "auth.openai.com:443", "chatgpt.com:443"], versionArgs: ["--version"] },
  grok: { settingsPaths: h => [path.join(h, ".grok")], hosts: ["api.x.ai:443", "accounts.x.ai:443"], versionArgs: ["--version"] },
};

/** Providers with no agent process of their own: nothing to confine here, the door is their boundary. */
export const IN_PROCESS = new Set(["openrouter", "openai-compatible", "anthropic-compatible"]);

/** The agent's description for the runner, or null for an in-process provider. @param {string} provider @param {{ home: string, command: string, extraHosts?: string[] }} o */
export function agentFor(provider, o) {
  if (IN_PROCESS.has(provider)) return null;
  const e = AGENTS[provider];
  if (!e) throw Object.assign(new Error(`Vyre cannot confine ${provider} yet, so it does not start here`), { code: "sandbox_unsupported" });
  return { command: o.command, settingsPaths: e.settingsPaths(o.home), hosts: [...e.hosts, ...(o.extraHosts || [])], versionArgs: e.versionArgs };
}

/** One plain sentence for the person from the self-test's failures. @param {string[]} failures */
export function plainReason(failures) {
  const first = failures[0] || "the check did not run";
  return `Vyre did not start this session because its safety check failed: ${first}.`;
}

/**
 * Run the self-test for one session and return the spawner every process of the session goes through. Throws one plain reason when the check fails.
 * @param {{ sandbox: { planHome(o: any): any, selfTest(o: any): Promise<{ ok: boolean, failures: string[] }>, launch(plan: any, opts?: any): any }, platform: "darwin"|"linux"|string,
 *   home: string, vyreHome?: string, probes: { personSocket: string, otherSocket: string, daemonPorts: number[], keyFile: string, homeFile?: string }, temp?: string }} cfg
 * @param {{ provider: string, command: string, sessionSocket: string, workdirs: string[], extraHosts?: string[], env?: Record<string, string> }} s
 * @returns {Promise<null | ((command: string, args: string[], env: Record<string, string|undefined>, cwd?: string, opts?: any) => import("node:child_process").ChildProcess)>} null: an in-process provider
 */
export async function prepareSandbox(cfg, s) {
  const agent = agentFor(s.provider, { home: cfg.home, command: s.command, extraHosts: s.extraHosts });
  if (!agent) return null;
  const common = { platform: cfg.platform, home: cfg.home, vyreHome: cfg.vyreHome || path.join(cfg.home, ".vyre"), sessionSocket: s.sessionSocket, workdirs: s.workdirs, agent, temp: cfg.temp };
  const t = await cfg.sandbox.selfTest({ ...common, probes: cfg.probes });
  if (!t.ok) throw Object.assign(new Error(plainReason(t.failures)), { code: "sandbox_failed", failures: t.failures });
  // The same rules for every process the session starts (the agent, its tools, a helper): each gets its own plan with its own command, over the same session socket.
  return (command, args, env, cwd, opts) => cfg.sandbox.launch(cfg.sandbox.planHome({ ...common, command, args, env: Object.fromEntries(Object.entries({ ...(s.env || {}), ...(env || {}) }).filter(([, v]) => v !== undefined)), readOnly: [path.dirname(command)], workdirs: cwd ? [...new Set([...s.workdirs, cwd])] : s.workdirs }), opts);
}
