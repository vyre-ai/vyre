// @ts-check
// The inference door's drivers for sign-in accounts: a person's own Claude, Codex or Grok subscription (a Claude setup token or login, a Codex login, a Grok login) and the API keys those CLIs take.
// The door (kernel/door/door.js) has already checked the chain, the budget and the residency, and scanned every message; this only runs ONE non-interactive turn of the provider's own CLI, the same
// runtime a chat on that account runs, and hands back the text and what it used. Any caller with a person's resolved account goes through here (a Flow's AI step today, a Routine or a Watcher next):
// the account is resolved for that person only BEFORE the door is called (sessions.accounts.resolve), and `credential` carries that one account and nothing else.
//
//   credential: { account: { id, provider, kind, label, uid? }, env: { <the variable the CLI reads>: value } (none for a login), home: the account's own folder for a login (null: the CLI's default) }
//
// How each one runs (one child per call, killed by its process group when it ends or times out):
//   claude  `claude -p --output-format json --tools "" --strict-mcp-config --setting-sources "" --no-session-persistence --disable-slash-commands --max-turns 1 --system-prompt <rules>`, the
//           conversation on stdin (core/memory/personal/reader.js claudeOnce runs the same flags). A setup token or key moves to descriptor 3 (spawn.js takeCredentialForFd), so not even the child's
//           own environment holds it.
//   codex   `codex exec --json --skip-git-repo-check --sandbox read-only -C <temp> -c mcp_servers={} -c features.shell_tool=false ... -`, the conversation on stdin; the text from
//           --output-last-message (or the JSON events), the usage from turn.completed. A login runs with the account's own CODEX_HOME; a key in OPENAI_API_KEY and CODEX_API_KEY.
//   grok    `grok --no-auto-update agent stdio`, as the Switchboard launches Grok chats (drivers/grok.js): initialize with no file or terminal capability, session/new with no MCP server, one
//           session/prompt; every permission question is answered "cancelled" and every client call refused. A key rides in XAI_API_KEY (method xai.api_key); a login is the account's own HOME.
//
// Every call: a fresh temp folder as the working folder (and as HOME when the account is a key or token, so no login of anyone else's is in reach); an environment built from nothing but PATH,
// the locale and the account's own variable (never vyred's own, which may hold another account's key); a time limit; at most PER_ACCOUNT calls of one account at once; and never another account
// or provider when this one fails. A failure is said in plain words with a code; nothing the CLI printed (which can hold the prompt) is put in it, and nothing here logs a token or a prompt.
// Where sessions start through the spawner (a server), the child starts there too, as the account's own uid for a login, so its sign-in stays out of every other account's reach.
//
// A step that expects a label or a JSON object (`expect`, lib/model-answer.js) is checked with the runner's own reading, and asked once more when the answer does not read.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSession, killGroup, usesSpawner } from "../spawn.js";
import { promptTokens } from "./acp.js";
import { answerReads, answerRule } from "../../../lib/model-answer.js";

/** The providers a sign-in driver serves. */
export const SIGNIN_DOOR_PROVIDERS = Object.freeze(["claude", "codex", "grok"]);
const NAME = /** @type {Record<string, string>} */ ({ claude: "Claude", codex: "Codex", grok: "Grok" });
export const TIMEOUT_MS = 120_000;
export const PER_ACCOUNT = 2;
const QUEUE_MAX = 32;
const MAX_OUT = 4_000_000;
const AUTH_MS = 20_000;
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,99}$/;

const fail = (/** @type {string} */ code, /** @type {string} */ message) => Object.assign(new Error(message), { code });

// What a CLI says when its sign-in or key no longer works, and when its plan's limit is reached (read, never repeated).
const EXPIRED = /\b401\b|\b403\b|unauthori[sz]ed|authentication[_ ](error|failed|required)|invalid[_ ](api[_ ]?key|x-api-key|bearer|token|grant|credentials?)|(token|session|credential|login)s? (has |have )?(expired|been revoked)|expired (oauth )?(token|session|credential|login)|refresh[_ ]token|log ?in again|sign ?in again|run \/login|not (logged|signed) in|login required|please (log|sign) ?in/i;
const LIMIT = /\b429\b|rate.?limit|usage limit|limit (reached|exceeded)|quota|too many requests|out of credits|credit balance/i;

