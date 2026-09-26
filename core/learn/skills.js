// @ts-check
// skills: procedures the user repeats become Claude Code skills (ADR 0007 decision 10).
//
// At Stop a turn's steps (command shapes and file kinds, consecutive repeats collapsed) are
// hashed with their 3 to 6 step runs. At the next prompt the turn is marked clean unless it was
// corrected or sent back. A hash clean in 3 distinct sessions is a candidate; the candidate is
// proposed with a SKILL.md body the user sees in full, and only the user installs it (presence,
// ADR 0007 decision 11). Installed files are hashed, so a hand edit or a deleted file shows as
// drift. This file is self-contained: the learn module wires it into its hooks and tools.
//
// Claude Code facts this relies on (checked 2026-09-26 against Claude Code 2.1.283, `claude
// --help`, and the Harness, which already ships skills this way):
//   - a plugin is a folder with `.claude-plugin/plugin.json`; its skills are discovered at
//     `<plugin>/skills/<name>/SKILL.md` (frontmatter `name` and `description`);
//   - `--plugin-dir <path>` is repeatable ("--plugin-dir A --plugin-dir B.zip"), so the Harness
//     and each learned plugin load side by side, for that session only;
//   - "a folder of plugins loads each child": a --plugin-dir that is not itself a plugin loads
//     every child plugin. So `<home>/learned` is always a plugin in its own right, and pluginDirs
//     never passes `<home>/learned/projects` or `<home>/learned/agents`, which would load every
//     project's private skills and every agent's into one thread;
//   - project skills live at `<project>/.claude/skills/<name>/SKILL.md`, Claude Code's own
//     project scope, with no plugin needed.
// Never `~/.claude` (the user's own setup is not ours to change) and never `harness/skills`.
//
// Light by default: every step here is bounded. shapeOf is one pass over at most 2000
// characters, a turn yields at most 40 hashes, and candidates() is one grouped query.

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const SKILL_MIGRATIONS = [
  `CREATE TABLE learn_procs (
     hash TEXT NOT NULL, shape TEXT NOT NULL, project TEXT, session TEXT NOT NULL, seq INTEGER NOT NULL,
     at INTEGER NOT NULL, clean INTEGER NOT NULL DEFAULT 0,
     PRIMARY KEY (hash, session)
   );
   CREATE INDEX learn_procs_turn ON learn_procs (session, seq);
   CREATE INDEX learn_procs_clean ON learn_procs (clean, hash);
   CREATE INDEX learn_procs_at ON learn_procs (at);
   CREATE TABLE learn_skills (
     id INTEGER PRIMARY KEY, name TEXT NOT NULL, scope TEXT NOT NULL,
     status TEXT NOT NULL CHECK (status IN ('proposed','installed','retired','dismissed')),
     body TEXT NOT NULL, hash TEXT, path TEXT, source TEXT NOT NULL, sessions INTEGER NOT NULL DEFAULT 0,
     created INTEGER NOT NULL, updated INTEGER NOT NULL
   );
   CREATE INDEX learn_skills_status ON learn_skills (status);`,
];

const MAX_COMMAND = 2000;
const MAX_HASHES = 40;
const MIN_STEPS = 3, MAX_WHOLE = 12, MIN_RUN = 3, MAX_RUN = 6;
const MAX_NAME = 64;

/** Programs that only prefix another command. */
const WRAPPERS = new Set(["sudo", "env", "time", "nohup", "nice", "command", "builtin"]);
/** Steps that carry no procedure of their own. */
const NOISE = new Set(["cd", "pushd", "popd", "true", ":"]);
/** Subcommands whose next word is also a name, not a value (`npm run build`, `gh pr create`). */
const RUNNERS = new Set(["run", "run-script", "exec", "x", "dlx", "compose", "pr", "issue", "repo", "release",
  "workflow", "stash", "remote", "submodule", "worktree", "db", "migrate", "generate", "workspace", "cache", "config"]);
const FILE_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

// ---------------------------------------------------------------------------------------------
// Shapes and steps

/**
 * Split a shell command into segments of tokens, in one pass. A token remembers whether any of
 * it was quoted or substituted, which makes it a value whatever it says. Redirect targets are
 * dropped. Separators: && || ; | & and newlines.
 * @param {string} cmd
 * @returns {{t: string, q: boolean}[][]}
 */
