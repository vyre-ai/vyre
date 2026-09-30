// @ts-check
// The checks every module must pass (ADR 0047 section 7), the modules counterpart of sessions'
// conform(). `vyre module test` runs it, then the module's own tests; CI runs it on
// examples/modules/* (test/module-api-compat.test.js).
//
//   import { conformModule } from "@vyre/module-sdk/conform";
//   const failures = await conformModule("./bakery");   // [] means it conforms
//
// Each failure is one line a person or an agent can act on. The module runs in the testing
// harness (testing.js) over a temp home, so nothing here reaches a daemon, the network or a
// person. Timers are watched by wrapping setTimeout and setInterval for the whole run.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { checkManifest, checkSchema, toolEntries } from "./manifest.js";
import { createTestContext } from "./testing.js";

/** Node built ins an added module may not import: a process, a socket or a thread of its own. */
const FORBIDDEN_BUILTINS = ["child_process", "net", "http", "https", "http2", "dgram", "worker_threads", "cluster", "tls", "dns", "inspector"];
/** How long start and stop may take (ADR 0047 section 3). */
const START_MS = 2_000, STOP_MS = 5_000;
/** Nothing polls faster than this. */
const MIN_INTERVAL_MS = 60_000;
/**
 * Words no user-facing string may carry: the names Vyre was first built around. The same encoded
 * list as scripts/lib/hygiene.js FORBIDDEN (test/module-sdk-conform.test.js keeps them equal),
 * stored encoded so this file never matches itself.
 */
export const GUARD_WORDS = ["aXJmYWQ=", "bXlsZWdhbGFjYWRlbXk=", "cmFucWw=", "aXZ5cw==", "a2F6YWxhdw==", "dGVjaG1hbmFnZXI="]
  .map(b => Buffer.from(b, "base64").toString("utf8"));

