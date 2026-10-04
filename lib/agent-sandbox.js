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

import fs from "node:fs";
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

/**
 * The agent's program as an absolute path, found ONCE against PATH outside the sandbox (the sandbox runs an absolute program path only). A name that is not on PATH, a path that is not a file the
 * user may run, or a relative path is refused plainly: the session does not start, and nothing else is affected.
 * @param {string} command @param {string} [pathVar]
 */
export function resolveAgentCommand(command, pathVar = process.env.PATH) {
  const fail = () => Object.assign(new Error("Vyre did not start this session because the assistant's program was not found on this computer. Install it (for Claude, run `npm install -g @anthropic-ai/claude-code`) and try again."), { code: "sandbox_failed" });
  if (typeof command !== "string" || !command) throw fail();
  const ok = f => { try { fs.accessSync(f, fs.constants.X_OK); return fs.statSync(f).isFile(); } catch { return false; } };
  if (path.isAbsolute(command)) return command;                 // an absolute path is used as given: if it is not a runnable file the self-test says so (the agent does not start)
  if (command.includes("/")) throw fail();                       // a relative path is never searched for or trusted
  for (const d of String(pathVar || "").split(path.delimiter)) { if (!d || !path.isAbsolute(d)) continue; const f = path.join(d, command); if (ok(f)) return f; }
  throw fail();
}

/**
 * The folders a program needs to RUN inside the sandbox, read-only and nothing wider: its own folder; where a link leads (an npm install links its bin to the package) and that package's folder;
 * and, for a script, its interpreter's folder (the shebang, following `env`, found on PATH). The person's home is never bound whole.
 * @param {string} command absolute path @param {string} [pathVar]
 * @returns {string[]}
 */