function split(cmd) {
  const s = String(cmd || "").slice(0, MAX_COMMAND);
  /** @type {{t: string, q: boolean}[][]} */
  const segs = [];
  /** @type {{t: string, q: boolean}[]} */
  let seg = [];
  let tok = "", q = false, has = false, redirect = false, depth = 0;
  const end = () => {
    if (has) { if (!redirect) seg.push({ t: tok, q }); redirect = false; }
    tok = ""; q = false; has = false;
  };
  const cut = () => { end(); if (seg.length) segs.push(seg); seg = []; redirect = false; };
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (depth > 0) {                                   // inside $( ... ) or ` ... `
      tok += c;
      if (c === "(") depth++;
      else if (c === ")" || c === "`") depth--;
      continue;
    }
    if (c === "\\" && i + 1 < s.length) { tok += s[++i]; has = true; continue; }
    if (c === "'" || c === '"') {
      const close = s.indexOf(c, i + 1);
      const j = close < 0 ? s.length : close;
      tok += s.slice(i + 1, j); q = true; has = true; i = j;
      continue;
    }
    if (c === "$" && s[i + 1] === "(") { tok += "$("; i++; q = true; has = true; depth = 1; continue; }
    if (c === "`") { tok += c; q = true; has = true; depth = 1; continue; }
    if (c === " " || c === "\t") { end(); continue; }
    if (c === "\n" || c === ";") { cut(); continue; }
    if (c === "|" || c === "&") {
      // 2>&1 and >&2 are part of a redirect, not a separator.
      if (c === "&" && (s[i - 1] === ">" || s[i - 1] === "<")) { while (/[0-9-]/.test(s[i + 1] || "")) i++; redirect = false; continue; }
      if (s[i + 1] === c) i++;
      cut();
      continue;
    }
    if (c === ">" || c === "<") {
      if (/^[0-9]$/.test(tok) && !q) { tok = ""; has = false; }   // 2>file
      end();
      if (s[i + 1] === c) i++;
      if (s[i + 1] === "&") continue;
      redirect = true;
      continue;
    }
    tok += c; has = true;
  }
  cut();
  return segs;
}

/** What a non-flag token is: a name, a path, a URL, or a value that says nothing about the shape. */
function kindOf({ t, q }) {
  if (q || !t) return "value";
  if (/^\d+([.:]\d+)*$/.test(t)) return "value";
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(t)) return "<url>";
  if (t.includes("/") || /^[.~]/.test(t) || /\.[A-Za-z0-9]{1,8}$/.test(t)) return /\.[A-Za-z0-9]{1,8}$/.test(t) ? "<file>" : "<path>";
  if (/^[A-Za-z][A-Za-z0-9_:@-]*$/.test(t)) return "word";
  return "value";
}

/** The shape of one segment's tokens. */
function shapeTokens(toks) {
  let i = 0;
  while (i < toks.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(toks[i].t) || WRAPPERS.has(toks[i].t))) i++;
  if (i >= toks.length) return "";
  const head = toks[i];
  const prog = head.q ? "<value>" : path.basename(head.t) || head.t;
  const out = [prog];
  let words = 0, flags = 0, first = "", afterFlag = false;
  for (i++; i < toks.length && words < 2; i++) {
    const tk = toks[i];
    if (!tk.q && /^-/.test(tk.t) && tk.t !== "-" && tk.t !== "--") {
      if (flags < 2) out.push(tk.t.split("=")[0]);
      flags++;
      afterFlag = !tk.t.includes("=");
      continue;
    }
    const k = kindOf(tk);
    // A bare word after a flag, once the subcommand is known, is the flag's value (`-m wip`).
    const flagValue = afterFlag && words > 0 && k === "word";
    afterFlag = false;
    if (k === "value" || flagValue) continue;
    if (k === "word") {
      if (words === 0) { out.push(tk.t); first = tk.t; }
      else out.push(RUNNERS.has(first) ? tk.t : "<name>");
    } else out.push(k);
    words++;
  }
  return out.join(" ");
}

/**
 * A command's shape: the program, then its first two non-flag tokens, with paths and values
 * replaced by kinds (`git push`, `npm run build`, `sed -i <file>`, `node --test <file>`). Only
 * the first segment of a compound command counts. One pass over at most 2000 characters.
 * @param {string} command
 * @returns {string}
 */