/**
 * A CLI's failure in plain words. `said` is what it printed, only read here. @param {string} provider @param {{ kind?: string }} account
 * @param {{ said?: string, timedOut?: boolean, notFound?: boolean, exit?: number | null, timeoutMs?: number }} f @returns {Error}
 */
export function plainFailure(provider, account, f) {
  const n = NAME[provider] || provider, key = account && account.kind === "api-key";
  if (f.notFound) return fail("unavailable", `${n} is not installed on this computer, so this step could not run on your ${n} account. Nothing else was tried.`);
  if (f.timedOut) return fail("timeout", `Your ${n} account took longer than ${Math.round((f.timeoutMs || TIMEOUT_MS) / 1000)} seconds to answer, so this step stopped. Nothing else was tried.`);
  const said = String(f.said || "");
  if (EXPIRED.test(said)) return fail("signin_expired", key ? `Your ${n} key was refused. Add it again in Settings, AI accounts.` : `Your ${n} sign-in has expired. Sign in again in Settings, AI accounts.`);
  if (LIMIT.test(said)) return fail("rate_limited", `Your ${n} ${key ? "key" : "plan"} has reached its usage limit for now. Try again later, or pick another account of your own under Runs on.`);
  return fail("model_failed", `Your ${n} account could not answer this step${f.exit != null ? ` (it stopped with code ${f.exit})` : ""}. Nothing else was tried.`);
}

/** At most `cap` calls of one account at once; a further one waits its turn, and past QUEUE_MAX it is refused. @param {number} cap */
export function accountGate(cap) {
  /** @type {Map<string, { n: number, q: (() => void)[] }>} */ const busy = new Map();
  return {
    /** @template T @param {string} id @param {string} provider @param {() => Promise<T>} fn @returns {Promise<T>} */
    async run(id, provider, fn) {
      let s = busy.get(id);
      if (!s) { s = { n: 0, q: [] }; busy.set(id, s); }
      if (s.n >= cap) {
        if (s.q.length >= QUEUE_MAX) throw fail("busy", `Your ${NAME[provider] || provider} account is busy with other AI steps right now, so this one did not run. Nothing else was tried.`);
        await new Promise(r => /** @type {any} */ (s).q.push(r));   // the slot is handed over, never counted twice
      } else s.n++;
      try { return await fn(); }
      finally { const next = s.q.shift(); if (next) next(); else { s.n--; if (!s.n) busy.delete(id); } }
    },
    /** How many calls of `id` run now (tests). @param {string} id */
    running: id => (busy.get(id) ? /** @type {any} */ (busy.get(id)).n : 0),
  };
}

/** The system words and the conversation as one text, for a CLI that takes one prompt. @param {any[]} messages @param {any} expect */
function promptOf(messages, expect) {
  const sys = messages.filter(m => m.role === "system").map(m => String(m.content)).join("\n\n");
  const rest = messages.filter(m => m.role !== "system");
  const talk = rest.length === 1 ? String(rest[0].content) : rest.map(m => `${m.role === "assistant" ? "Assistant" : "User"}: ${String(m.content)}`).join("\n\n");
  const rule = answerRule(expect);
  return { system: [sys, rule, "Do not use any tool. Answer from the text you are given."].filter(Boolean).join("\n\n"), talk, rule };
}

/**
 * Run one child to its end. @param {any} io @param {string} bin @param {string[]} args
 * @param {{ env: Record<string, string>, cwd?: string, stdin?: string, timeoutMs: number, spawner: boolean, uid?: number | null, onLine?: (line: string, child: any) => void }} o
 * @returns {Promise<{ out: string, err: string, exit: number | null, timedOut: boolean, notFound: boolean }>}
 */