/** Every import specifier in a source file: static, dynamic with a literal, export from, require. @param {string} src */
export function importsOf(src) {
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
  const out = new Set();
  for (const re of [/\bimport\s+(?:[\w*{}\s,$]+\s+from\s+)?["']([^"']+)["']/g, /\bexport\s+[\w*{}\s,$]+\s+from\s+["']([^"']+)["']/g,
    /\bimport\s*\(\s*["'`]([^"'`]+)["'`]\s*\)/g, /\brequire\s*\(\s*["'`]([^"'`]+)["'`]\s*\)/g]) {
    for (const m of code.matchAll(re)) out.add(m[1]);
  }
  return [...out];
}

/**
 * The static import scan: nothing leaves the module folder, nothing reaches into Vyre's own files,
 * and no process, socket or thread of its own. Test files are skipped, since the host never loads
 * them. @param {string} dir @returns {string[]}
 */
export function scanImports(dir) {
  const out = [];
  const root = path.resolve(dir);
  /** @param {string} at */
  const walk = at => {
    for (const e of fs.readdirSync(at, { withFileTypes: true })) {
      const p = path.join(at, e.name);
      if (e.isDirectory()) { if (!["node_modules", ".git"].includes(e.name)) walk(p); continue; }
      if (!/\.(m|c)?js$/.test(e.name) || /\.test\.(m|c)?js$/.test(e.name)) continue;
      const rel = path.relative(root, p);
      for (const spec of importsOf(fs.readFileSync(p, "utf8"))) {
        const bare = spec.replace(/^node:/, "").split("/")[0];
        if (FORBIDDEN_BUILTINS.includes(bare) && (spec.startsWith("node:") || !spec.includes("/") || spec === `${bare}/promises`)) {
          out.push(`${rel} imports ${spec}; a module has no process, socket or thread of its own: use ctx.fetch, ctx.vault.request or ctx.call`);
        } else if (spec.includes("/core/") || /^(\.\.?\/)*core\//.test(spec)) {
          out.push(`${rel} imports ${spec}; a module never imports Vyre's files: use ctx`);
        } else if (spec.startsWith(".") || spec.startsWith("/") || spec.startsWith("file:")) {
          const target = spec.startsWith("file:") ? new URL(spec).pathname : path.resolve(path.dirname(p), spec);
          if (target !== root && !target.startsWith(root + path.sep)) out.push(`${rel} imports ${spec}, which is outside the module folder`);
        }
      }
    }
  };
  walk(root);
  return out;
}

/** The module's own source files the host loads: every .js but tests, outside node_modules. @param {string} dir */
function sources(dir) {
  const root = path.resolve(dir), out = [];
  /** @param {string} at */
  const walk = at => {
    for (const e of fs.readdirSync(at, { withFileTypes: true })) {
      const p = path.join(at, e.name);
      if (e.isDirectory()) { if (!["node_modules", ".git"].includes(e.name)) walk(p); continue; }
      if (/\.(m|c)?js$/.test(e.name) && !/\.test\.(m|c)?js$/.test(e.name)) out.push({ rel: path.relative(root, p), code: fs.readFileSync(p, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1") });
    }
  };
  walk(root);
  return out;
}

/**
 * Each ctx door has one declaration (ADR 0047 section 3). What the source shows statically: a door
 * used with no declaration at all, and a literal tool, credential, provider, host, memory kind or
 * notice kind that isn't declared. The harness catches the rest when the examples run.
 * @param {string} dir @param {any} m @returns {string[]}
 */
export function scanDoors(dir, m) {
  const out = [];
  const list = (/** @type {any} */ v) => (Array.isArray(v) ? v : []);
  const needs = m && typeof m.needs === "object" && m.needs ? m.needs : {};
  const tools = list(needs.tools), own = toolEntries(m).map(t => t.name);
  const creds = list(needs.credentials).map((/** @type {any} */ c) => c && c.id);
  const providers = list(needs.connections).map((/** @type {any} */ c) => c && c.provider);
  const hosts = list(needs.network);
  const kinds = list(m && m.teaches && m.teaches.memory);
  const notices = list(m && m.shows && m.shows.notices);
  const spend = Boolean(needs.spend);
  const lit = `\\(\\s*["'\`]([^"'\`]+)["'\`]`;
  const callable = (/** @type {string} */ t) => own.includes(t) || tools.some((/** @type {string} */ p) => p === t || (p.endsWith(".*") && t.startsWith(p.slice(0, -1))));
  const hostOk = (/** @type {string} */ url) => {
    let u;
    try { u = new URL(url); } catch { return true; }
    return hosts.some((/** @type {string} */ h) => { const [n] = h.split(":"); return n.startsWith("*.") ? u.hostname.endsWith(n.slice(1)) : u.hostname === n; });
  };
  for (const { rel, code } of sources(dir)) {
    const say = (/** @type {string} */ why) => out.push(`${rel}: ${why} (undeclared)`);
    for (const x of code.matchAll(new RegExp(`\\bctx\\.call${lit}`, "g"))) if (!callable(x[1])) say(`ctx.call("${x[1]}") needs "${x[1]}" in needs.tools`);
    if (/\bctx\.gate\.request\s*\(/.test(code) && !tools.includes("gate.request")) say(`ctx.gate.request needs "gate.request" in needs.tools`);
    if (/\bctx\.vault\.request\s*\(/.test(code) && !creds.length) say("ctx.vault.request needs a credential under needs.credentials");
    for (const x of code.matchAll(new RegExp(`\\bctx\\.vault\\.request${lit}`, "g"))) if (creds.length && !creds.includes(x[1])) say(`ctx.vault.request("${x[1]}") needs the id ${x[1]} under needs.credentials`);
    if (/\bctx\.connections\.call\s*\(/.test(code) && !providers.length) say("ctx.connections.call needs a provider under needs.connections");
    for (const x of code.matchAll(new RegExp(`\\bctx\\.connections\\.call${lit}`, "g"))) if (providers.length && !providers.includes(x[1])) say(`ctx.connections.call("${x[1]}") needs ${x[1]} under needs.connections`);
    if (/\bctx\.fetch\s*\(/.test(code) && !hosts.length) say("ctx.fetch needs a host under needs.network");
    for (const x of code.matchAll(new RegExp(`\\bctx\\.fetch${lit}`, "g"))) if (hosts.length && !hostOk(x[1])) say(`ctx.fetch("${x[1]}") needs its host under needs.network`);
    if (/\bctx\.(ask\s*\(|spend\.)/.test(code) && !spend) say("ctx.ask and ctx.spend need needs.spend with a dailyUsd cap");
    for (const x of code.matchAll(/\bctx\.memory\.write\s*\(([\s\S]{0,300})/g)) {
      const k = /\bkind\s*:\s*["'](\w+)["']/.exec(x[1]);
      if (!kinds.includes("fact") && !kinds.includes("note")) say("ctx.memory.write needs \"fact\" or \"note\" under teaches.memory");
      else if (k && !kinds.includes(k[1])) say(`ctx.memory.write a ${k[1]} needs "${k[1]}" under teaches.memory`);
    }
    for (const x of code.matchAll(/\bctx\.push\.offer\s*\(([\s\S]{0,400})/g)) {
      const k = /\bkind\s*:\s*["']([\w.-]+)["']/.exec(x[1]);
      if (!notices.length) say("ctx.push.offer needs its kind under shows.notices");
      else if (k && !notices.includes(k[1])) say(`ctx.push.offer a ${k[1]} notice needs "${k[1]}" under shows.notices`);
    }
  }
  return [...new Set(out)];
}

/** Problems with a user-facing string: an em dash, a section sign or a guard word. @param {string} where @param {unknown} text */
function wording(where, text) {
  if (typeof text !== "string") return [];
  const out = [];
  if (text.includes("\u2014")) out.push(`${where} has an em dash; use a colon, a comma or two sentences`);
  if (text.includes("\u00a7")) out.push(`${where} has a section sign; write "section"`);
  const lower = text.toLowerCase();
  if (GUARD_WORDS.some(w => lower.includes(w))) out.push(`${where} names a real person or business; use the sample world (alex, Harlow Legal, Northwind Bakery, juno, kit)`);
  return out;
}

/**
 * Timers the module arms, watched for the whole run. Returns the wrapped globals' restore.
 */
function watchTimers() {
  const real = { setTimeout: globalThis.setTimeout, setInterval: globalThis.setInterval, clearTimeout: globalThis.clearTimeout, clearInterval: globalThis.clearInterval };
  /** @type {Map<any, { kind: "timeout" | "interval", ms: number, armed: boolean, phase: string }>} */
  const timers = new Map();
  const state = { phase: "start" };
  const g = /** @type {any} */ (globalThis);
  g.setTimeout = (/** @type {Function} */ fn, /** @type {number} */ ms, /** @type {any[]} */ ...args) => {
    const rec = { kind: /** @type {const} */ ("timeout"), ms: Number(ms) || 0, armed: true, phase: state.phase };
    const h = real.setTimeout(() => { rec.armed = false; fn(...args); }, ms);
    timers.set(h, rec);
    return h;
  };
  g.setInterval = (/** @type {Function} */ fn, /** @type {number} */ ms, /** @type {any[]} */ ...args) => {
    const h = real.setInterval(fn, ms, ...args);
    timers.set(h, { kind: "interval", ms: Number(ms) || 0, armed: true, phase: state.phase });
    return h;
  };
  const clear = (/** @type {any} */ h) => { const r = timers.get(h); if (r) r.armed = false; };
  g.clearTimeout = (/** @type {any} */ h) => { clear(h); real.clearTimeout(h); };
  g.clearInterval = (/** @type {any} */ h) => { clear(h); real.clearInterval(h); };
  return {
    real, state,
    armed: () => [...timers.values()].filter(t => t.armed),
    /** Clear whatever is still armed, then put the real functions back. */
    restore() {
      for (const [h, r] of timers) if (r.armed) { real.clearTimeout(h); real.clearInterval(h); r.armed = false; }
      Object.assign(g, real);
    },
  };
}

/** A promise raced against a deadline: resolves { ok, value } or { ok: false } at the deadline. */
function within(/** @type {Promise<any>} */ p, /** @type {number} */ ms, /** @type {typeof setTimeout} */ timer) {
  let t;
  const late = new Promise(resolve => { t = timer(() => resolve({ ok: false, late: true }), ms); });
  return Promise.race([p.then(value => ({ ok: true, value }), error => ({ ok: false, error })), late]).finally(() => clearTimeout(t));
}

/** Whether a value survives JSON unchanged. @param {unknown} v */
function isJson(v) {
  if (v === undefined) return true;
  try { return JSON.stringify(JSON.parse(JSON.stringify(v))) === JSON.stringify(v) && !hasOdd(v); } catch { return false; }
}
/** Functions, bigints, symbols or a non-plain object inside. @param {any} v @returns {boolean} */
function hasOdd(v) {
  if (v === null) return false;
  const t = typeof v;
  if (t === "function" || t === "bigint" || t === "symbol") return true;
  if (t === "number") return !Number.isFinite(v);
  if (t !== "object") return false;
  if (Array.isArray(v)) return v.some(hasOdd);
  const proto = Object.getPrototypeOf(v);
  if (proto !== Object.prototype && proto !== null) return true;
  return Object.values(v).some(hasOdd);
}

/** The schema of the module's own tables, to compare after a second start. @param {any} db */
const schemaOf = db => JSON.stringify(db.prepare("SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND name != '_migrations' ORDER BY name").all());

/** Who calls a tool when its examples run: someone its reach lets in, the person where it can. */
const callerFor = (/** @type {string} */ reach) => (reach === "modules" ? "module" : reach === "hook" ? "hook" : "person");

/**
 * Run the conformance checks on a module folder. Empty means it conforms.
 * @param {string} dir
 * @param {import("./testing.js").Options & { firstParty?: boolean }} [opts]
 * @returns {Promise<string[]>}
 */
export async function conformModule(dir, opts = {}) {
  const fails = [];
  const firstParty = Boolean(opts.firstParty);
  /** @type {any} */
  let m;
  try { m = JSON.parse(fs.readFileSync(path.join(dir, "module.json"), "utf8")); }
  catch (e) { return [`module.json does not read: ${/** @type {Error} */ (e).message}`]; }

  // 1. The manifest, as an added module unless told otherwise.
  for (const p of checkManifest(m, { firstParty })) fails.push(`manifest: ${p}`);
  // 2. The static import scan, and the ctx doors the source uses against their declarations.
  fails.push(...scanImports(dir));
  fails.push(...scanDoors(dir, m));
  // 11. User-facing strings in the manifest.
  fails.push(...wording("description", m.description));
  for (const t of toolEntries(m)) fails.push(...wording(`tool ${t.name} summary`, t.summary));
  for (const c of (m.does && Array.isArray(m.does.commands) ? m.does.commands : [])) fails.push(...wording(`command ${c && c.verb} summary`, c && c.summary));
  for (const s of Array.isArray(m.settings) ? m.settings : []) { fails.push(...wording(`setting ${s && s.key} label`, s && s.label)); fails.push(...wording(`setting ${s && s.key} help`, s && s.help)); }
  for (const t of (m.teaches && Array.isArray(m.teaches.tips) ? m.teaches.tips : [])) fails.push(...wording(`tip ${t && t.id}`, t && t.text));
  if (fails.some(f => f.startsWith("manifest: ")) && !TYPES_OK(m)) return fails;

  const entry = path.resolve(dir, typeof m.main === "string" && m.main ? m.main : "index.js");
  const home = fs.mkdtempSync(path.join(os.tmpdir(), `vyre-conform-${m.name}-`));
  const timers = watchTimers();
  const real = timers.real;
  try {
    /** @type {any} */
    let mod;
    try { mod = (await import(pathToFileURL(entry).href)).default; }
    catch (e) { fails.push(`the entry file does not load: ${/** @type {Error} */ (e).message}`); return fails; }
    if (!mod || typeof mod.start !== "function") { fails.push("the entry file must export default { start(ctx) }"); return fails; }

    // 3. start within 2 s, registering exactly what it declares.
    const t = createTestContext(m, { ...opts, home, firstParty });
    const started = await within(Promise.resolve().then(() => mod.start(t.ctx)), START_MS, real.setTimeout);
    timers.state.phase = "run";
    if (!started.ok) {
      fails.push(started.late ? `start did not return within ${START_MS / 1000} s; do slow work after it returns` : `start threw: ${started.error && started.error.message}`);
      await t.stop();
      return fails;
    }
    const handle = started.value;
    if (!handle || typeof handle.stop !== "function") fails.push("start must return { stop() }");
    for (const e of toolEntries(m)) if (!t.tools.has(e.name)) fails.push(`${e.name} is declared under does.tools, but start did not register it`);
    for (const [list, key, declared] of /** @type {const} */ ([["providers", "does.providers", m.does && m.does.providers], ["streams", "shows.streams", m.shows && m.shows.streams]])) {
      for (const n of declared || []) if (!t.registered[list].includes(n)) fails.push(`${n} is declared under ${key}, but start did not register it`);
    }
    // 8. No timer under 60 s left armed after start.
    for (const x of timers.armed()) if (x.kind === "interval" && x.ms < MIN_INTERVAL_MS) fails.push(`start left a ${x.ms} ms interval running; nothing polls faster than 60 s, and events come before timers`);

    // 4. Every tool's examples validate and run, and answer JSON. 6 and 7 use the same inputs.
    /** @type {Map<string, number>} how often each tool's run was entered */
    const runs = new Map();
    for (const [name, def] of t.tools) {
      const run = def.run;
      def.run = (/** @type {any} */ input, /** @type {any} */ meta) => { runs.set(name, (runs.get(name) || 0) + 1); return run(input, meta); };
    }
    for (const [name, def] of t.tools) {
      const examples = Array.isArray(def.examples) ? def.examples : [];
      fails.push(...wording(`tool ${name} description`, def.description));
      if (!examples.length) { fails.push(`${name} has no examples; give ctx.tool at least one { input } the conformance test can call`); continue; }
      const { reach, outward } = def.entry;
      for (const [i, ex] of examples.entries()) {
        const input = ex && ex.input !== undefined ? ex.input : {};
        const bad = checkSchema(def.input, input, `${name} examples[${i}].input`);
        if (bad.length) { fails.push(...bad); continue; }
        const r = await t.call(name, input, { who: callerFor(reach) });
        if (r.error && ["failed", "bad_input", "no_such_tool", "undeclared"].includes(r.error.code)) fails.push(`${name} examples[${i}] failed: ${r.error.message}${r.error.code === "failed" ? " (throw an Error with a short lowercase code for an expected refusal)" : ""}`);
        else if (r.data !== undefined && !isJson(r.data)) fails.push(`${name} examples[${i}] answered something that isn't JSON`);
      }
      const input = examples[0] && examples[0].input !== undefined ? examples[0].input : {};
      if (checkSchema(def.input, input).length) continue;
      // 6. An outward tool called by an agent without an ask is held and doesn't run; the person's tap runs it once.
      if (outward) {
        const before = runs.get(name) || 0;
        const held = await t.call(name, input, { who: "agent" });
        if (!held || !("held" in held)) fails.push(`${name} is outward, but an agent's call without an ask was not held at the Gate`);
        if ((runs.get(name) || 0) !== before) fails.push(`${name} ran for an agent that wasn't asked; an outward tool runs only after the Gate`);
        await t.call(name, input, { who: "person" });
        if ((runs.get(name) || 0) !== before + 1) fails.push(`${name} did not run exactly once for the person's own tap`);
      }
      // 7. An asked tool called by an agent without an ask answers not_asked.
      if (reach === "asked") {
        const before = runs.get(name) || 0;
        const r = await t.call(name, input, { who: "agent" });
        if (!r.error || r.error.code !== "not_asked") fails.push(`${name} is asked, but an agent's call without an ask did not answer not_asked`);
        if ((runs.get(name) || 0) !== before) fails.push(`${name} ran for an agent that wasn't asked`);
      }
    }
    // 5. Every event it emitted and every tool it called is declared.
    for (const v of t.violations) fails.push(`it did something its manifest doesn't declare: ${v}`);

    // 9. stop within 5 s, with no timer left behind.
    timers.state.phase = "stop";
    if (handle && typeof handle.stop === "function") {
      const stopped = await within(Promise.resolve().then(() => handle.stop()), STOP_MS, real.setTimeout);
      if (!stopped.ok) fails.push(stopped.late ? `stop did not finish within ${STOP_MS / 1000} s` : `stop threw: ${stopped.error && stopped.error.message}`);
    }
    for (const x of timers.armed()) fails.push(`${x.kind === "interval" ? "an" : "a"} ${x.kind} of ${x.ms} ms (armed during ${x.phase}) was still running after stop; clear it in stop()`);
    const schema = schemaOf(t.ctx.store.db);
    await t.stop();

    // 10. Migrations run twice leave one schema: start again over the same home.
    const again = createTestContext(m, { ...opts, home, firstParty });
    const second = await within(Promise.resolve().then(() => mod.start(again.ctx)), START_MS, real.setTimeout);
    if (!second.ok) fails.push(`a second start over the same data failed: ${second.late ? "it did not return within 2 s" : second.error && second.error.message}; migrations must run once`);
    else {
      if (schemaOf(again.ctx.store.db) !== schema) fails.push("a second start changed the schema; migrations are forward only and each runs once");
      if (second.value && typeof second.value.stop === "function") await within(Promise.resolve().then(() => second.value.stop()), STOP_MS, real.setTimeout);
    }
    await again.stop();
  } finally {
    timers.restore();
    fs.rmSync(home, { recursive: true, force: true });
  }
  return [...new Set(fails)];
}

/** Whether the manifest is sound enough to start: an object with a name and a version. @param {any} m */
const TYPES_OK = m => m && typeof m.name === "string" && /^[a-z][a-z0-9-]{1,40}$/.test(m.name) && typeof m.version === "string";
