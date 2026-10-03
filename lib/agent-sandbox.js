// @ts-check
// agent-sandbox: how a Vyre-started session's agent process is confined on the person's own computer (the runner's home sandbox, core/runner/homesandbox.js: reviewer-2's
// D-1 to D-3). The runner owns the rules and the proof; sessions owns what is specific to each provider's agent, in ONE table, so adding a provider is one entry and the runner
// never hard-codes Claude's paths:
//   private        the agent's own config folder, where to point it elsewhere (env) and which files are its sign-in: each session gets a throwaway folder with only those (no fallback to the real one)
//   hosts          its sign-in and API hosts, for the Linux egress routes and the self-test ("can still start and sign in")
//   versionArgs    how to prove the agent starts inside the sandbox
// The launcher does three things, in this order: `selfTest` (before EACH session; any failure and the session does not start, with one plain reason), then for each process the
// session spawns `planHome` and `launch`, with the session's own socket as the only way back into Vyre. The runner is passed in as a port (no import: parts talk through ports).
//
// The launcher also keeps three things out of the session (reviewer-3's profile gate): a workdir that is or contains the home (it would give the home back), any credential in the
// environment or argv (an agent can read other same-user processes' env and argv on macOS; the session kernel token is only ever stamped on the socket), and every variable not on an
// allow-list. On Windows there is no sandbox yet (0.3): the session starts unsandboxed with one plain notice, and it is marked so in its record and the audit log.

import path from "node:path";

/**
 * @typedef {{ private?: (home: string) => { from: string, env: string, credentialFiles: string[] }, relocatable?: boolean, settingsPaths?: (home: string) => string[], credentialEnv?: { vars: string[], requiredOn?: string, how: string }, hosts: string[], versionArgs: string[], unsupported?: string }} AgentEntry
 *   private: where the agent keeps its own folder (`from`, never bound into the session), the variable that points it elsewhere (`env`, the config-folder relocation) and the files copied
 *   into the session's throwaway folder (`credentialFiles`: only the sign-in). The session sees that copy and nothing of the real folder, and writes nothing to it. No fallback to the
 *   real folder, with one exception the user ruled (Grok must run): a provider flagged `relocatable: false` still starts sandboxed with ITS OWN real settings folder (`settingsPaths`) allowed back,
 *   read and write, and nothing else of the person's; the session is marked partly sandboxed on its record. A provider with neither carries `unsupported` and does not start, with that plain reason.
 */

/** @type {Record<string, AgentEntry>} one entry per provider that runs its own agent process. API-key chat providers (openrouter, openai-compatible) run inside Vyre through the inference door, with no agent process to confine. */
export const AGENTS = {
  // Measured: Claude Code reads its sign-in from CLAUDE_CONFIG_DIR/.credentials.json (runner's own proof). On macOS the sign-in may live in the Keychain, which the sandbox denies: not proven there.
  // On macOS Claude Code keeps its subscription sign-in in the Keychain, under an item keyed to the config folder, and the sandbox denies the Keychain to a session: a relocated folder has no sign-in
  // at all there. The documented non-Keychain way is the long-lived token from `claude setup-token`, read from CLAUDE_CODE_OAUTH_TOKEN (subscription only; no Remote Control, no claude.ai connectors).
  // Vyre already has this (0.2): the Vault item `claude-setup-token` (or `anthropic-api-key`), made by onboarding, which drives `claude setup-token` and stores the result, and chosen per session by
// the Switchboard's `auth` (sessions.auth). The launcher takes the variable that resolution already produced for this session and sets it in the session's own process only, never from the
// launcher's own environment. On Linux without one, the credentials file is copied instead (proven).
  claude: { private: h => ({ from: path.join(h, ".claude"), env: "CLAUDE_CONFIG_DIR", credentialFiles: [".credentials.json"] }), credentialEnv: { vars: ["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY"], requiredOn: "darwin", how: "Claude's sign-in on a Mac lives in the Keychain, which a sandboxed session cannot open. Run `claude setup-token` once and give Vyre the token it prints, and sessions will use it" }, hosts: ["api.anthropic.com:443", "claude.ai:443", "console.anthropic.com:443"], versionArgs: ["--version"] },
  // Measured on codex-cli 0.160.0 (testbox): with CODEX_HOME pointing at a folder holding only auth.json it reports "Logged in", and with HOME empty and no CODEX_HOME it is "Not logged in" and creates nothing under HOME.
  // config.toml is Vyre's own seed (approval and sandbox modes), copied so the session runs under the same settings.
  codex: { private: h => ({ from: path.join(h, ".codex"), env: "CODEX_HOME", credentialFiles: ["auth.json", "config.toml"] }), hosts: ["api.openai.com:443", "auth.openai.com:443", "chatgpt.com:443"], versionArgs: ["--version"] },
  // Grok Build reads ~/.grok from HOME and has no variable that moves it (measured in the driver: only HOME, and a session HOME is the empty one), so it cannot be given a throwaway folder.
  // Ruled by the user: it still runs and carries the session within Vyre, in its own place. Its own real folder is allowed back, nothing else of the person's, and the session says so.
  grok: { relocatable: false, settingsPaths: h => [path.join(h, ".grok")], hosts: ["api.x.ai:443", "accounts.x.ai:443"], versionArgs: ["--version"] },
};