export function shapeOf(command) {
  const segs = split(command);
  for (const seg of segs) { const s = shapeTokens(seg); if (s) return s; }
  return "";
}

/** The class of a file by its name: test, doc, changelog, config, style, code, data or other. */
export function fileClass(file) {
  const f = String(file || "").toLowerCase();
  const base = path.basename(f);
  if (/^(changelog|changes|history)(\.|$)/.test(base)) return "changelog";
  if (/(\.|_)(test|spec)\.[a-z0-9]+$/.test(base) || /(^|\/)(tests?|__tests__|spec)\//.test(f)) return "test";
  if (/\.(md|mdx|txt|rst|adoc)$/.test(base)) return "doc";
  if (/\.(json|jsonc|ya?ml|toml|ini|cfg|conf|env|lock)$/.test(base) || /^\.(env|npmrc|editorconfig)/.test(base) || /^(dockerfile|makefile|procfile)$/.test(base)) return "config";
  if (/\.(css|scss|sass|less)$/.test(base)) return "style";
  if (/\.(sql)$/.test(base)) return "sql";
  if (/\.(js|mjs|cjs|ts|tsx|jsx|py|go|rs|rb|java|kt|swift|c|cc|cpp|h|hpp|cs|php|sh|html|vue|svelte)$/.test(base)) return "code";
  if (/\.(csv|tsv|xml|parquet)$/.test(base)) return "data";
  return "other";
}

/**
 * A turn's steps: each shell command's segments as shapes, each file write as `<Tool>:<class>`,
 * consecutive duplicates collapsed. Items with `at` are merged in time order; without, commands
 * come first, then files.
 * @param {{ commands?: (string|{command: string, at?: number})[], files?: (string|{tool?: string, path: string, at?: number})[] }} turn
 * @returns {string[]}
 */
export function stepsOf({ commands = [], files = [] } = {}) {
  /** @type {{at: number, n: number, steps: string[]}[]} */
  const items = [];
  let n = 0;
  for (const c of commands) {
    const cmd = typeof c === "string" ? c : c && c.command;
    if (typeof cmd !== "string") continue;
    const steps = split(cmd).map(shapeTokens).filter(s => s && !NOISE.has(s.split(" ")[0]));
    items.push({ at: typeof c === "object" && Number.isFinite(c.at) ? Number(c.at) : -Infinity, n: n++, steps });
  }
  for (const f of files) {
    const p = typeof f === "string" ? f : f && f.path;
    if (typeof p !== "string") continue;
    const tool = typeof f === "object" && f.tool && FILE_TOOLS.has(f.tool) ? (f.tool === "MultiEdit" ? "Edit" : f.tool) : "Edit";
    items.push({ at: typeof f === "object" && Number.isFinite(f.at) ? Number(f.at) : Infinity, n: n++, steps: [`${tool}:${fileClass(p)}`] });
  }
  items.sort((a, b) => a.at - b.at || a.n - b.n);
  const out = [];
  for (const it of items) for (const s of it.steps) if (out[out.length - 1] !== s) out.push(s);
  return out;
}

const hashOf = steps => crypto.createHash("sha1").update(steps.join("\n")).digest("hex").slice(0, 16);

/**
 * The fingerprints of a turn's steps: the whole sequence when it has 3 to 12 steps, then its
 * contiguous runs of 6 down to 3 steps, earliest first, duplicates dropped, at most 40.
 * A longer turn contributes runs only.
 * @param {string[]} steps
 * @returns {{hash: string, steps: string[]}[]}
 */
export function fingerprints(steps) {
  const s = Array.isArray(steps) ? steps.map(String) : [];
  if (s.length < MIN_STEPS) return [];
  const out = [], seen = new Set();
  const add = run => {
    if (out.length >= MAX_HASHES) return;
    const h = hashOf(run);
    if (seen.has(h)) return;
    seen.add(h); out.push({ hash: h, steps: run });
  };
  if (s.length <= MAX_WHOLE) add(s);
  for (let k = Math.min(MAX_RUN, s.length); k >= MIN_RUN && out.length < MAX_HASHES; k--) {
    for (let i = 0; i + k <= s.length && out.length < MAX_HASHES; i++) add(s.slice(i, i + k));
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// SKILL.md

/** One step, as an instruction. */
function stepText(step) {
  const m = /^(\w+):(\w+)$/.exec(step);
  if (m && FILE_TOOLS.has(m[1])) {
    const what = { test: "a test file", doc: "a doc", changelog: "the changelog", config: "a config file", style: "a stylesheet",
      sql: "a SQL file", code: "a code file", data: "a data file", other: "a file" }[m[2]] || "a file";
    return `${m[1] === "Write" ? "Write" : "Edit"} ${what}.`;
  }
  return `Run \`${step}\`.`;
}

/** The words a step contributes to a skill's name. */
function stepWords(step) {
  const m = /^(\w+):(\w+)$/.exec(step);
  if (m && FILE_TOOLS.has(m[1])) return [m[1].toLowerCase(), m[2]];
  return step.split(" ").filter(w => !w.startsWith("-") && !w.startsWith("<")).slice(0, 3);
}

/** `learned-<kebab>`, at most 64 characters, cut at a word. */
function nameFor(steps) {
  const words = [];
  for (const s of steps) for (const w of stepWords(s)) {
    const k = w.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
    if (k && words[words.length - 1] !== k) words.push(k);
  }
  let name = "learned";
  for (const w of words) { if ((name + "-" + w).length > MAX_NAME) break; name += "-" + w; }
  return name === "learned" ? "learned-procedure" : name;
}

/**
 * A deterministic SKILL.md for a candidate, used when no model drafted one.
 * @param {{steps: string[], sessions?: number}} candidate
 * @returns {string}
 */
export function template(candidate) {
  const steps = candidate.steps;
  const name = nameFor(steps);
  const list = steps.map(s => /^\w+:\w+$/.test(s) ? stepText(s).replace(/\.$/, "").toLowerCase() : `\`${s}\``);
  const description = `Use when the task is the procedure the user repeats: ${list.join(", then ")}.`.slice(0, 1024);
  const n = candidate.sessions || 0;
  return [
    "---",
    `name: ${name}`,
    `description: ${JSON.stringify(description)}`,
    "---",
    "",
    `# ${name}`,
    "",
    `Vyre saw this procedure end cleanly${n ? ` in ${n} sessions` : ""}, with nothing corrected or sent back.`,
    "Follow the steps in order, adapting names and paths to the task.",
    "",
    ...steps.map((s, i) => `${i + 1}. ${stepText(s)}`),
    "",
  ].join("\n");
}

/** A SKILL.md's frontmatter name and description, or an error. */
export function frontmatter(body) {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(String(body || ""));
  if (!m) return { error: "a skill starts with YAML frontmatter between --- lines" };
  const get = k => { const r = new RegExp(`^${k}:\\s*(.*)$`, "m").exec(m[1]); if (!r) return ""; const v = r[1].trim(); try { return /^"/.test(v) ? JSON.parse(v) : v; } catch { return v; } };
  const name = get("name"), description = get("description");
  if (!/^learned-[a-z0-9]+(-[a-z0-9]+)*$/.test(name) || name.length > MAX_NAME) return { error: "name must be learned-<kebab-case>, at most 64 characters" };
  if (!/^Use when /.test(description)) return { error: 'description must start with "Use when"' };
  return { name, description };
}

// ---------------------------------------------------------------------------------------------
// Where installed skills go

const HARNESS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "harness");
const SLUG = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const sha256 = s => crypto.createHash("sha256").update(s).digest("hex");
const inside = (dir, p) => { const r = path.relative(dir, p); return r === "" || (!r.startsWith("..") && !path.isAbsolute(r)); };
/** The real path of p, or of its nearest existing ancestor with the rest appended. */
function real(p) {
  let cur = path.resolve(p), rest = "";
  for (;;) {
    try { return path.join(fs.realpathSync(cur), rest); } catch { /* keep climbing */ }
    const up = path.dirname(cur);
    if (up === cur) return path.join(cur, rest);
    rest = path.join(path.basename(cur), rest);
    cur = up;
  }
}

/** The account plugin, and the ones made for a project's private skills and for an agent. */
const plugins = home => ({
  account: path.join(home, "learned"),
  project: slug => path.join(home, "learned", "projects", slug),
  agent: agent => path.join(home, "learned", "agents", agent),
});

const MANIFEST = (name, what) => ({
  name, displayName: "Vyre learned skills" + (what ? ` (${what})` : ""), version: "0.0.1",
  description: "Skills Vyre learned from procedures the user repeats. Each was installed by the user; review them with `vyre learn skills`.",
  author: { name: "Vyre AI", url: "https://vyre.run" },
});

/** Make dir a plugin with its own manifest, private to this user. */
function ensurePlugin(dir, manifest) {
  fs.mkdirSync(path.join(dir, ".claude-plugin"), { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
  const file = path.join(dir, ".claude-plugin", "plugin.json");
  const text = JSON.stringify(manifest, null, 2) + "\n";
  let old = null;
  try { old = fs.readFileSync(file, "utf8"); } catch { /* new */ }
  if (old !== text) writePrivate(file, text);
}

function writePrivate(file, text) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text, { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, file);
}

/**
 * The extra `--plugin-dir` folders a Switchboard thread loads after the Harness: the account's
 * learned skills, and this project's private ones and this agent's, each only when it exists.
 * @param {string} home  the Vyre home
 * @param {{ project?: string|null, agent?: string|null }} [where]
 * @returns {string[]}
 */
export function pluginDirs(home, { project, agent } = {}) {
  const p = plugins(home);
  const dirs = [p.account];
  if (project && SLUG.test(project)) dirs.push(p.project(project));
  if (agent && SLUG.test(agent)) dirs.push(p.agent(agent));
  return dirs.filter(d => fs.existsSync(path.join(d, ".claude-plugin", "plugin.json")) && fs.existsSync(path.join(d, "skills")));
}

// ---------------------------------------------------------------------------------------------
// The store

/**
 * Skills from repeated procedures, over the learn module's database (SKILL_MIGRATIONS applied).
 * @param {import("node:sqlite").DatabaseSync} db
 * @param {{ now?: () => number, emit?: (name: string, payload: any, opts?: any) => void, claudeDir?: string }} [opts]
 *   claudeDir is the user's own Claude Code folder, never written to (default ~/.claude).
 */
export function createSkills(db, { now = () => Date.now(), emit = () => {}, claudeDir = path.join(os.homedir(), ".claude") } = {}) {
  const put = db.prepare(`INSERT INTO learn_procs (hash, shape, project, session, seq, at, clean) VALUES (?,?,?,?,?,?,0)
    ON CONFLICT (hash, session) DO UPDATE SET seq = excluded.seq, at = excluded.at, project = excluded.project, shape = excluded.shape
    WHERE learn_procs.clean = 0`);
  const markClean = db.prepare("UPDATE learn_procs SET clean = 1 WHERE session = ? AND seq = ?");
  const getSkill = db.prepare("SELECT * FROM learn_skills WHERE id = ?");
  const taken = db.prepare("SELECT source FROM learn_skills WHERE status IN ('proposed','installed','dismissed')");
  const nameUsed = db.prepare("SELECT 1 FROM learn_skills WHERE name = ? AND status IN ('proposed','installed')");

  const row = r => r && {
    id: r.id, name: r.name, scope: JSON.parse(r.scope), status: r.status, body: r.body, hash: r.hash, path: r.path,
    source: JSON.parse(r.source), sessions: r.sessions, created: r.created, updated: r.updated,
  };
  const must = id => { const s = row(getSkill.get(id)); if (!s) throw new Error(`no skill ${id}`); return s; };
  const contains = (long, short) => ("\n" + long.join("\n") + "\n").includes("\n" + short.join("\n") + "\n");

  /** Never ~/.claude, never the Harness's own skills, never outside root. */
  const guard = (file, root) => {
    const f = real(file), r = real(root);
    const claude = real(claudeDir);
    if (inside(claude, f) || inside(path.resolve(claudeDir), path.resolve(file))) throw new Error(`refusing to write under ${claudeDir}: the user's own Claude Code setup is not Vyre's to change`);
    if (inside(real(HARNESS), f)) throw new Error("refusing to write into the Harness's own skills");
    if (!inside(r, f) || f === r) throw new Error(`refusing a path outside ${root}`);
  };

  return {
    /**
     * A turn's steps at Stop: its fingerprints, one transaction, at most 40 rows.
     * @param {{ session: string, seq: number, project?: string|null, steps: string[] }} turn
     */
    record({ session, seq, project = null, steps }) {
      if (!session) return 0;
      const fps = fingerprints(steps);
      if (!fps.length) return 0;
      const at = now();
      db.exec("SAVEPOINT learn_skills_record");
      try {
        for (const f of fps) put.run(f.hash, JSON.stringify(f.steps), project ?? null, session, seq, at);
        db.exec("RELEASE learn_skills_record");
      } catch (e) {
        db.exec("ROLLBACK TO learn_skills_record"); db.exec("RELEASE learn_skills_record");
        throw e;
      }
      return fps.length;
    },

    /** At the next prompt: the turn was clean unless it was corrected or sent back. */
    mark({ session, seq, clean }) {
      if (!clean || !session) return 0;
      return Number(markClean.run(session, seq).changes);
    },

    /** Forget procedures older than `days` that never became skills. */
    prune({ days = 90 } = {}) {
      return Number(db.prepare("DELETE FROM learn_procs WHERE at < ?").run(now() - days * 86400000).changes);
    },

    /**
     * Hashes clean in at least `min` distinct sessions, not already proposed, installed or
     * dismissed; among runs that contain one another, the longest.
     * @returns {{ hash: string, steps: string[], sessions: number, scope: "all"|{project: string} }[]}
     */
    candidates({ min = 3 } = {}) {
      const rows = db.prepare(`SELECT hash, MAX(shape) AS shape, COUNT(DISTINCT session) AS sessions,
          COUNT(DISTINCT COALESCE(project, '')) AS projects, MAX(project) AS project
        FROM learn_procs WHERE clean = 1 GROUP BY hash HAVING COUNT(DISTINCT session) >= ?`).all(min);
      const have = taken.all().map(r => { try { return JSON.parse(r.source); } catch { return {}; } });
      const done = new Set(have.map(s => s.fp).filter(Boolean));
      const longer = have.map(s => s.steps).filter(Array.isArray);
      const all = rows.filter(r => !done.has(r.hash)).map(r => ({
        hash: String(r.hash), steps: /** @type {string[]} */ (JSON.parse(String(r.shape))), sessions: Number(r.sessions),
        scope: /** @type {"all"|{project: string}} */ (Number(r.projects) === 1 && r.project ? { project: String(r.project) } : "all"),
      }));
      all.sort((a, b) => b.steps.length - a.steps.length || b.sessions - a.sessions || (a.hash < b.hash ? -1 : 1));
      const out = [];
      for (const c of all) {
        if (longer.some(l => contains(l, c.steps))) continue;
        if (out.some(o => contains(o.steps, c.steps))) continue;
        out.push(c);
      }
      return out;
    },

    template,

    /** A candidate becomes a proposed skill; the body is a model's draft or the template. */
    propose(candidate, { body } = {}) {
      const text = body ?? template(candidate);
      const fm = frontmatter(text);
      if (fm.error) throw new Error(fm.error);
      let name = fm.name, i = 2;
      while (nameUsed.get(name)) { const sfx = `-${i++}`; name = fm.name.slice(0, MAX_NAME - sfx.length) + sfx; }
      const final = name === fm.name ? text : text.replace(/^(---\n[\s\S]*?^name:\s*).*$/m, `$1${name}`);
      const at = now();
      const r = db.prepare(`INSERT INTO learn_skills (name, scope, status, body, hash, path, source, sessions, created, updated)
        VALUES (?,?,'proposed',?,NULL,NULL,?,?,?,?)`).run(name, JSON.stringify(candidate.scope ?? "all"), final,
        JSON.stringify({ kind: body ? "drafted" : "template", fp: candidate.hash, steps: candidate.steps }), candidate.sessions || 0, at, at);
      const s = must(Number(r.lastInsertRowid));
      emit("skill.proposed", { skill: s.id, name: s.name, scope: s.scope, sessions: s.sessions });
      return s;
    },

    /**
     * Install a proposed skill (the user's call, with presence). Writes one SKILL.md, 0600 in
     * 0700 folders, and records its sha256 and path.
     * @param {number} id
     * @param {{ home: string, projectHome?: string, scope: "account"|"project"|"agent", agent?: string, private?: boolean, project?: string }} where
     */
    install(id, where) {
      const s = must(id);
      if (s.status !== "proposed") throw new Error(`skill ${id} is ${s.status}`);
      const { home, scope } = where || /** @type {any} */ ({});
      if (!home || !path.isAbsolute(home)) throw new Error("home must be an absolute path");
      const p = plugins(home);
      let root, dir;
      if (scope === "account") {
        ensurePlugin(p.account, MANIFEST("vyre-learned", ""));
        root = p.account;
      } else if (scope === "project" && where.private) {
        const slug = where.project || (s.scope && s.scope.project);
        if (!slug || !SLUG.test(slug)) throw new Error("a private project skill needs the project's slug");
        root = p.project(slug);
        guard(path.join(root, "skills"), p.account);
        ensurePlugin(root, MANIFEST(`vyre-learned-project-${slug}`.toLowerCase(), `project ${slug}`));
      } else if (scope === "project") {
        if (!where.projectHome || !path.isAbsolute(where.projectHome)) throw new Error("a project skill needs the project's home folder");
        root = path.join(where.projectHome, ".claude", "skills");
        dir = path.join(root, s.name);
      } else if (scope === "agent") {
        if (!where.agent || !SLUG.test(where.agent)) throw new Error("an agent skill needs the agent's name");
        root = p.agent(where.agent);
        guard(path.join(root, "skills"), p.account);
        ensurePlugin(root, MANIFEST(`vyre-learned-agent-${where.agent}`.toLowerCase(), `agent ${where.agent}`));
      } else throw new Error('scope must be "account", "project" or "agent"');
      dir = dir || path.join(root, "skills", s.name);
      const file = path.join(dir, "SKILL.md");
      guard(file, root);
      let old = null;
      try { old = fs.readFileSync(file, "utf8"); } catch { /* new */ }
      if (old !== null && old !== s.body) throw new Error(`a different skill already exists at ${file}`);
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      guard(file, root);                                  // again, now that the folders exist
      fs.chmodSync(dir, 0o700);
      if (scope !== "project" || where.private) fs.chmodSync(path.join(root, "skills"), 0o700);
      writePrivate(file, s.body);
      const install = { scope, private: Boolean(where.private), project: scope === "project" ? (where.project || (s.scope && s.scope.project) || null) : null, agent: scope === "agent" ? where.agent : null };
      const source = { ...s.source, install };
      db.prepare("UPDATE learn_skills SET status = 'installed', hash = ?, path = ?, source = ?, updated = ? WHERE id = ?")
        .run(sha256(s.body), file, JSON.stringify(source), now(), id);
      emit("skill.installed", { skill: id, name: s.name, scope });
      return must(id);
    },

    /** Installed skills whose file changed or is gone. */
    drift() {
      const out = [];
      for (const r of db.prepare("SELECT * FROM learn_skills WHERE status = 'installed' ORDER BY id").all()) {
        const s = row(r);
        let text = null;
        try { text = fs.readFileSync(String(s.path), "utf8"); } catch { /* gone */ }
        if (text === null) out.push({ id: s.id, name: s.name, path: s.path, state: "missing" });
        else if (sha256(text) !== s.hash) out.push({ id: s.id, name: s.name, path: s.path, state: "changed" });
      }
      return out;
    },

    /** Remove an installed skill's file (the user's call, with presence). */
    retire(id) {
      const s = must(id);
      if (s.status !== "installed") throw new Error(`skill ${id} is ${s.status}`);
      if (s.path) {
        const dir = path.dirname(s.path);
        guard(s.path, path.dirname(dir));
        fs.rmSync(s.path, { force: true });
        try { fs.rmdirSync(dir); } catch { /* not empty: leave what someone else put there */ }
      }
      db.prepare("UPDATE learn_skills SET status = 'retired', updated = ? WHERE id = ?").run(now(), id);
      emit("skill.retired", { skill: id, name: s.name });
      return must(id);
    },

    /** The user said no to a proposed skill; its procedure is not proposed again. */
    dismiss(id) {
      const s = must(id);
      if (s.status !== "proposed") throw new Error(`skill ${id} is ${s.status}`);
      db.prepare("UPDATE learn_skills SET status = 'dismissed', updated = ? WHERE id = ?").run(now(), id);
      return must(id);
    },

    /** Skills, all or with one status. */
    list({ status } = {}) {
      const rows = status ? db.prepare("SELECT * FROM learn_skills WHERE status = ? ORDER BY id").all(status) : db.prepare("SELECT * FROM learn_skills ORDER BY id").all();
      return rows.map(row);
    },
  };
}
