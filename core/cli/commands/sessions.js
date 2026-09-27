// @ts-check
// `vyre sessions`: how the sessions Vyre starts run (docs/adr/0030-sessions.md), the same settings
// the Deck shows. Which driver and sign-in, the Agent SDK install, the model each kind of session
// runs on, and the system prompt at three levels, with its history and undo.
//
// Changing a model or a system prompt is the person's own act (PERSON_ONLY): vyred refuses it from
// inside any Claude session. It asks no presence, so it goes through plain call(), as
// `vyre threads answer` does; the refusal names where to do it instead.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { call } from "../../daemon/client.js";
import { out, dim, bold, signal, beacon } from "../style.js";
import { json, emit, fail, failTool, usage, parse, viewing, again, EXIT } from "../kit.js";
import { prompt as promptView } from "../view.js";
import { up } from "./projects.js";

/** The kinds of session a model is set for (core/sessions/config.js PURPOSES). */
export const PURPOSES = ["chat", "agent", "project", "capsule", "job", "memory", "planner", "learn"];
const ADR = "Vyre-owned sessions (ADR 0030)";

/**
 * Print a tool's error the way this command says it, and return the exit code. A vyred without
 * the tool yet is one plain line naming what is coming; a person-only change refused from inside
 * a Claude session says where it can be done.
 * @param {{ code: string, message?: string }} error @param {string} name the tool, for the message
 */
export function toolError(error, name) {
  if (error.code === "no_such_tool") return fail(`${name} is coming with ${ADR}; this vyred does not have it yet`);
  if (error.code === "denied") return fail(String(error.message || "refused"), { code: "denied", next: "do it from the Deck, or from a plain terminal that is not inside Claude Code" });
  return failTool(error);
}

/** A tool's data, or null after printing its error. */
async function tool(name, input = {}, opts) {
  const r = await call(name, input, opts);
  if (r.error) { toolError(r.error, name); return null; }
  return r.data;
}

/**
 * Open $VISUAL or $EDITOR on text and return what was saved (a trailing newline dropped), or null
 * when no editor can run here: none set and no terminal to run vi in.
 * @param {string} text @param {string} name the file's name, so the editor picks a mode
 */