/** Providers with no agent process of their own: nothing to confine here, the door is their boundary. */
export const IN_PROCESS = new Set(["openrouter", "openai-compatible", "anthropic-compatible"]);

/** The agent's description for the runner, or null for an in-process provider. A provider that cannot be given its own config folder is refused with its plain reason. @param {string} provider @param {{ home: string, command: string, extraHosts?: string[] }} o */
export function agentFor(provider, o) {
  if (IN_PROCESS.has(provider)) return null;
  const e = AGENTS[provider];
  if (!e) throw Object.assign(new Error(`Vyre cannot confine ${provider} yet, so it does not start here`), { code: "sandbox_unsupported" });
  if (e.relocatable === false && e.settingsPaths) return { command: o.command, relocatable: false, settingsPaths: e.settingsPaths(o.home), hosts: [...e.hosts, ...(o.extraHosts || [])], versionArgs: e.versionArgs };
  if (e.unsupported || !e.private) throw Object.assign(new Error(`Vyre did not start this session sandboxed: ${e.unsupported || `${provider} cannot be given its own settings folder`}.`), { code: "sandbox_unsupported" });
  return { command: o.command, private: e.private(o.home), hosts: [...e.hosts, ...(o.extraHosts || [])], versionArgs: e.versionArgs };
}

/** One plain sentence for the person from the self-test's failures. @param {string[]} failures */
export function plainReason(failures) {
  const first = failures[0] || "the check did not run";
  return `Vyre did not start this session because its safety check failed: ${first}.`;
}

/** Environment variables a session may have. Everything else is dropped, including every token, key, secret and password. */
export const ENV_ALLOW = new Set(["PATH", "HOME", "USER", "LOGNAME", "LANG", "LC_ALL", "LC_CTYPE", "LC_MESSAGES", "TERM", "COLORTERM", "NO_COLOR", "TMPDIR", "TZ", "SHELL", "VYRE_THREAD", "VYRE_AGENT", "VYRE_AGENT_KIND", "VYRE_PROJECTS", "VYRE_SCOPE_CWDS", "CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING", "MAX_THINKING_TOKENS", "BROWSER"]);
const ENV_ALLOW_PREFIX = ["GIT_AUTHOR_", "GIT_COMMITTER_", "LC_"];
const CREDENTIAL = /(^|_)(token|secret|password|passwd|credential|credentials|apikey|key|auth|bearer|session|cookie)(_|$)|api[_-]?key|access[_-]?key/i;
const KERNEL_TOKEN = /^[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}$/;

/** The environment a session gets: the allow-list only, and never anything that looks like a credential or a kernel session token. @param {Record<string, string|undefined>} env @returns {{ env: Record<string, string>, dropped: string[] }} */
export function cleanEnv(env) {
  /** @type {Record<string, string>} */ const out = {};
  const dropped = [];
  for (const [k, v] of Object.entries(env || {})) {
    if (v === undefined) continue;
    const allowed = ENV_ALLOW.has(k) || ENV_ALLOW_PREFIX.some(p => k.startsWith(p));
    if (!allowed || (CREDENTIAL.test(k) && !ENV_ALLOW.has(k)) || KERNEL_TOKEN.test(String(v))) { dropped.push(k); continue; }
    out[k] = String(v);
  }
  return { env: out, dropped };
}

/** Refuse an argv that carries a credential or a kernel session token. @param {string[]} args */
export function checkArgs(args) {
  for (const a of args || []) if (KERNEL_TOKEN.test(String(a)) || /^(sk-[A-Za-z0-9_-]{16,}|Bearer\s+\S{16,})$/.test(String(a))) throw Object.assign(new Error("Vyre did not start this session because a credential was about to be passed on its command line."), { code: "sandbox_failed" });
}

/** Refuse a workdir that is, contains or is inside the Vyre home or contains the person's home: it would hand back what the sandbox takes away. @param {string[]} workdirs @param {string} home @param {string} vyreHome */
export function checkWorkdirs(workdirs, home, vyreHome) {
  const within = (/** @type {string} */ a, /** @type {string} */ b) => { const r = path.relative(a, b); return r === "" || (!r.startsWith("..") && !path.isAbsolute(r)); };
  for (const w of workdirs || []) {
    const d = path.resolve(w);
    if (within(d, home) || within(vyreHome, d)) throw Object.assign(new Error("Vyre did not start this session because its working folder is your whole home folder or contains it. Choose a project folder inside it."), { code: "sandbox_workdir" });
  }
}