function runChild(io, bin, args, o) {
  return new Promise(resolve => {
    let out = "", err = "", buf = "", timedOut = false, notFound = false, done = false;
    /** @type {any} */ let child;
    const finish = (/** @type {number | null} */ exit) => { if (done) return; done = true; clearTimeout(timer); killGroup(child, "SIGKILL"); resolve({ out, err, exit, timedOut, notFound }); };
    const timer = setTimeout(() => { timedOut = true; finish(null); }, o.timeoutMs);
    try {
      child = io.spawn(bin, args, { env: o.env, ...(o.cwd ? { cwd: o.cwd } : {}), spawner: o.spawner, ...(o.spawner && typeof o.uid === "number" ? { account: { uid: o.uid } } : {}) });
    } catch (e) { notFound = /** @type {any} */ (e).code === "ENOENT"; finish(null); return; }
    child.on("error", (/** @type {any} */ e) => { if (e && e.code === "ENOENT") notFound = true; finish(null); });
    child.stdout.on("data", (/** @type {Buffer} */ d) => {
      if (out.length + d.length > MAX_OUT) { finish(null); return; }
      const t = d.toString("utf8"); out += t;
      if (o.onLine) { buf += t; let i; while ((i = buf.indexOf("\n")) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1); if (line.trim()) o.onLine(line, child); } }
    });
    child.stderr.on("data", (/** @type {Buffer} */ d) => { if (err.length < 65_536) err += d.toString("utf8"); });
    child.on("close", (/** @type {number | null} */ code) => finish(code));
    if (child.stdin) {
      child.stdin.on("error", () => {});   // a CLI that exits before it reads (not signed in, a crash at start) closes the pipe: its exit says why
      if (o.stdin !== undefined) child.stdin.end(o.stdin);
    }
  });
}

/** Token counts as the door and the runner read them. @param {number} i @param {number} o @param {number} [usd] */
const usageOf = (i, o, usd) => ({ input_tokens: Math.max(0, Math.round(i) || 0), output_tokens: Math.max(0, Math.round(o) || 0), ...(usd ? { cost_usd: usd } : {}) });

