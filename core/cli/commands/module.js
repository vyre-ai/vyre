// @ts-check
// `vyre module new|check|test|add`: make, check, test and install a module (ADR 0033 section 5,
// ADR 0047 section 7).
//
//   new <name>      writes a module on module API 1 that passes `check`, conformance and its own
//                   test: module.json, index.js, <name>.test.js (on @vyre/module-sdk/testing),
//                   AGENTS.md (docs/build/AGENT-BRIEF.md, for an agent working in the folder),
//                   jsconfig.json, package.json and a README, in <home>/modules/<name>/ unless
//                   --dir names another parent. It refuses a name Vyre ships or runs already.
//   check [dir]     the manifest against the published schema (packages/module-sdk) and the
//                   loader's own rules (core/modules validate), then the entry file: that it is
//                   there, and that `node --check` reads it. Exit 0 clean, 1 with problems.
//   test [dir]      conformModule (packages/module-sdk/conform.js), then `node --test` on the
//                   module's own *.test.js files. Exit 0 when both pass, 1 otherwise.
//   add <source>    a folder, or a git URL cloned with --depth 1 into a staging folder under the
//                   home. The staged copy is checked (so what was checked is what goes in), shown,
//                   confirmed, and renamed into <home>/modules/<name>/ without its .git. Then
//                   vyred restarts the way `vyre up` restarts it, and the module's state comes
//                   from /v1/modules. In the box's container the host restarts it instead.
//
// Adding a module is trusted like installing an npm package: it runs inside vyred. `add` says so
// in one line. A module named like one of Vyre's own is refused, and so is one that says
// "replaces": in 0.2 the allowlist of modules an added module may replace is empty (ADR 0047, H2).
//
// --view prints frames ({v, cmd, view, data}, then {v, done, exit}) for the Capsule, chat and the
// phone (docs/reference/cli-json.md). frame() below is local until polish-cli's core/cli/view.js
// reaches this branch; swapping to it changes nothing a surface sees.

import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { pathToFileURL } from "node:url";
import * as config from "../../config/index.js";
import { REPO } from "../../daemon/index.js";
import { request } from "../../daemon/client.js";
import { discover, validate } from "../../modules/index.js";
import { checkManifest, SCHEMA, toolEntries } from "../../../packages/module-sdk/manifest.js";
import { conformModule } from "../../../packages/module-sdk/conform.js";
import { stop, ensureUp } from "../daemonctl.js";
import { health, waitFor, terminal } from "./up.js";
import { out, dim, bold, signal, beacon } from "../style.js";
import { EXIT, UsageError, json, emit, fail, parse, closest } from "../kit.js";

const USAGE = "vyre module new <name> [--dir <parent>] | check [dir] | test [dir] | add <path|git url> [--yes]";
const SUBS = ["new", "check", "test", "add"];
/** The loader's module name rule, from the one schema both of them read. */
const NAME = new RegExp(SCHEMA.$defs.moduleName.pattern);
/** Vyre's own modules live in these folders of the repo; a module anywhere else is not first party. */
const SHIPPED = ["core", "local", "modules"];
/** What `add` takes as a git source; anything else is a folder on this machine. */
const GIT_URL = /^(https:\/\/|git@|file:\/\/)/;

/**
 * What `vyre module` needs from the world, so tests can stand in for each piece.
 * @typedef {{ tty: boolean, ask(q: string): Promise<string> }} IO
 * @typedef {{ ok: boolean, running?: boolean, note?: string }} Restarted
 * @typedef {{ home?: string, repo?: string, git?: string, node?: string, io?: IO, supervisor?: string,
 *   restart?: (home: string) => Promise<Restarted>,
 *   modules?: (home: string) => Promise<{ data?: any, error?: any }> }} Deps
 */

// ---------------------------------------------------------------------------------------------
// Output: human lines, --json, or --view frames

/** A frame line. polish-cli's view.js frame() replaces this when it lands. */
const frame = (cmd, view, data) => ({ v: 1, cmd, view, data: data === undefined ? null : data });
const line = (/** @type {any} */ o) => { process.stdout.write(JSON.stringify(o) + "\n"); };

/**
 * How this run answers. `say` is for a person only; `done` ends the run with its data.
 * @param {string} cmd @param {boolean} view
 */