/** Said on the record and to the person when a provider keeps its own real settings folder inside the sandbox. */
export const PARTIAL_NOTICE = "Partly sandboxed: this assistant keeps its own settings folder.";

export const WINDOWS_NOTICE = "On Windows, sessions aren't sandboxed yet. An assistant here runs like any program you start. Add a server to run them sandboxed.";

/**
 * Run the self-test for one session and return how every process of the session is spawned. macOS and Linux: workdir check, then the runner's selfTest (a failure means no session, with one
 * plain reason), then a spawner that plans and launches each process under the same rules. Windows: no sandbox in 0.3, so `sandboxed: false` with the notice; the caller shows the notice
 * once per machine and records the session as unsandboxed. Any other system refuses to start.
 * @param {{ sandbox: { planHome(o: any): any, selfTest(o: any): Promise<{ ok: boolean, failures: string[] }>, launch(plan: any, opts?: any): any }, platform: "darwin"|"linux"|"win32"|string,
 *   home: string, vyreHome?: string, credentials?: (provider: string) => Promise<Record<string, string | undefined> | undefined> | Record<string, string | undefined> | undefined, probes: { personSocket: string, otherSocket: string, daemonPorts: number[], keyFile: string, homeFile?: string }, temp?: string }} cfg
 * @param {{ provider: string, command: string, sessionSocket: string, workdirs: string[], readOnly?: string[], extraHosts?: string[], env?: Record<string, string> }} s
 * @returns {Promise<{ sandboxed: true, partial?: { reason: "own_settings_folder", folder: string[], notice: string }, spawn: (command: string, args: string[], env: Record<string, string|undefined>, cwd?: string, opts?: any) => import("node:child_process").ChildProcess } | { sandboxed: false, reason: "windows" | "in_process", notice?: string }>}
 */
export async function prepareSandbox(cfg, s) {
  const agent = agentFor(s.provider, { home: cfg.home, command: s.command, extraHosts: s.extraHosts });
  if (!agent) return { sandboxed: false, reason: "in_process" };
  if (cfg.platform === "win32") return { sandboxed: false, reason: "windows", notice: WINDOWS_NOTICE };
  if (cfg.platform !== "darwin" && cfg.platform !== "linux") throw Object.assign(new Error("Vyre did not start this session because sessions are not sandboxed on this system yet."), { code: "sandbox_unsupported" });
  const vyreHome = cfg.vyreHome || path.join(cfg.home, ".vyre");
  checkWorkdirs(s.workdirs, cfg.home, vyreHome);
  // The provider's own token variable, where its sign-in cannot be copied as a file (Claude on macOS): from the vault's port, set in the session's process only. No token means no sandboxed
  // session, with the plain way to add one; nothing is ever opened on the Keychain.
  const ce = AGENTS[s.provider] && AGENTS[s.provider].credentialEnv;
  /** @type {Record<string, string>} */ let credEnv = {};
  if (ce) {
    const have = (cfg.credentials ? await cfg.credentials(s.provider) : undefined) || {};
    const var_ = ce.vars.find(v => have[v]);
    if (var_) credEnv = { [var_]: String(have[var_]) };
    else if (ce.requiredOn === cfg.platform) throw Object.assign(new Error(`Vyre did not start this session sandboxed: ${ce.how}.`), { code: "sandbox_credential" });
  }
  const common = { platform: cfg.platform, home: cfg.home, vyreHome, sessionSocket: s.sessionSocket, workdirs: s.workdirs, agent, temp: cfg.temp, ...(s.readOnly ? { readOnly: s.readOnly } : {}) };
  const t = await cfg.sandbox.selfTest({ ...common, probes: cfg.probes });
  if (!t.ok) throw Object.assign(new Error(plainReason(t.failures)), { code: "sandbox_failed", failures: t.failures });
  // The same rules for every process the session starts (the agent, its tools, a helper): each gets its own plan with its own command, over the same session socket, a cleaned
  // environment and an argv with no credential in it.
  const partial = agent.settingsPaths && !agent.private ? { reason: /** @type {const} */ ("own_settings_folder"), folder: agent.settingsPaths, notice: PARTIAL_NOTICE } : undefined;
  return { sandboxed: true, ...(partial ? { partial } : {}), spawn: (command, args, env, cwd, opts) => {
    checkArgs(args);
    const wd = cwd ? [...new Set([...s.workdirs, cwd])] : s.workdirs;
    checkWorkdirs(wd, cfg.home, vyreHome);
    return cfg.sandbox.launch(cfg.sandbox.planHome({ ...common, command, args, env: { ...cleanEnv({ ...(s.env || {}), ...(env || {}) }).env, ...credEnv }, readOnly: [...new Set([path.dirname(command), ...(s.readOnly || [])])], workdirs: wd }), opts);
  } };
}