/** @param {{ spawn?: typeof spawnSession, bins?: Partial<Record<string, string>>, timeoutMs?: number, perAccount?: number, spawner?: () => boolean, tmp?: string }} [io] */
export function signinDoorDrivers(io = {}) {
  const deps = { spawn: io.spawn || spawnSession };
  const gate = accountGate(io.perAccount || PER_ACCOUNT);
  const viaSpawner = io.spawner || usesSpawner;
  const binOf = (/** @type {string} */ p) => (io.bins && io.bins[p]) || (p === "claude" ? process.env.VYRE_CLAUDE_BIN : p === "codex" ? process.env.VYRE_CODEX_BIN : process.env.VYRE_GROK_BIN) || p;
  const timeoutMs = Number(io.timeoutMs) || Number(process.env.VYRE_SIGNIN_DOOR_TIMEOUT_MS) || TIMEOUT_MS;

  /** The account's own place and variables, and a fresh temp folder. @param {string} provider @param {any} input */
  function prepare(provider, input) {
    const c = input.credential || {}, a = c.account || {};
    if (String(a.provider || "") !== provider) throw fail("bad_input", `this call names no ${NAME[provider]} account, so nothing was sent`);
    const env = /** @type {Record<string, string>} */ ({});
    for (const [k, v] of Object.entries(c.env || {})) if (/^[A-Z][A-Z0-9_]{0,63}$/.test(k) && typeof v === "string" && v) env[k] = v;
    const login = a.kind === "login";
    if (!login && !Object.keys(env).length) throw fail("no_credential", `Your ${NAME[provider]} account gave no sign-in to this step. Add it again in Settings, AI accounts.`);
    const spawner = Boolean(viaSpawner());
    const home = c.home ? String(c.home) : null;
    if (home && !path.isAbsolute(home)) throw fail("bad_input", "the account's folder is not a full path");
    if (login && spawner && typeof a.uid !== "number") throw fail("no_credential", `Your ${NAME[provider]} sign-in has no user of its own on this server. Sign in again in Settings, AI accounts.`);
    const tmp = fs.mkdtempSync(path.join(io.tmp || os.tmpdir(), `vyre-door-${provider}-`));
    const model = typeof input.model === "string" && input.model !== "default" && MODEL_RE.test(input.model) ? input.model : null;
    const base = { PATH: process.env.PATH || "/usr/local/bin:/usr/bin:/bin", LANG: process.env.LANG || "C.UTF-8", TMPDIR: tmp, ...(process.env.TZ ? { TZ: process.env.TZ } : {}) };
    // HOME: a login's own folder (the spawner sets the account uid's own); a key or token gets an empty one of its own, so nobody's stored login is in reach
    // (Claude keeps the home's own login in this user's own folder, so only the home's own login account, which no member holds, runs there)
    const ownHome = login ? (spawner ? null : home || (provider === "claude" && !a.person ? os.homedir() : null)) : (spawner ? null : path.join(tmp, "home"));
    if (login && !spawner && !ownHome) { fs.rmSync(tmp, { recursive: true, force: true }); throw fail("no_credential", `Your ${NAME[provider]} sign-in has no folder on this computer. Sign in again in Settings, AI accounts.`); }
    if (ownHome && !login) fs.mkdirSync(ownHome, { recursive: true, mode: 0o700 });
    return { a, env, login, spawner, tmp, model, base, home: ownHome, uid: typeof a.uid === "number" ? a.uid : null, cwd: spawner ? undefined : tmp };
  }

  /** One Claude turn. @param {any} p @param {{ system: string, talk: string }} q */
  async function claudeOnce(p, q) {
    const args = ["-p", "--output-format", "json", "--tools", "", "--strict-mcp-config", "--setting-sources", "", "--no-session-persistence", "--disable-slash-commands", "--max-turns", "1",
      "--system-prompt", q.system, ...(p.model ? ["--model", p.model] : [])];
    const env = { ...p.base, ...(p.home ? { HOME: p.home } : {}), DISABLE_AUTOUPDATER: "1", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", MAX_THINKING_TOKENS: "0", ...p.env };
    const r = await runChild(deps, binOf("claude"), args, { env, cwd: p.cwd, stdin: q.talk, timeoutMs, spawner: p.spawner, uid: p.login ? p.uid : null });
    /** @type {any} */ let j = null;
    for (const line of r.out.trim().split("\n").reverse()) { try { j = JSON.parse(line); break; } catch { /* not this line */ } }
    if (r.timedOut || r.notFound || !j || j.is_error || r.exit !== 0) throw plainFailure("claude", p.a, { ...r, said: `${j && j.result ? j.result : ""}\n${r.err}`, timeoutMs });
    const u = j.usage || {};
    return { content: String(j.result ?? ""), usage: usageOf(Number(u.input_tokens || 0) + Number(u.cache_read_input_tokens || 0) + Number(u.cache_creation_input_tokens || 0), Number(u.output_tokens || 0), p.a.kind === "api-key" ? Number(j.total_cost_usd) || 0 : 0) };
  }

  /** One Codex turn. @param {any} p @param {{ system: string, talk: string }} q */
  async function codexOnce(p, q) {
    const last = p.spawner ? null : path.join(p.tmp, "answer.txt");
    const args = ["exec", "--json", "--skip-git-repo-check", "--sandbox", "read-only", ...(last ? ["--output-last-message", last, "-C", p.tmp] : []),
      "-c", "mcp_servers={}", "-c", "features.shell_tool=false", "-c", "features.web_search_request=false", "-c", 'approval_policy="never"', ...(p.model ? ["-m", p.model] : []), "-"];
    const codexHome = p.home ? path.join(p.home, ".codex") : null;   // a login's own sign-in folder, or an empty one of this call's for a key
    if (codexHome && !p.login) fs.mkdirSync(codexHome, { recursive: true, mode: 0o700 });
    const key = p.env.OPENAI_API_KEY || p.env.CODEX_API_KEY;
    const env = { ...p.base, ...(p.home ? { HOME: p.home } : {}), ...(codexHome ? { CODEX_HOME: codexHome } : {}), ...(key ? { OPENAI_API_KEY: key, CODEX_API_KEY: key } : {}) };
    let text = "", said = "";
    /** @type {any} */ let usage = null;
    const r = await runChild(deps, binOf("codex"), args, { env, cwd: p.cwd, stdin: `${q.system}\n\n${q.talk}`, timeoutMs, spawner: p.spawner, uid: p.login ? p.uid : null, onLine: line => {
      /** @type {any} */ let e; try { e = JSON.parse(line); } catch { return; }
      const item = e && e.item, msg = e && e.msg;
      if (e.type === "item.completed" && item && (item.type === "agent_message" || item.item_type === "agent_message" || item.item_type === "assistant_message") && typeof item.text === "string") text = item.text;
      else if (msg && msg.type === "agent_message" && typeof msg.message === "string") text = msg.message;
      if (e.type === "turn.completed" && e.usage) usage = e.usage;
      if (e.type === "turn.failed" || e.type === "error" || (msg && msg.type === "error")) said += `\n${String((e.error && e.error.message) || e.message || (msg && msg.message) || "")}`;
    } });
    if (last) { try { const t = fs.readFileSync(last, "utf8"); if (t.trim()) text = t; } catch { /* the events said it, or nothing did */ } }
    if (r.timedOut || r.notFound || r.exit !== 0 || (!text.trim() && said)) throw plainFailure("codex", p.a, { ...r, said: `${said}\n${r.err}`, timeoutMs });
    const u = usage || {};
    return { content: text.trim(), usage: usageOf(Number(u.input_tokens || 0), Number(u.output_tokens || 0)) };
  }

  /** One Grok turn over ACP. @param {any} p @param {{ system: string, talk: string }} q */
  async function grokOnce(p, q) {
    const env = { ...p.base, ...(p.home ? { HOME: p.home } : {}), GROK_CLAUDE_MCPS_ENABLED: "0", GROK_CURSOR_MCPS_ENABLED: "0", ...(p.env.XAI_API_KEY ? { XAI_API_KEY: p.env.XAI_API_KEY } : {}) };
    /** @type {Map<number, { resolve: (v: any) => void, reject: (e: any) => void, timer?: any }>} */ const waits = new Map();
    let next = 1, sid = "", text = "", said = "";
    /** @type {any} */ let child = null;
    const send = (/** @type {any} */ m) => { try { child.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\n"); } catch { /* gone: its exit answers */ } };
    const request = (/** @type {string} */ method, /** @type {any} */ params, ms = 0) => new Promise((resolve, reject) => {
      const id = next++; const w = { resolve, reject, timer: /** @type {any} */ (null) };
      if (ms) w.timer = setTimeout(() => { waits.delete(id); reject(Object.assign(new Error("no answer"), { code: "timeout" })); }, ms);
      waits.set(id, w); send({ id, method, params });
    });
    const onLine = (/** @type {string} */ line, /** @type {any} */ c) => {
      child = c;
      /** @type {any} */ let m; try { m = JSON.parse(line); } catch { return; }
      if (m.id !== undefined && m.method === undefined) { const w = waits.get(m.id); if (!w) return; waits.delete(m.id); clearTimeout(w.timer); if (m.error) { said += `\n${String(m.error.message || "")}`; w.reject(Object.assign(new Error("refused"), { rpc: m.error.code })); } else w.resolve(m.result || {}); return; }
      if (m.method === "session/update") { const u = m.params && m.params.update; if (u && u.sessionUpdate === "agent_message_chunk" && (!sid || m.params.sessionId === sid) && u.content && typeof u.content.text === "string") text += u.content.text; return; }
      // no tool runs: every permission question is answered cancelled, every file or terminal call refused
      if (m.id !== undefined && m.method === "session/request_permission") { send({ id: m.id, result: { outcome: { outcome: "cancelled" } } }); return; }
      if (m.id !== undefined) send({ id: m.id, error: { code: -32601, message: "this client offers no files, terminals or tools" } });
    };
    /** @type {any} */ let answer = null; /** @type {any} */ let broke = null;
    const started = runChild({ spawn: (/** @type {string} */ b, /** @type {string[]} */ a, /** @type {any} */ o) => { child = deps.spawn(b, a, o); return child; } }, binOf("grok"), ["--no-auto-update", "agent", "stdio"],
      { env, cwd: p.cwd, timeoutMs, spawner: p.spawner, uid: p.login ? p.uid : null, onLine });
    const talk = (async () => {
      const init = await request("initialize", { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false }, clientInfo: { name: "vyre", version: "0.6" } });
      const methods = (Array.isArray(init.authMethods) ? init.authMethods : []).map((/** @type {any} */ x) => String(x && x.id));
      const open = () => request("session/new", { cwd: p.cwd || p.home || p.tmp, mcpServers: [] });
      let s;
      try { s = await open(); } catch (e) {
        if (/** @type {any} */ (e).rpc !== -32000) throw e;
        const methodId = env.XAI_API_KEY && methods.includes("xai.api_key") ? "xai.api_key" : methods.includes("grok.com") ? "grok.com" : null;
        if (!methodId) { said += "\nnot logged in"; throw e; }
        try { await request("authenticate", { methodId }, AUTH_MS); } catch { said += "\nsign in again"; throw e; }   // a login that waits for a browser is a login that is not there
        s = await open();
      }
      sid = String(s.sessionId || "");
      answer = await request("session/prompt", { sessionId: sid, prompt: [{ type: "text", text: `${q.system}\n\n${q.talk}` }] });
    })().catch(e => { broke = e; }).finally(() => { try { child && child.stdin && child.stdin.end(); } catch { /* gone */ } killGroup(child, "SIGTERM"); });
    const r = await started;
    // the child is gone (it answered, it ended, or the time ran out): whatever is still asked of it is answered now, so nothing waits for ever
    for (const w of waits.values()) { clearTimeout(w.timer); w.reject(new Error("the agent ended")); }
    waits.clear();
    await talk;
    if (r.timedOut || r.notFound || broke || !answer) throw plainFailure("grok", p.a, { ...r, said: `${said}\n${r.err}`, timeoutMs, exit: r.exit });
    const u = promptTokens(answer);
    return { content: text.trim(), usage: usageOf(Number(u.input_tokens || 0) + Number(u.cache_read_input_tokens || 0), Number(u.output_tokens || 0)) };
  }

  const ONCE = /** @type {Record<string, (p: any, q: { system: string, talk: string }) => Promise<{ content: string, usage: any }>>} */ ({ claude: claudeOnce, codex: codexOnce, grok: grokOnce });

  /** @param {string} provider */
  const driver = provider => ({
    /**
     * One answer on the person's own account. The door passes the scanned messages, `credential` (see the head of this file), `model` ("default": the account's own), and a step's `expect`.
     * @param {{ messages: any[], model?: string, expect?: any, credential?: any }} input
     */
    async call(input) {
      const p = prepare(provider, input);
      try {
        return await gate.run(String(p.a.id || ""), provider, async () => {
          const q = promptOf(input.messages || [], input.expect);
          const first = await ONCE[provider](p, q);
          if (!input.expect || answerReads(first.content, input.expect)) return first;
          // the answer did not read as the step asked: once more, with the rule said again after the text
          const again = await ONCE[provider](p, { system: q.system, talk: `${q.talk}\n\n${q.rule}` });
          return { content: again.content, usage: usageOf(first.usage.input_tokens + again.usage.input_tokens, first.usage.output_tokens + again.usage.output_tokens, (first.usage.cost_usd || 0) + (again.usage.cost_usd || 0)) };
        });
      } finally { fs.rmSync(p.tmp, { recursive: true, force: true }); }
    },
  });
  return { claude: driver("claude"), codex: driver("codex"), grok: driver("grok"), gate };
}