function outlet(cmd, view) {
  const quiet = view || json();
  return {
    view,
    say: quiet ? (/** @type {string} */ _s) => {} : out,
    /** @param {number} exit @param {any} data @param {any} render @param {() => void} [human] */
    done(exit, data, render, human) {
      if (view) { line(frame(cmd, render, data)); line({ v: 1, done: true, exit }); return exit; }
      if (json()) { emit(data); return exit; }
      if (human) human();
      return exit;
    },
    /** A failure: kit's fail(), or under --view an error frame whose data is what --json prints. */
    /** @param {string} message @param {{ next?: string, code?: string, exit?: number }} [o] */
    refuse(message, { next, code = "failed", exit = EXIT.FAILED } = {}) {
      if (!view) return fail(message, { next, code, exit });
      const error = { code, message, ...(next ? { next } : {}) };
      line(frame(cmd, { kind: "error", ...error }, { error }));
      line({ v: 1, done: true, exit });
      return exit;
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Names Vyre already has

/** Names of the modules shipped in the repo. */
function shippedNames(repo) {
  return new Set(discover(SHIPPED.map(d => path.join(repo, d))).map(f => f.manifest && f.manifest.name).filter(Boolean));
}

/** Names vyred runs now (any state), or an empty set when it does not answer. */
async function runningNames(deps, home) {
  let r;
  try { r = await (deps.modules || defaultModules)(home); } catch { return new Set(); }
  if (!r || r.error || !Array.isArray(r.data)) return new Set();
  return new Set(r.data.map(m => String(m.name).split("@")[0]));
}

const defaultModules = (/** @type {string} */ home) => request("GET", "/v1/modules", undefined, { root: home });

/** Whether a folder is one of Vyre's own: inside the repo's shipped folders. */
const firstPartyDir = (repo, dir) => SHIPPED.some(d => path.resolve(dir).startsWith(path.join(repo, d) + path.sep));

// ---------------------------------------------------------------------------------------------
// check

/** `node --check <file>`: resolves to the first line that says what is wrong, or "" when it reads. */
function syntaxOf(node, file) {
  return new Promise(resolve => {
    execFile(node, ["--check", file], { timeout: 30_000 }, (err, _stdout, stderr) => {
      if (!err) return resolve("");
      const lines = String(stderr || err.message).split("\n").map(l => l.trim()).filter(Boolean);
      // node prints the file and line, the source, a caret, then "SyntaxError: ...".
      const why = lines.find(l => /^[A-Z]\w*Error\b/.test(l)) || lines[lines.length - 1] || "node --check failed";
      const at = lines.map(l => /:(\d+)$/.exec(l)).find(Boolean);
      resolve(at ? `${why} (${path.basename(file)} line ${at[1]})` : why);
    });
  });
}

/**
 * Check a module folder. Each check is ok or failed with its reasons, in the order a person fixes
 * them: a manifest that does not parse leaves nothing else to check.
 * @param {string} dir
 * @param {{ repo: string, node: string, firstParty?: boolean }} o
 */
export async function checkModule(dir, { repo, node, firstParty = firstPartyDir(repo, dir) }) {
  /** @type {{ id: string, label: string, state: "ok" | "failed" | "unknown", problems: string[] }[]} */
  const checks = [];
  const add = (id, label, problems, skipped = false) => checks.push({ id, label, state: skipped ? "unknown" : problems.length ? "failed" : "ok", problems });
  let m = null;
  try { m = JSON.parse(fs.readFileSync(path.join(dir, "module.json"), "utf8")); add("manifest", "module.json reads", []); }
  catch (e) {
    const err = /** @type {NodeJS.ErrnoException} */ (e);
    add("manifest", "module.json reads", [err.code === "ENOENT" ? `there is no module.json in ${dir}` : `module.json is not JSON: ${err.message}`]);
  }
  const name = m && typeof m.name === "string" ? m.name : null;
  if (m) {
    // The SDK's checker holds an added module to ADR 0047 (apiVersion, object tool entries, reach).
    add("schema", "matches the module API schema", checkManifest(m, { firstParty }));
    add("loader", "passes the loader's rules", validate(m, { firstParty }));
    const main = typeof m.main === "string" && m.main ? m.main : "index.js";
    const entry = path.resolve(dir, main);
    const inside = entry.startsWith(path.resolve(dir) + path.sep);
    const there = inside && fs.existsSync(entry) && fs.statSync(entry).isFile();
    add("entry", `${main} is there`, !inside ? [`main "${main}" points outside the module folder`] : there ? [] : [`the entry file ${main} is missing`]);
    if (there) { const why = await syntaxOf(node, entry); add("syntax", `${main} parses`, why ? [why] : []); }
    else add("syntax", `${main} parses`, [], true);
  } else {
    for (const [id, label] of [["schema", "matches the module API schema"], ["loader", "passes the loader's rules"], ["entry", "the entry file is there"], ["syntax", "the entry file parses"]]) add(id, label, [], true);
  }
  // The schema and the loader often say one thing twice; each problem is listed once.
  const problems = [...new Set(checks.flatMap(c => c.problems))];
  return { ok: checks.every(c => c.state === "ok"), module: name, dir, manifest: m, firstParty, problems, checks };
}

/** The checks view (platform's Render). @param {Awaited<ReturnType<typeof checkModule>>} r */
const checksView = r => ({
  kind: "checks", title: r.module ? `module ${r.module}` : "module",
  items: r.checks.map(c => ({ id: c.id, label: c.label, state: c.state, ...(c.problems.length ? { note: c.problems.join("; ") } : {}) })),
});

/** The --json shape of a check. @param {Awaited<ReturnType<typeof checkModule>>} r */
const checkData = r => ({ ok: r.ok, module: r.module, dir: r.dir, problems: r.problems });

function showChecks(r, say) {
  for (const c of r.checks) {
    const mark = c.state === "ok" ? signal("ok    ") : c.state === "failed" ? beacon("failed") : dim("skip  ");
    say(`  ${mark} ${c.label}`);
    for (const p of c.problems) say(dim(`         ${p}`));
  }
}

async function check(args, flags, o, deps) {
  if (args.length > 1) throw new UsageError("vyre module check takes one folder", "vyre module check [dir]");
  const dir = path.resolve(args[0] || ".");
  const r = await checkModule(dir, { repo: deps.repo || REPO, node: deps.node || process.execPath });
  const exit = r.ok ? EXIT.OK : EXIT.FAILED;
  return o.done(exit, checkData(r), checksView(r), () => {
    out(`  ${bold(r.module || path.basename(dir))} ${dim(dir)}`);
    showChecks(r, out);
    // A folder already in the home loads at the next start; one anywhere else goes in with add.
    const inHome = path.dirname(dir) === path.resolve(config.paths(deps.home || config.home()).modules);
    out(dim(!r.ok ? "  next: fix what failed, then vyre module check again" : inHome ? "  next: vyre down && vyre up loads it" : `  next: vyre module add ${args[0] || "."} installs it`));
  });
}

// ---------------------------------------------------------------------------------------------
// test

/**
 * `node --test` on a module's own *.test.js files, in its folder, as its own run: without
 * NODE_TEST_CONTEXT it reports as it would for the author.
 * @param {string} node @param {string} dir @param {string[]} files
 * @returns {Promise<{ ok: boolean, pass: number | null, fail: number | null, tail: string[] }>}
 */
function nodeTest(node, dir, files) {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  return new Promise(resolve => {
    execFile(node, ["--test", ...files], { cwd: dir, env, timeout: 120_000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      const text = String(stdout) + String(stderr);
      const count = (/** @type {string} */ k) => { const m = new RegExp(`^(?:# |\u2139 )${k} (\\d+)`, "m").exec(text); return m ? Number(m[1]) : null; };
      const lines = text.split("\n").map(l => l.trimEnd()).filter(Boolean);
      resolve({ ok: !err, pass: count("pass"), fail: count("fail"), tail: err ? lines.slice(-20) : [] });
    });
  });
}

/**
 * Test a module folder: conformance (ADR 0047 section 7), then its own tests.
 * @param {string} dir @param {{ repo: string, node: string, firstParty?: boolean }} o
 */
export async function testModuleDir(dir, { repo, node, firstParty = firstPartyDir(repo, dir) }) {
  const failures = fs.existsSync(path.join(dir, "module.json")) ? await conformModule(dir, { firstParty }) : [`there is no module.json in ${dir}`];
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => /\.test\.(m|c)?js$/.test(f)).sort() : [];
  const tests = files.length ? { files, ...(await nodeTest(node, dir, files)) } : { files, ok: true, pass: 0, fail: 0, tail: [] };
  let name = null;
  try { name = JSON.parse(fs.readFileSync(path.join(dir, "module.json"), "utf8")).name || null; } catch {}
  return { ok: failures.length === 0 && tests.ok, module: name, dir, failures, tests };
}

async function runTests(args, flags, o, deps) {
  if (args.length > 1) throw new UsageError("vyre module test takes one folder", "vyre module test [dir]");
  const dir = path.resolve(args[0] || ".");
  const r = await testModuleDir(dir, { repo: deps.repo || REPO, node: deps.node || process.execPath });
  const exit = r.ok ? EXIT.OK : EXIT.FAILED;
  const t = r.tests;
  const testNote = !t.files.length ? "no *.test.js files" : `${t.pass ?? "?"} passed, ${t.fail ?? "?"} failed`;
  const view = { kind: "checks", title: r.module ? `module ${r.module}` : "module", items: [
    { id: "conform", label: "conforms to module API 1", state: r.failures.length ? "failed" : "ok", ...(r.failures.length ? { note: r.failures.join("; ") } : {}) },
    { id: "tests", label: "its own tests pass", state: t.ok ? "ok" : "failed", note: testNote },
  ] };
  return o.done(exit, { ok: r.ok, module: r.module, dir, failures: r.failures, tests: { files: t.files, ok: t.ok, pass: t.pass, fail: t.fail } }, view, () => {
    out(`  ${bold(r.module || path.basename(dir))} ${dim(dir)}`);
    out(`  ${r.failures.length ? beacon("failed") : signal("ok    ")} conforms to module API 1`);
    for (const f of r.failures) out(dim(`         ${f}`));
    out(`  ${t.ok ? signal("ok    ") : beacon("failed")} its own tests ${dim(testNote)}`);
    for (const l of t.tail) out(dim(`         ${l}`));
    out(dim(r.ok ? `  next: vyre module add ${args[0] || "."}` : "  next: fix what failed, then vyre module test again"));
  });
}

// ---------------------------------------------------------------------------------------------
// new

/** docs/build/AGENT-BRIEF.md without its front matter: the AGENTS.md `new` writes. @param {string} repo */
export function agentBrief(repo = REPO) {
  try {
    const text = fs.readFileSync(path.join(repo, "docs", "build", "AGENT-BRIEF.md"), "utf8");
    return text.replace(/^---\n[\s\S]*?\n---\n+/, "");
  } catch {
    return "# Writing a Vyre module\n\nRead docs/build/AGENT-BRIEF.md in the Vyre repository before you change this module.\n";
  }
}

/**
 * The files `new` writes. Every name here passed NAME, so it is safe inside a string. The test
 * imports @vyre/module-sdk/testing, and until that is on npm falls back to the SDK in the Vyre
 * checkout the module was made from (or VYRE_MODULE_SDK, a folder holding testing.js).
 * @param {string} name @param {{ repo?: string }} [o]
 */
export function scaffold(name, { repo = REPO } = {}) {
  const tool = `${name}.hello`, event = `${name}.said`;
  const sdk = path.join(repo, "packages", "module-sdk");
  const manifest = {
    $schema: "https://vyre.run/schema/module-1.json",
    name, version: "0.1.0", apiVersion: 1,
    description: `A module made with vyre module new. It says hello.`,
    roles: ["box", "local"],
    does: { tools: [{ name: tool, summary: "say hello", reach: "anyone" }] },
    watches: { emits: [event] },
  };
  return {
    "module.json": JSON.stringify(manifest, null, 2) + "\n",
    // So Node reads index.js as an ES module on every version Vyre supports (docs/build/first-module.md).
    "package.json": JSON.stringify({ type: "module", private: true }) + "\n",
    // Editor help: the SDK's types for ctx and the manifest, checked as you type.
    "jsconfig.json": JSON.stringify({ compilerOptions: { checkJs: true, module: "nodenext", target: "es2022", paths: { "@vyre/module-sdk": [path.join(sdk, "index.d.ts")] } }, include: ["*.js"] }, null, 2) + "\n",
    "AGENTS.md": agentBrief(repo),
    "index.js": `// @ts-check
// ${name}: a module made with \`vyre module new\`. It offers one tool, ${tool}, and emits
// ${event} each time the tool runs. Change it into what you need; module.json lists every
// tool it registers (with who may call it) and every event it emits. AGENTS.md has the rules.

/** @type {import("@vyre/module-sdk").Module} */
export default {
  async start(ctx) {
    ctx.tool("${tool}", {
      description: "Say hello: to whoever is named, or to the world.",
      input: { type: "object", properties: { to: { type: "string", maxLength: 80 } }, additionalProperties: false },
      // The conformance test calls every example; the first is what an agent sees as a sample.
      examples: [{ input: { to: "alex" } }, { input: {} }],
      run: async ({ to } = {}) => {
        const text = \`Hello, \${to || "world"}!\`;
        // Every module and the Deck can read the event log, so the event says a greeting went
        // out and never carries the words a person typed.
        ctx.events.emit("${event}", { named: Boolean(to) });
        return { text };
      },
    });
    ctx.log.info("ready");
    return { async stop() {} };
  },
};
`,
    [`${name}.test.js`]: `// ${name}'s own test, on the SDK's testing harness: a temp home, a fake registry and no vyred.
// \`vyre module test\` runs the conformance checks, then this file.

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const DIR = fileURLToPath(new URL(".", import.meta.url));
// @vyre/module-sdk/testing once it is on npm; until then the Vyre checkout this was made from.
const SDK = process.env.VYRE_MODULE_SDK ? pathToFileURL(path.join(process.env.VYRE_MODULE_SDK, "testing.js")).href : ${JSON.stringify(pathToFileURL(path.join(sdk, "testing.js")).href)};
const { testModule } = await import("@vyre/module-sdk/testing").catch(() => import(SDK));

test("${tool} greets whoever is named, for the person and for an agent", async t => {
  const h = await testModule(DIR);
  t.after(() => h.stop());
  assert.deepEqual(await h.call("${tool}", { to: "alex" }), { data: { text: "Hello, alex!" } });
  assert.deepEqual(await h.call("${tool}", {}, { who: "agent" }), { data: { text: "Hello, world!" } });
  assert.equal((await h.call("${tool}", { to: 7 })).error.code, "bad_input");
});

test("${event} never carries what a person typed", async t => {
  const h = await testModule(DIR);
  t.after(() => h.stop());
  await h.call("${tool}", { to: "alex" });
  assert.deepEqual(h.events.map(e => [e.type, e.payload]), [["${event}", { named: true }]]);
  assert.ok(!JSON.stringify(h.events).includes("alex"));
});
`,
    "README.md": `# ${name}

A Vyre module made with \`vyre module new\`. It offers one tool, \`${tool}\`, and emits
\`${event}\` when the tool runs. An agent working here reads \`AGENTS.md\` first.

## Run it

vyred loads modules from \`<home>/modules/\` when it starts. With this folder there, restart it
and call the tool:

\`\`\`console
$ vyre down && vyre up
$ vyre modules
$ vyre call ${tool} '{"to":"alex"}'
\`\`\`

A folder made somewhere else goes in with \`vyre module add <folder>\`, which checks it, copies
it into the home and restarts vyred.

## Check and test it

\`\`\`console
$ vyre module check .
$ vyre module test .
\`\`\`

\`check\` reads module.json against the module API schema and the loader's rules, and checks that
the entry file is there and parses. \`test\` runs the conformance checks every module must pass,
then \`node --test\` on this folder's tests, which use the SDK's harness and need no running vyred.

## Switch it off

Add the name to \`modules.disable\` in the home's \`config.json\`, then restart vyred:

\`\`\`json
{ "modules": { "disable": ["${name}"] } }
\`\`\`

Its tools go away; anything it stored stays, so switching it back on loses nothing.

## Next

\`docs/build/AGENT-BRIEF.md\` and \`docs/build/first-module.md\` in the Vyre repository, and the
complete example in \`examples/modules/bakery\`.
`,
  };
}

async function make(args, flags, o, deps) {
  const name = args[0];
  if (!name) throw new UsageError("vyre module new needs a name", "vyre module new <name>, e.g. vyre module new bake");
  if (args.length > 1) throw new UsageError("vyre module new takes one name", "vyre module new <name> [--dir <parent>]");
  if (!NAME.test(name)) return o.refuse(`"${name}" is not a module name: lowercase letters, digits and dashes, 2 to 41 long, starting with a letter`, { code: "bad_name", exit: EXIT.USAGE, next: "vyre module new bake" });
  const home = deps.home || config.home();
  const repo = deps.repo || REPO;
  if (shippedNames(repo).has(name)) return o.refuse(`${name} is one of Vyre's own modules`, { code: "name_taken", next: "pick another name; in 0.2 an added module replaces none of Vyre's" });
  if ((await runningNames(deps, home)).has(name)) return o.refuse(`vyred already runs a module named ${name}`, { code: "name_taken", next: "vyre modules shows every name in use; pick another" });
  const parent = path.resolve(flags.dir ? String(flags.dir) : config.paths(home).modules);
  const dir = path.join(parent, name);
  if (fs.existsSync(dir)) return o.refuse(`${dir} is already there`, { code: "exists", next: "pick another name, or --dir <parent> for another folder" });

  const files = scaffold(name, { repo });
  fs.mkdirSync(dir, { recursive: true });
  for (const [f, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, f), text);
  const inHome = parent === path.resolve(config.paths(home).modules);
  const next = [`vyre module test ${dir}`, inHome ? "vyre down && vyre up" : `vyre module add ${dir}`, `vyre call ${name}.hello`];
  const data = { created: true, module: name, dir, files: Object.keys(files), next };
  const view = { kind: "card", title: `made ${name}`, state: "ok", fields: [{ label: "Folder", value: dir }, { label: "Files", value: Object.keys(files).join(", ") }, { label: "Next", value: next.join(" · ") }] };
  return o.done(EXIT.OK, data, view, () => {
    out(`  ${signal("made")} ${bold(name)} ${dim(dir)}`);
    for (const f of Object.keys(files)) out(dim(`    ${f}`));
    out("");
    out(`  ${next[0]}`);
    out(`  ${next[1]}${dim(inHome ? "   loads it (vyre up alone keeps a vyred that is running)" : "   copies it into your home and loads it")}`);
    out(`  ${next[2]}`);
    out(dim(`  AGENTS.md in the folder is the brief to hand an agent that writes the rest`));
  });
}

// ---------------------------------------------------------------------------------------------
// add

/** `git clone --depth 1 <url> <dir>`, never asking for a password on this terminal. */
function clone(git, url, dir) {
  return new Promise(resolve => {
    execFile(git, ["clone", "--depth", "1", "--quiet", "--", url, dir], { timeout: 120_000, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } },
      (err, _stdout, stderr) => resolve(err ? (String(stderr).trim().split("\n").pop() || err.message) : ""));
  });
}

/**
 * Copy a module folder: files and folders only. A .git folder stays behind, and so does any
 * symlink, which could point anywhere on this machine. Returns the paths it left out.
 */
function copyModule(from, to) {
  const skipped = [];
  fs.cpSync(from, to, {
    recursive: true, errorOnExist: true,
    filter: src => {
      const rel = path.relative(from, src);
      if (rel.split(path.sep)[0] === ".git") return false;
      if (fs.lstatSync(src).isSymbolicLink()) { skipped.push(rel); return false; }
      return true;
    },
  });
  return skipped;
}

/** What a module asks for, as lines a person reads before saying yes. */
function summary(m) {
  const list = v => (Array.isArray(v) && v.length ? v.join(", ") : "none");
  const needs = m.needs || {};
  const creds = Array.isArray(needs.credentials) ? needs.credentials.map(c => `${c.id} (${c.purpose})`) : [];
  return [
    { label: "Module", value: `${m.name} ${m.version}` },
    { label: "Tools", value: list(toolEntries(m).map(t => t.name)) },
    { label: "Emits", value: list(m.watches && m.watches.emits) },
    { label: "Vault items", value: list(needs.vault) },
    { label: "Network", value: list(needs.network) },
    { label: "Credentials", value: list(creds) },
    ...(m.replaces ? [{ label: "Replaces", value: `Vyre's own ${m.replaces}` }] : []),
  ];
}

/** Restart a local vyred the way `vyre up` does: stop, then ensureUp, then wait for its health. */
async function restartLocal() {
  const h = await health();
  if (!h) return { ok: true, running: false, note: "vyred is not running; vyre up starts it with the module" };
  if (h.supervisor === "systemd") {
    // systemd starts it again (Restart=always).
    try { process.kill(h.pid, "SIGTERM"); } catch {}
    return (await waitFor(h.version, 15_000)) ? { ok: true, running: true } : { ok: false, note: "vyred did not come back; see journalctl -u vyre" };
  }
  const s = await stop({ pid: h.pid });
  if (!s.ok) return { ok: false, note: s.why || "the running vyred did not stop; vyre down, then vyre up" };
  const r = await ensureUp();
  if (!r.ok) return { ok: false, note: `vyred did not start; its output is in ${r.log}` };
  return (await waitFor(h.version, 15_000)) ? { ok: true, running: true } : { ok: false, note: "vyred did not answer on /v1/health" };
}

async function install(args, flags, o, deps) {
  const src = args[0];
  if (!src) throw new UsageError("vyre module add needs a folder or a git URL", "vyre module add ./bake, or vyre module add https://github.com/<user>/<repo>");
  if (args.length > 1) throw new UsageError("vyre module add takes one source", USAGE);
  const home = deps.home || config.home();
  const repo = deps.repo || REPO;
  const modules = config.paths(home).modules;
  fs.mkdirSync(modules, { recursive: true, mode: 0o700 });
  // Everything is staged under the home, never outside it, so the last step is one rename on one
  // filesystem and a module is either all there or not there at all.
  const staging = fs.mkdtempSync(path.join(home, ".module-add-"));
  try {
    let from = null;
    if (GIT_URL.test(src)) {
      from = path.join(staging, "clone");
      const why = await clone(deps.git || "git", src, from);
      if (why) return o.refuse(`could not clone ${src}: ${why}`, { code: "clone_failed", next: "check the URL, and that git can reach it" });
    } else {
      from = path.resolve(src);
      if (!fs.existsSync(from) || !fs.statSync(from).isDirectory()) return o.refuse(`${src} is not a folder`, { code: "not_found", exit: EXIT.USAGE, next: "vyre module add <folder with a module.json>" });
    }
    // A folder given through a symlink is copied from where it really is.
    from = fs.realpathSync(from);
    const staged = path.join(staging, "module");
    const skipped = copyModule(from, staged);
    // Checked as a module from outside Vyre, whatever folder it came from: once added it lives in the home.
    const r = await checkModule(staged, { repo, node: deps.node || process.execPath, firstParty: false });
    if (!r.ok) {
      return o.refuse(`${r.module || src} did not pass the check: ${r.problems.join("; ")}`, {
        code: "check_failed", next: `vyre module check ${GIT_URL.test(src) ? "<a clone of it>" : src} shows each problem`,
      });
    }
    const m = r.manifest, name = m.name, dest = path.join(modules, name);
    if (from === path.join(fs.realpathSync(modules), name)) return o.refuse(`${name} is already in ${modules}`, { code: "exists", next: "vyre down && vyre up loads it" });
    if (fs.existsSync(dest)) return o.refuse(`${dest} is already there`, { code: "exists", next: `remove ${dest} first to add this one in its place` });
    const replacing = shippedNames(repo).has(name);
    if (replacing && m.replaces !== name) {
      return o.refuse(`${name} is one of Vyre's own modules`, { code: "name_taken", next: "pick another name; in 0.2 an added module replaces none of Vyre's" });
    }
    if (replacing && !flags.yes) {
      return o.refuse(`${name} replaces Vyre's own ${name}; that needs your explicit yes`, { code: "needs_yes", exit: EXIT.USAGE, next: `vyre module add ${src} --yes` });
    }

    const fields = summary(m);
    const trust = "a module runs inside vyred with Vyre's own access to this machine: add only code you trust";
    if (!flags.yes) {
      if (o.view) {
        line(frame("module add", { kind: "prompt", name: "confirm", label: `Add ${name} ${m.version}? ${trust[0].toUpperCase()}${trust.slice(1)}.`, args: ["module", "add", src, "--yes", "--view"], answer: "confirm" }, { module: name, version: m.version, installed: false }));
        line({ v: 1, done: true, exit: EXIT.USAGE });
        return EXIT.USAGE;
      }
      const io = deps.io || terminal;
      if (!io.tty || json()) return o.refuse("vyre module add needs --yes when it cannot ask", { code: "needs_yes", exit: EXIT.USAGE, next: `vyre module add ${src} --yes` });
      for (const f of fields) out(`  ${dim(f.label.padEnd(12))} ${f.value}`);
      out(beacon(`  ${trust}`));
      const a = (await io.ask(`  Add ${name} to ${modules}? (y/N) `)).trim();
      if (!/^y(es)?$/i.test(a)) { out(dim("  nothing changed")); return EXIT.FAILED; }
    } else {
      for (const f of fields) o.say(`  ${dim(f.label.padEnd(12))} ${f.value}`);
      o.say(dim(`  ${trust}`));
    }
    fs.renameSync(staged, dest);
    o.say(`  ${signal("added")} ${bold(name)} ${dim(dest)}`);
    if (skipped.length) o.say(dim(`  left out ${skipped.length} symlink${skipped.length === 1 ? "" : "s"}: ${skipped.slice(0, 3).join(", ")}`));
    return reload(o, deps, { home, name, version: m.version, dest, src, skipped, fields });
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

/** Restart vyred so it loads the module, then say what state the module is in. */
async function reload(o, deps, { home, name, version, dest, src, skipped, fields }) {
  const base = { installed: true, module: name, version, dir: dest, from: src, skipped };
  const card = (/** @type {string} */ state, /** @type {{ label: string, value: any }[]} */ more) => ({ kind: "card", title: `added ${name}`, state, fields: [...fields, { label: "Folder", value: dest }, ...more] });
  if ((deps.supervisor ?? process.env.VYRE_SUPERVISOR) === "docker") {
    // In the box's container vyred is the container's main process; only the host restarts it.
    const next = "on the server, in the box's folder: docker compose restart vyre";
    return o.done(EXIT.OK, { ...base, reload: "host", state: null, next }, card("wait", [{ label: "Next", value: next }]), () => out(dim(`  next: ${next}`)));
  }
  const b = await (deps.restart || restartLocal)(home);
  if (!b.ok) {
    return o.refuse(`${name} is in ${dest}, but vyred did not restart: ${b.note}`, { code: "restart_failed", next: "vyre up" });
  }
  if (!b.running) return o.done(EXIT.OK, { ...base, reload: "not_running", state: null }, card("wait", [{ label: "Next", value: "vyre up" }]), () => out(dim(`  ${b.note || "vyred is not running"} · next: vyre up`)));
  let rows = [];
  try { const r = await (deps.modules || defaultModules)(home); rows = r && Array.isArray(r.data) ? r.data : []; } catch {}
  // A home module with a name already loaded is listed as <name>@<folder>; that row is this one.
  const row = rows.find(x => x.name === `${name}@${dest}`) || rows.find(x => x.name === name) || null;
  const state = row ? String(row.state) : "unknown";
  const error = row && row.error ? String(row.error) : null;
  const data = { ...base, reload: "restarted", state, ...(error ? { error } : {}) };
  const bad = ["failed", "invalid"].includes(state);
  const view = card(state === "running" ? "ok" : bad ? "failed" : "unknown", [{ label: "State", value: state }, ...(error ? [{ label: "Error", value: error }] : [])]);
  return o.done(bad ? EXIT.FAILED : EXIT.OK, data, view, () => {
    if (state === "running") out(`  ${signal("running")} ${dim(`vyre call ${name}.<tool> runs its tools · vyre tools lists them`)}`);
    else if (bad) { out(beacon(`  ${state}: ${error || "no reason given"}`)); out(dim(`  next: fix it in ${dest}, then vyre down && vyre up`)); }
    else if (state === "off") out(dim(`  off on this machine: its roles leave this one out, or config.json modules.disable names it`));
    else out(dim(`  vyred restarted but does not list ${name} · next: vyre modules`));
  });
}

// ---------------------------------------------------------------------------------------------

/**
 * @param {string[]} args
 * @param {Deps} [deps]
 */
export async function moduleCommand(args, deps = {}) {
  const view = args.includes("--view");
  const [sub, ...rest] = args.filter(a => a !== "--view");
  const o = outlet(sub && SUBS.includes(sub) ? `module ${sub}` : "module", view);
  try {
    if (!sub || sub.startsWith("-")) throw new UsageError("vyre module needs new, check, test or add", USAGE);
    const { flags, pos } = parse(rest, { bool: ["yes"], values: ["dir"], cmd: "module" });
    if (flags.dir !== undefined && sub !== "new") throw new UsageError("--dir goes with vyre module new", "vyre module new <name> --dir <parent>");
    if (flags.yes && sub !== "add") throw new UsageError("--yes goes with vyre module add", "vyre module add <source> --yes");
    if (sub === "new") return await make(pos, flags, o, deps);
    if (sub === "check") return await check(pos, flags, o, deps);
    if (sub === "test") return await runTests(pos, flags, o, deps);
    if (sub === "add") return await install(pos, flags, o, deps);
    const near = closest(sub, SUBS);
    throw new UsageError(`vyre module ${sub}: not a verb; it is new, check, test or add`, near.length ? `did you mean vyre module ${near[0]}?` : USAGE);
  } catch (e) {
    if (e instanceof UsageError) return o.refuse(e.message, { code: "bad_input", exit: EXIT.USAGE, next: e.next || "vyre help module" });
    throw e;
  }
}

export default {
  name: "module", order: 90, usage: USAGE,
  summary: "make, check, test and add a module of your own",
  help: [
    "new <name>        a module on module API 1 that passes check, test and its own test, in",
    "                  <home>/modules/<name>, with AGENTS.md: the brief to hand an agent",
    "  --dir PARENT    make it in PARENT/<name> instead",
    "check [dir]       the manifest (schema and loader rules) and the entry file; exit 1 on a problem",
    "test [dir]        the conformance checks every module passes, then its own *.test.js files",
    "add <source>      a folder or a git URL (https://, git@, file://): check it, show what it asks",
    "                  for, copy it into <home>/modules and restart vyred to load it",
    "  --yes           do not ask first (needed without a terminal, and with --json or --view)",
    "",
    "A module runs inside vyred, trusted like an npm package. A module named like one of Vyre's",
    "own is refused, and in 0.2 an added module may not say \"replaces\".",
    "In the box's container, the host restarts vyred: docker compose restart vyre.",
    "--view prints frames for the Capsule and the phone (docs/reference/cli-json.md).",
  ].join("\n"),
  run: (/** @type {string[]} */ args) => moduleCommand(args),
};