export function programDirs(command, pathVar = process.env.PATH) {
  const out = new Set([path.dirname(command)]);
  const real = f => { try { return fs.realpathSync(f); } catch { return null; } };
  const onPath = name => { for (const d of String(pathVar || "").split(path.delimiter)) { if (!d || !path.isAbsolute(d)) continue; const f = path.join(d, name); try { fs.accessSync(f, fs.constants.X_OK); return f; } catch { /* next */ } } return null; };
  const target = real(command);
  if (target) {
    out.add(path.dirname(target));
    // the package a linked program belongs to: the nearest folder above the target with a package.json, at least three folders deep (never a home or a root)
    for (let d = path.dirname(target); d.split(path.sep).length > 3; d = path.dirname(d)) { if (fs.existsSync(path.join(d, "package.json"))) { out.add(d); break; } }
    let head = "";
    try { const fd = fs.openSync(target, "r"); try { const b = Buffer.alloc(200); const n = fs.readSync(fd, b, 0, 200, 0); head = b.toString("utf8", 0, n).split("\n")[0]; } finally { fs.closeSync(fd); } } catch { /* unreadable: no interpreter to add */ }
    if (head.startsWith("#!")) {
      const parts = head.slice(2).trim().split(/\s+/).filter(Boolean);
      let interp = parts[0] || "";
      if (path.basename(interp) === "env") interp = parts.slice(1).find(x => !x.startsWith("-") && !x.includes("=")) || "";
      const abs = interp ? (path.isAbsolute(interp) ? interp : onPath(interp)) : null;
      if (abs) { out.add(path.dirname(abs)); const r = real(abs); if (r) out.add(path.dirname(r)); }
    }
  }
  return [...out];
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
  // A credential shape anywhere in an argument, not only as the whole argument: --api-key=sk-..., TOKEN=abc.def, "Bearer xyz", a kernel session token.
  const SHAPES = [/sk-[A-Za-z0-9_-]{16,}/, /\bBearer\s+\S{8,}/i, /\b(?:api[_-]?key|token|secret|password|passwd|authorization)\s*[=:]\s*\S{6,}/i, /[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/];
  for (const a of args || []) if (SHAPES.some(re => re.test(String(a)))) throw Object.assign(new Error("Vyre did not start this session because a credential was about to be passed on its command line."), { code: "sandbox_failed" });
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
 * Windows has no session sandbox in 0.3, so an agent there is not held by anything but its own tool list. The rule until a Windows sandbox exists (lead's ruling, reviewer-2 ENG-1):
 * an agent session gets NO shell tool at all, or does not start, never an unsandboxed shell. A shell the agent could run is a way to call the daemon as an ordinary caller.
 * Claude Code starts with its shell tools denied; an agent with no way to deny its shell is refused with a plain reason. Anything that is not a known agent command is not touched.
 */
export const WINDOWS_NO_SHELL_ARGS = Object.freeze(["--disallowedTools", "Bash,BashOutput,KillShell,KillBash,PowerShell"]);
/** @type {ReadonlySet<string>} the commands that are an AI agent's own process */
export const AGENT_COMMANDS = new Set(["claude", "codex", "grok", "gemini", "opencode", "goose", "cursor-agent", "qwen"]);
export const WINDOWS_NO_SHELL_NOTICE = "On Windows, assistants run without a shell for now, because sessions aren't sandboxed there yet. Add a server to give them one.";
/**
 * @param {string} command @param {string[]} args @param {string} [platform]
 * @returns {string[]} the argv to use; throws when this agent cannot be started without a shell
 */
export function windowsShellGuard(command, args, platform = process.platform) {
  if (platform !== "win32") return args;
  const name = path.win32.basename(String(command)).toLowerCase().replace(/\.(exe|cmd|bat|ps1)$/, "");
  if (!AGENT_COMMANDS.has(name)) return args;
  if (name === "claude") return args.includes("--disallowedTools") || args.includes("--disallowed-tools") ? args : [...WINDOWS_NO_SHELL_ARGS, ...args];
  throw Object.assign(new Error(`Vyre did not start this session because ${name} would have a shell on Windows, and sessions aren't sandboxed there yet. Use Claude here, or add a server.`), { code: "sandbox_failed" });
}

/**
 * Run the self-test for one session and return how every process of the session is spawned. macOS and Linux: workdir check, then the runner's selfTest (a failure means no session, with one
 * plain reason), then a spawner that plans and launches each process under the same rules. Windows: no sandbox in 0.3, so `sandboxed: false` with the notice; the caller shows the notice
 * once per machine and records the session as unsandboxed. Any other system refuses to start.
 * @param {{ sandbox: { planHome(o: any): any, selfTest(o: any): Promise<{ ok: boolean, failures: string[] }>, launch(plan: any, opts?: any): any, homeProxy?(o: any): Promise<{ proxy: any, stop(): Promise<void> }> }, platform: "darwin"|"linux"|"win32"|string,
 *   home: string, vyreHome?: string, credentials?: (provider: string) => Promise<string | Record<string, string | undefined> | null | undefined> | string | Record<string, string | undefined> | null | undefined, probes: { personSocket: string, otherSocket: string, daemonPorts: number[], keyFile: string, homeFile?: string }, temp?: string }} cfg
 * @param {{ provider: string, command: string, sessionSocket: string, account?: { uid: number, shared: boolean } | null, workdirs: string[], readOnly?: string[], extraHosts?: string[], env?: Record<string, string>, trustedEnv?: Record<string, string | undefined> }} s
 * @returns {Promise<{ sandboxed: true, partial?: { reason: "own_settings_folder", folder: string[], notice: string }, spawn: (command: string, args: string[], env: Record<string, string|undefined>, cwd?: string, opts?: any) => import("node:child_process").ChildProcess } | { sandboxed: false, reason: "windows" | "in_process", notice?: string }>}
 */
export async function prepareSandbox(cfg, s) {
  // The program is resolved to an absolute path once, here, outside the sandbox; a session that cannot find it fails plainly (and only that session).
  if (cfg.platform !== "win32" && AGENTS[s.provider] && !IN_PROCESS.has(s.provider)) s = { ...s, command: resolveAgentCommand(s.command, (s.env && s.env.PATH) || process.env.PATH) };
  const agent = agentFor(s.provider, { home: cfg.home, command: s.command, extraHosts: s.extraHosts });
  if (!agent) return { sandboxed: false, reason: "in_process" };
  if (cfg.platform === "win32") return { sandboxed: false, reason: "windows", notice: WINDOWS_NOTICE };
  if (cfg.platform !== "darwin" && cfg.platform !== "linux") throw Object.assign(new Error("Vyre did not start this session because sessions are not sandboxed on this system yet."), { code: "sandbox_unsupported" });
  // The packaged box (cfg.uid, built by the daemon under the docker supervisor): the confinement is the container, the session's own uid and the wall, and it is checked, as that uid, before EVERY
  // start. A check that fails refuses the start with its name; nothing is spawned unconfined. The session itself is spawned as always (the spawner starts it as that uid), so there is no wrapper.
  if (cfg.uid) {
    const ac = new AbortController(), limit = Number(cfg.selfTestMs) || 30_000, timer = setTimeout(() => ac.abort(), limit); timer.unref?.();
    let t; try { t = await cfg.uid.selfTest({ account: s.account ? s.account.uid : null, shared: Boolean(s.account && s.account.shared), workdirs: s.workdirs, signal: ac.signal }); } finally { clearTimeout(timer); }
    if (!t.ok) throw Object.assign(new Error(`Vyre did not start this session: sandbox_failed: ${t.failures[0]}.`), { code: "sandbox_failed", failures: t.failures });
    return { sandboxed: true, confinedBy: "uid", release: async () => {}, spawn: undefined };
  }
  const vyreHome = cfg.vyreHome || path.join(cfg.home, ".vyre");
  // Vyre's own git identity and hooks (the Switchboard's gitEnv): not from the launcher's environment, and only these names.
  const trusted = Object.fromEntries(Object.entries(s.trustedEnv || {}).filter(([k, v]) => /^(GIT_AUTHOR_|GIT_COMMITTER_|GIT_CONFIG_COUNT$|GIT_CONFIG_KEY_\d+$|GIT_CONFIG_VALUE_\d+$)/.test(k) && typeof v === "string"));
  checkWorkdirs(s.workdirs, cfg.home, vyreHome);
  // The provider's own token variable, where its sign-in cannot be copied as a file (Claude on macOS): from the vault's port, set in the session's process only. No token means no sandboxed
  // session, with the plain way to add one; nothing is ever opened on the Keychain.
  const ce = AGENTS[s.provider] && AGENTS[s.provider].credentialEnv;
  /** @type {Record<string, string>} */ let credEnv = {};
  if (ce) {
    // The port answers a token string (the daemon's one-shot credentials port: claude is the setup token) or a map of variables.
    const got = cfg.credentials ? await cfg.credentials(s.provider) : undefined;
    const have = typeof got === "string" ? { [ce.vars[0]]: got } : (got || {});
    const var_ = ce.vars.find(v => have[v]);
    if (var_) credEnv = { [var_]: String(have[var_]) };
    else if (ce.requiredOn === cfg.platform) throw Object.assign(new Error(`Vyre did not start this session sandboxed: ${ce.how}.`), { code: "sandbox_credential" });
  }
  // The session's only way out: the runner's per-session egress proxy (internet mode, public addresses only), started here and stopped by `release` when the session ends. Without the port
  // the profile has no network at all.
  const hp = cfg.sandbox.homeProxy ? await cfg.sandbox.homeProxy({ platform: cfg.platform, session: s.sessionSocket }) : null;
  const release = async () => { if (hp) { try { await hp.stop(); } catch {} } };
  const common = { platform: cfg.platform, home: cfg.home, vyreHome, sessionSocket: s.sessionSocket, workdirs: s.workdirs, agent, temp: cfg.temp, ...(hp ? { proxy: hp.proxy } : {}), ...(s.readOnly ? { readOnly: s.readOnly } : {}) };
  // The probe targets are made fresh for each self-test when `cfg.probes` is a function: real listeners (another session's socket, a loopback port) the sandboxed probe must fail to
  // reach, torn down afterwards. A fixed object still works (tests).
  const probes = typeof cfg.probes === "function" ? await cfg.probes() : cfg.probes;
  /** @type {any} */ let t;
  // The self-test has its own short limit (cfg.selfTestMs, default 30 s): a hung probe or agent check fails THIS session with a plain reason, and the abort signal lets the runner end what it
  // spawned. The Switchboard's start limit (start_timeout_s) still bounds the whole start.
  const ac = new AbortController(), limit = Number(cfg.selfTestMs) || 30_000;
  /** @type {NodeJS.Timeout | undefined} */ let timer;
  const hung = new Promise((_, reject) => { timer = setTimeout(() => { ac.abort(); reject(Object.assign(new Error("Vyre did not start this session because the sandbox check did not finish in time."), { code: "sandbox_failed", failures: ["the sandbox self-test did not finish in time"] })); }, limit); });
  hung.catch(() => {});
  try { t = await Promise.race([cfg.sandbox.selfTest({ ...common, probes, signal: ac.signal }), hung]); } catch (e) { await release(); throw e; } finally { clearTimeout(timer); if (probes && typeof probes.release === "function") await probes.release().catch(() => {}); }
  if (!t.ok) { await release(); throw Object.assign(new Error(plainReason(t.failures)), { code: "sandbox_failed", failures: t.failures }); }
  // The same rules for every process the session starts (the agent, its tools, a helper): each gets its own plan with its own command, over the same session socket, a cleaned
  // environment and an argv with no credential in it.
  const partial = agent.settingsPaths && !agent.private ? { reason: /** @type {const} */ ("own_settings_folder"), folder: agent.settingsPaths, notice: PARTIAL_NOTICE } : undefined;
  return { sandboxed: true, release, ...(partial ? { partial } : {}), spawn: (command, args, env, cwd, opts) => {
    command = resolveAgentCommand(command, (env && env.PATH) || process.env.PATH);   // every process of the session runs by its absolute path
    checkArgs(args);
    const wd = cwd ? [...new Set([...s.workdirs, cwd])] : s.workdirs;
    checkWorkdirs(wd, cfg.home, vyreHome);
    return cfg.sandbox.launch(cfg.sandbox.planHome({ ...common, command, args, env: { ...cleanEnv({ ...(s.env || {}), ...(env || {}) }).env, ...trusted, ...credEnv }, readOnly: [...new Set([...programDirs(command, (env && env.PATH) || process.env.PATH), ...(s.readOnly || [])])], pathDirs: programDirs(command, (env && env.PATH) || process.env.PATH), workdirs: wd }), opts);
  } };
}