export function editText(text, name) {
  const editor = process.env.VISUAL || process.env.EDITOR || (process.stdin.isTTY ? "vi" : "");
  if (!editor) return null;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vyre-edit-"));
  const file = path.join(dir, name);
  try {
    fs.writeFileSync(file, text, { mode: 0o600 });
    // The editor may carry its own words ("code -w"), so the shell splits it; the file is $1.
    const r = spawnSync("sh", ["-c", `${editor} "$1"`, "sh", file], { stdio: "inherit" });
    if (r.status !== 0) throw new Error(`the editor (${editor}) exited with ${r.status ?? r.signal}`);
    return fs.readFileSync(file, "utf8").replace(/\r?\n$/, "");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * A model scope from what was typed: a purpose name, a project slug, or either spelled out
 * ("purpose:chat", "project:northwind-bakery").
 * @param {string} word
 */
export function modelScope(word) {
  const w = String(word || "").trim();
  if (/^(purpose|project):/.test(w)) return w;
  return PURPOSES.includes(w) ? `purpose:${w}` : `project:${w}`;
}

/** A prompt scope, or null when the word is not one: assistant, agent:<name>, project:<slug>. */
export function promptScope(word) {
  const w = String(word || "").trim();
  return w === "assistant" || /^(agent|project):\S+$/.test(w) ? w : null;
}

/** sessions.prompt.preview's input for a scope: the agent or project it names. */
export function previewInput(scope) {
  const m = /^(agent|project):(.+)$/.exec(scope);
  return m ? { [m[1]]: m[2] } : {};
}

const when = ms => (Number.isFinite(ms) ? new Date(ms).toISOString().slice(0, 16).replace("T", " ") : "");
const first = (s, n = 70) => { const t = String(s || "").split("\n").find(l => l.trim()) || ""; return t.length > n ? t.slice(0, n - 1) + "…" : t; };

// ------------------------------------------------------------ subcommands

// --json: { driver, auth, binary, claude, idle_minutes, max_live, sdk: { installed, version, download_mb } }
async function status() {
  const s = await tool("sessions.status");
  if (!s) return 1;
  const sdk = s.sdk || {};
  if (json()) {
    emit(s, { kind: "card", title: "Sessions", state: sdk.installed ? "ok" : "wait", fields: [
      { label: "Driver", value: String(s.driver ?? "") },
      { label: "Sign-in", value: String(s.auth ?? "") },
      { label: "Claude Code", value: String(s.binary || s.claude || "") },
      { label: "Close when idle", value: s.idle_minutes ? `after ${s.idle_minutes} min` : "never" },
      { label: "Running at most", value: s.max_live ? String(s.max_live) : "no cap" },
      { label: "Agent SDK", value: sdk.installed ? `${sdk.version} installed` : `${sdk.version || ""} not installed (vyre sessions setup)`.trim() },
    ] });
    return 0;
  }
  out(`  ${bold("sessions")}  ${dim("driver")} ${signal(s.driver)}  ${dim("sign-in")} ${s.auth}  ${dim("Claude Code")} ${s.binary || s.claude}`);
  out(dim(`  close when idle after ${s.idle_minutes ? s.idle_minutes + " min" : "never"} · ${s.max_live ? "at most " + s.max_live + " running" : "no cap on running sessions"}`));
  out(sdk.installed ? dim(`  Agent SDK ${sdk.version} installed`)
    : dim(`  Agent SDK ${sdk.version || ""} not installed (about ${sdk.download_mb || "?"} MB) · vyre sessions setup installs it now`));
  out(dim("  vyre sessions models · vyre sessions prompt"));
  return 0;
}

async function setup() {
  if (!json()) out(dim("  installing the Claude Agent SDK; this can take a few minutes"));
  // A download: far longer than a tool call's usual 10 s.
  const s = await tool("sessions.setup", {}, { timeout: 15 * 60_000 });
  if (!s) return 1;
  if (json()) { emit(s); return 0; }
  out(`  ${signal("installed")} ${dim(`Agent SDK ${s.sdk?.version || ""}`)}`);
  if (s.note) out(dim("  " + s.note));
  return 0;
}

/** `vyre sessions models [purpose|project] [model|--clear]` */
async function models(args) {
  const { flags, pos } = parse(args, { bool: ["clear"], values: [], cmd: "sessions" });
  const [which, model] = pos;
  if (pos.length > 2) return usage("vyre sessions models [purpose|project] [model|--clear]");
  if (which && (model || flags.clear)) {
    if (model && flags.clear) return usage("give a model or --clear, not both", "vyre help sessions");
    const scope = modelScope(which);
    const r = await tool("sessions.models.set", { scope, model: flags.clear ? null : model });
    if (!r) return 1;
    if (json()) { emit(r); return 0; }
    out(r.model ? `  ${signal(scope)} runs on ${bold(r.model)} ${dim("from the next session")}` : `  ${signal(scope)} ${dim("back to its default from the next session")}`);
    return 0;
  }
  if (flags.clear) return usage("--clear needs a purpose or project: vyre sessions models <purpose|project> --clear");
  const m = await tool("sessions.models.get");
  if (!m) return 1;
  const purposes = m.purposes || {}, projects = m.projects || {};
  if (which) {
    const scope = modelScope(which);
    const [kind, name] = [scope.slice(0, scope.indexOf(":")), scope.slice(scope.indexOf(":") + 1)];
    const got = kind === "purpose" ? purposes[name] : projects[name] ? { model: projects[name], from: scope } : null;
    // --json: { scope, model, from? }
    if (json()) {
      emit({ scope, ...(got || { model: null }) }, { kind: "card", title: scope, fields: [{ label: "Model", value: got ? String(got.model) : "its purpose's" },
        ...(got && got.from ? [{ label: "From", value: String(got.from) }] : [])] });
      return 0;
    }
    if (!got) { out(dim(`  ${scope} has no model of its own · its sessions use their purpose's`)); return 0; }
    out(`  ${signal(scope)}  ${bold(got.model)}  ${dim(got.from ? "from " + got.from : "")}`);
    return 0;
  }
  // --json: { purposes: { <purpose>: { model, from } }, projects: { <slug>: model } }
  if (json()) {
    const rows = [...Object.entries(purposes).map(([p, v]) => ({ id: `purpose:${p}`, purpose: p, model: String(v?.model ?? v), from: v?.from ? String(v.from) : "" })),
      ...Object.entries(projects).map(([slug, v]) => ({ id: `project:${slug}`, purpose: `project ${slug}`, model: String(v), from: "" }))];
    emit(m, { kind: "table", title: "Models", columns: [{ key: "purpose", label: "Purpose" }, { key: "model", label: "Model" }, { key: "from", label: "From" }], rows, empty: "No models set" });
    return 0;
  }
  out(bold("  by purpose"));
  for (const [p, v] of Object.entries(purposes)) out(`  ${p.padEnd(9)} ${String(v?.model ?? v).padEnd(24)} ${dim(v?.from ? "from " + v.from : "")}`);
  const slugs = Object.keys(projects);
  if (slugs.length) {
    out(bold("  by project"));
    for (const s of slugs) out(`  ${s.padEnd(24)} ${projects[s]}`);
  }
  out(dim("  vyre sessions models <purpose|project> <model> sets one · --clear removes it"));
  return 0;
}

/** `vyre sessions prompt [scope] [show|set|history|revert <v>|preview]` */
async function prompt(args) {
  const { flags, pos } = parse(args, { bool: ["replace"], values: ["text", "file", "note"], cmd: "sessions" });
  const words = [...pos];
  const scope = promptScope(words[0]) ? /** @type {string} */ (words.shift()) : "assistant";
  if (words[0] && !["show", "set", "history", "revert", "preview"].includes(words[0]) && !promptScope(words[0])) {
    return usage(`"${words[0]}" is not a scope or an action: scopes are assistant, agent:<name>, project:<slug>`, "vyre help sessions");
  }
  const action = words.shift() || "show";
  if ((flags.text !== undefined || flags.file || flags.replace) && action !== "set") return usage("--text, --file and --replace go with set", "vyre help sessions");

  if (action === "show") {
    const r = await tool("sessions.prompt.get", { scope });
    if (!r) return 1;
    // --json: { scope, prompt: { version, text, mode, by, at } | null }
    if (json()) {
      const p = r.prompt;
      emit(r, { kind: "text", lines: p && p.text.trim() ? [`${scope} v${p.version} · ${p.mode === "replace" ? "replaces Claude Code's own" : "added after Claude Code's own"}${p.by ? " · by " + p.by : ""}`, ...p.text.split("\n")]
        : [`${scope} adds nothing to Claude Code's own system prompt`] });
      return 0;
    }
    const p = r.prompt;
    if (!p || !p.text.trim()) { out(dim(`  ${scope} adds nothing to Claude Code's own system prompt · vyre sessions prompt ${scope} set`)); return 0; }
    out(`  ${bold(scope)}  ${dim(`v${p.version} · ${p.mode === "replace" ? "replaces Claude Code's own" : "added after Claude Code's own"}${p.by ? " · by " + p.by : ""}`)}`);
    out(p.text.split("\n").map(l => "  " + l).join("\n"));
    return 0;
  }

  if (action === "history") {
    const r = await tool("sessions.prompt.history", { scope });
    if (!r) return 1;
    // --json: { scope, versions: [{ version, at, mode, by, text, note }] }
    if (json()) {
      emit(r, { kind: "table", title: `${scope} prompt history`, columns: [{ key: "version", label: "Version" }, { key: "at", label: "When" }, { key: "mode", label: "Mode" },
        { key: "by", label: "By" }, { key: "text", label: "Text" }],
      rows: (r.versions || []).map(v => ({ id: v.version, version: `v${v.version}`, at: when(v.at), mode: v.mode, by: v.by || "", text: v.text.trim() ? first(v.text) : "(cleared)" })),
      empty: `${scope} has never been set` });
      return 0;
    }
    const vs = r.versions || [];
    if (!vs.length) { out(dim(`  ${scope} has never been set`)); return 0; }
    for (const v of vs) out(`  ${signal(("v" + v.version).padEnd(4))} ${dim(when(v.at))}  ${v.mode.padEnd(7)} ${dim((v.by || "").padEnd(10))} ${v.text.trim() ? first(v.text) : dim("(cleared)")}${v.note ? dim("  " + v.note) : ""}`);
    out(dim(`  vyre sessions prompt ${scope} revert <version> goes back to one`));
    return 0;
  }

  if (action === "revert") {
    const v = words.shift();
    if (!v || !/^\d+$/.test(v)) return usage(`vyre sessions prompt ${scope} revert <version>`, `vyre sessions prompt ${scope} history lists them`);
    const r = await tool("sessions.prompt.revert", { scope, version: Number(v) });
    if (!r) return 1;
    if (json()) { emit(r); return 0; }
    out(`  ${signal("reverted")} ${scope} to v${v} ${dim(`as v${r.version}; applies from the next session`)}`);
    return 0;
  }

  if (action === "preview") {
    const r = await tool("sessions.prompt.preview", previewInput(scope));
    if (!r) return 1;
    const parts = (r.parts || []).map(p => `${p.scope} v${p.version}`).join(" + ");
    // --json: { text, mode, parts: [{ scope, version }], warning? }
    if (json()) {
      emit(r, { kind: "text", lines: [`A session here starts with ${r.mode === "replace" ? "only these (Claude Code's own is replaced)" : "Claude Code's own, then these"}${parts ? ": " + parts : ""}`,
        ...(r.warning ? [String(r.warning)] : []), ...(r.text && r.text.trim() ? r.text.split("\n") : ["(nothing added)"])] });
      return 0;
    }
    out(`  ${bold("a session here starts with")} ${dim(r.mode === "replace" ? "only these (Claude Code's own is replaced)" : "Claude Code's own, then these")}${parts ? dim(": " + parts) : ""}`);
    if (r.warning) out(beacon("  " + r.warning));
    out(r.text && r.text.trim() ? r.text.split("\n").map(l => "  " + l).join("\n") : dim("  (nothing added)"));
    out(dim("  Vyre's own launch text for the session is added to this at start"));
    return 0;
  }

  // set
  let text = flags.text;
  if (text === undefined && flags.file) {
    try { text = fs.readFileSync(flags.file, "utf8"); } catch (e) { return fail(`cannot read ${flags.file}: ${/** @type {Error} */ (e).message}`); }
  }
  if (text === undefined && words.length) text = words.join(" ");
  if (text === undefined) {
    // Nothing is read or opened for a surface: it asks for the text, then runs this again with it.
    if (viewing()) { emit(null, promptView({ name: "text", label: "The new system prompt", args: again(), answer: "flag", flag: "text" })); return EXIT.USAGE; }
    if (json()) return usage("vyre sessions prompt set needs --text or --file with --json");
    const cur = await tool("sessions.prompt.get", { scope });
    if (!cur) return 1;
    let edited;
    try { edited = editText(cur.prompt ? cur.prompt.text : "", "system-prompt.md"); } catch (e) { return fail(/** @type {Error} */ (e).message); }
    if (edited === null) return usage("no editor here (set $EDITOR), or give --text or --file", "vyre help sessions");
    if (cur.prompt && edited === cur.prompt.text && (flags.replace ? "replace" : "append") === cur.prompt.mode) { out(dim("  nothing changed")); return 0; }
    text = edited;
  }
  const r = await tool("sessions.prompt.set", { scope, text, mode: flags.replace ? "replace" : "append", ...(flags.note ? { note: flags.note } : {}) });
  if (!r) return 1;
  if (json()) { emit(r); return 0; }
  if (r.unchanged) { out(dim(`  nothing changed · ${scope} is still v${r.version}`)); return 0; }
  out(`  ${signal("saved")} ${scope} v${r.version} ${dim(`${r.text.trim() ? r.mode : "cleared"} · applies from the next session · vyre sessions prompt ${scope} revert ${Math.max(1, r.version - 1)} undoes it`)}`);
  if (r.warning) out(beacon("  " + r.warning));
  return 0;
}

export default {
  name: "sessions", order: 23, usage: "vyre sessions [status|setup|models|prompt] … [--json]",
  verbs: [
    { verb: "status", summary: "the driver, sign-in, Claude Code and the Agent SDK", usage: "", read: true },
    { verb: "setup", summary: "install the Agent SDK now and wait", usage: "" },
    { verb: "models", summary: "the model each kind of session runs on, or set one", usage: "[<scope>] [<model>] [--clear]", read: false },
    { verb: "prompt", summary: "the system prompt at one level: show, set, history, revert, preview", usage: "[<scope>] [show|set|history|revert|preview] [<version>] [--text v] [--file v] [--replace] [--note v]" },
  ],
  summary: "how the sessions Vyre starts run: driver, sign-in, the model per purpose, the system prompt",
  help: [
    "  vyre sessions [status]                          the driver, sign-in, Claude Code, the Agent SDK",
    "  vyre sessions setup                             install the Agent SDK now and wait",
    "  vyre sessions models                            the model each kind of session runs on",
    "  vyre sessions models <purpose|project> <model>  set one (opus, sonnet, haiku or a model id)",
    "  vyre sessions models <purpose|project> --clear  back to the default",
    `                                                  purposes: ${PURPOSES.join(", ")}`,
    "  vyre sessions prompt [scope] [show]             what sessions are told at one level",
    "  vyre sessions prompt [scope] set [--text T | --file F] [--replace] [--note N]",
    "                                                  a new version; with neither, opens $EDITOR",
    "  vyre sessions prompt [scope] history            every version, newest first",
    "  vyre sessions prompt [scope] revert <version>   go back to one (itself a new version)",
    "  vyre sessions prompt [scope] preview            what a session there would start with",
    "  scope: assistant (the default), agent:<name> or project:<slug>",
    "  --replace drops Claude Code's own system prompt: for experts.",
    "  Setting a model or a prompt is refused from inside Claude Code: use the Deck or a plain terminal.",
  ].join("\n"),
  /** @param {string[]} args */
  async run(args) {
    const rest = args.filter(a => a !== "--json");
    const [sub, ...more] = rest;
    const subs = { setup, models, prompt };
    if (sub && sub !== "status" && !(sub in subs) && !sub.startsWith("-")) return usage(`"${sub}" is not a vyre sessions command: status, setup, models or prompt`, "vyre help sessions");
    if (!(await up())) return 5;
    if (!sub || sub.startsWith("-") || sub === "status") { parse(sub === "status" ? more : rest, { values: [], cmd: "sessions" }); return status(); }
    return subs[/** @type {"setup"|"models"|"prompt"} */ (sub)](more);
  },
};
