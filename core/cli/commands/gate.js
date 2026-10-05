// @ts-check
// `vyre gate` (also `vyre drafts`): what is held at the Gate, from the terminal. The Deck's gate
// card (the app's gate item) in words: list the held drafts, read one in full, change it,
// send it or discard it.
//
// Who may do what is vyred's to say (core/gate/index.js, core/presence): approving a send, a spend
// or a deletion is human-only, so it goes through callAsPerson, which asks this terminal for the
// person's proof, every time: a send is never covered by the terminal's window (ADR 0004, a
// terminal can be typed into by other processes). Revising and discarding send nothing and ask no
// proof (PERSON_ONLY), but vyred still refuses them from a process under a `claude`, so a model's
// shell cannot run them.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { call } from "../../daemon/client.js";
import { callAsPerson } from "../presence.js";
import { out, dim, bold, signal, beacon } from "../style.js";
import { EXIT, json, emit, fail, failTool, usage, parse, viewing } from "../kit.js";
import { prompt } from "../view.js";
import { up } from "./projects.js";
import { id8, cut, age, sourceOf } from "./needs.js";

/** Every verb gate() handles, for `vyre commands --json`; gate() refuses any other word. */
export const VERBS = [
  { verb: "list", aliases: ["ls"], summary: "the held drafts, newest first (the default)", usage: "[--project <p>] [--thread <t>] [--json]", read: true },
  { verb: "show", aliases: ["get"], summary: "one draft in full: where it goes, the words, what approving takes", usage: "<id> [--json]", read: true },
  { verb: "approve", aliases: ["send"], summary: "send exactly what show shows; asks you to prove it is you", usage: "<id> [--json]", person: true },
  { verb: "reject", aliases: ["discard"], summary: "discard it; nothing is sent", usage: "<id> [reason...] [--json]" },
  { verb: "revise", aliases: ["edit"], summary: "change the words in $EDITOR, or with --text or --file", usage: "<id> [--text <words>] [--file <path>] [--subject <s>] [--to <a,b>] [--set <key=value>] [--json]" },
];
const SUBS = VERBS.flatMap(v => [v.verb, ...(v.aliases || [])]);
const FLAGS = {
  list: { values: ["project", "thread"], cmd: "gate" },
  revise: { values: ["text", "file", "subject", "to"], multi: ["set"], cmd: "gate" },
};

/**
 * A held item's id from its full id or a unique start of it. Only held items are searched, so an
 * id that is already sent or discarded is handed to vyred as typed and it says what became of it.
 * @returns {Promise<{ id: string } | { error: string, usage?: boolean }>}
 */
export async function resolveHeld(ref) {
  const q = String(ref || "").trim().toLowerCase();
  if (!q) return { error: "which draft? give its id or the start of it", usage: true };
  const r = await call("gate.held", {});
  if (r.error) return { error: r.error.message || r.error.code };
  const rows = /** @type {any[]} */ (r.data || []);
  if (rows.some(d => d.id === q)) return { id: q };
  const hits = rows.filter(d => String(d.id).startsWith(q));
  if (hits.length === 1) return { id: hits[0].id };
  if (hits.length > 1) return { error: `${hits.length} held drafts start with "${q}": ${hits.slice(0, 4).map(d => id8(d.id)).join(", ")}` };
  return { id: q };
}

function missed(f) {
  const next = "vyre gate lists the held drafts";
  return f.usage ? usage(f.error, next) : fail(f.error, { next });
}

/** The content as it will go out: the last revision, else the draft. */
const current = it => (it && (it.final || it.draft)) || {};

/**
 * The field a person edits as "the words": body, else text, else the longest string field.
 * @param {Record<string, any>} c
 */
export function bodyKey(c) {
  if ("body" in c) return "body";
  if ("text" in c) return "text";
  const strings = Object.entries(c).filter(([, v]) => typeof v === "string").sort((a, b) => b[1].length - a[1].length);
  return strings.length ? strings[0][0] : "body";
}

/** One held draft on two lines. */
function row(d) {
  const to = [d.to].flat().filter(Boolean).join(", ");
  out(`  ${beacon(id8(d.id))}  ${String(d.kind).padEnd(6)} ${dim(age(d.at).padStart(3))}  ${cut(`via ${d.via}${to ? " to " + to : ""}${d.summary ? ": " + d.summary : ""}`, 70)}`);
  out(dim(`            ${cut(sourceOf(d), 40)}${d.error ? " · last send failed: " + cut(d.error, 40) : ""}`));
}

/** A draft in full: where it goes, what it says, and what approving it takes. */
function page(it) {
  const c = current(it);
  const to = [it.to].flat().filter(Boolean).join(", ");
  out(`  ${bold(`${it.kind} via ${it.via}`)}  ${dim([id8(it.id), it.state, age(it.at) + " ago"].join(" · "))}`);
  out(`  ${dim("to".padEnd(9))}${to || dim("(no destination)")}`);
  const key = bodyKey(c);
  for (const [k, v] of Object.entries(c)) {
    if (k === key) continue;
    out(`  ${dim(k.padEnd(9))}${typeof v === "string" ? v : JSON.stringify(v)}`);
  }
  out(dim("  " + "-".repeat(40)));
  const body = c[key];
  const text = typeof body === "string" ? body : body === undefined ? "" : JSON.stringify(body, null, 2);
  for (const line of (text || dim("(empty)")).split("\n")) out("  " + line);
  out(dim("  " + "-".repeat(40)));
  const from = sourceOf(it);
  if (from !== "you") out(dim(`  from ${from}`));
  if (it.why) out(dim(`  why: ${cut(it.why, 200)}`));
  if (it.final) out(dim(`  revised${it.by ? " by " + it.by : ""}; this is what approving sends`));
  if (it.error) out(beacon(`  the last send failed: ${cut(it.error, 200)}`));
  if (it.state === "held") {
    const p = it.presence || {};
    const proof = p.required ? (p.covered ? "approving it rides your presence session" : "approving it asks you to prove it is you") : "approving it asks nothing more";
    out(dim(`  ${proof}`));
    const s = id8(it.id);
    out(dim(`  vyre gate approve ${s} · vyre gate revise ${s} · vyre gate reject ${s} [reason]`));
  }
}

/** A held draft as a card for --view: where it goes, each field, the words, what approving takes. */
export function card(it) {
  const c = current(it);
  const key = bodyKey(c);
  const show = v => typeof v === "string" ? v : v === undefined ? "" : JSON.stringify(v);
  const from = sourceOf(it);
  const fields = [
    { label: "Id", value: id8(it.id) },
    { label: "To", value: [it.to].flat().filter(Boolean).join(", ") || "(no destination)" },
    ...Object.entries(c).filter(([k]) => k !== key).map(([k, v]) => ({ label: k[0].toUpperCase() + k.slice(1), value: show(v) })),
    { label: "Words", value: show(c[key]) || "(empty)" },
    ...(from !== "you" ? [{ label: "From", value: from }] : []),
    ...(it.why ? [{ label: "Why", value: String(it.why) }] : []),
    ...(it.final ? [{ label: "Revised", value: `${it.by ? "by " + it.by + "; " : ""}this is what approving sends` }] : []),
    ...(it.error ? [{ label: "Last send", value: `failed: ${it.error}` }] : []),
    ...(it.state === "held" ? [{ label: "Next", value: `vyre gate approve ${id8(it.id)} · vyre gate revise ${id8(it.id)} · vyre gate reject ${id8(it.id)}` }] : []),
  ];
  // The draft's own state stays in data; the card's is Render's CheckState.
  const state = it.state === "held" ? "wait" : it.state === "sent" || it.state === "approved" ? "ok" : /reject|fail/.test(String(it.state)) ? "failed" : "unknown";
  return { kind: "card", title: `${it.kind} via ${it.via}`, state, fields };
}

/** Open $VISUAL or $EDITOR on text and return what was saved, or null when none can run here. */
function editText(text, name) {
  const editor = process.env.VISUAL || process.env.EDITOR || (process.stdin.isTTY ? "vi" : "");
  if (!editor) return null;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vyre-draft-"));
  const file = path.join(dir, name);
  try {
    fs.writeFileSync(file, text, { mode: 0o600 });
    // The editor may carry its own words ("code -w"), so the shell splits it; the file is $1.
    const r = spawnSync("sh", ["-c", `${editor} "$1"`, "sh", file], { stdio: "inherit" });
    if (r.status !== 0) throw new Error(`the editor (${editor}) exited with ${r.status ?? r.signal}`);
    return fs.readFileSync(file, "utf8");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** @type {Record<string, (args: string[], opts: { io?: any }) => Promise<number>>} */
const run = {
  async list(args) {
    const { flags } = parse(args, FLAGS.list);
    const r = await call("gate.held", { ...(flags.project ? { project: flags.project } : {}), ...(flags.thread ? { thread: flags.thread } : {}) });
    if (r.error) return failTool(r.error);
    const rows = /** @type {any[]} */ (r.data || []).slice().sort((a, b) => b.at - a.at);
    if (json()) return emit(rows);
    if (!rows.length) { out(dim("  nothing is held at the Gate")); return 0; }
    rows.forEach(row);
    out(dim("  vyre gate show <id> · vyre gate approve <id> · vyre gate reject <id>"));
    return 0;
  },

  async show(args) {
    const f = await resolveHeld(args[0]);
    if ("error" in f) return missed(f);
    const r = await call("gate.get", { id: f.id });
    if (r.error) return failTool(r.error, "vyre gate lists the held drafts");
    if (json()) return emit(r.data, card(r.data));
    page(r.data);
    return 0;
  },

  async approve(args, { io } = {}) {
    if (args.length > 1) return usage("vyre gate approve <id>: change the words first with vyre gate revise", "vyre help gate");
    const f = await resolveHeld(args[0]);
    if ("error" in f) return missed(f);
    // Read first: an id that is not there, or no longer held, is said plainly, not as a request
    // for a proof. And what goes out is shown before any proof is asked for: never approve blind.
    const g = await call("gate.get", { id: f.id });
    if (g.error) return failTool(g.error, "vyre gate lists the held drafts");
    if (g.data.state !== "held") return fail(`${id8(f.id)} is already ${g.data.state}`, { next: `vyre gate show ${id8(f.id)}` });
    if (!json()) {
      const c = current(g.data);
      out(`  ${bold(`${g.data.kind} via ${g.data.via}`)} to ${[g.data.to].flat().join(", ")}${c.subject ? dim(` · ${cut(c.subject, 60)}`) : ""}`);
    }
    const r = await callAsPerson("gate.approve", { id: f.id }, io ? { io } : {});
    if (r.error) return failTool(r.error, r.error.code === "failed" || r.error.code === "denied" ? "vyre gate show " + id8(f.id) : undefined);
    if (json()) { emit(r.data); return r.data.state === "sent" ? 0 : 1; }
    if (r.data.state === "sent") { out(`  ${signal("sent")} ${dim(id8(f.id))}`); return 0; }
    return fail(`not sent: ${r.data.error || "the sender failed"}. It is still held`, { next: `vyre gate approve ${id8(f.id)} tries again · vyre gate show ${id8(f.id)}` });
  },

  async reject(args) {
    const [ref, ...words] = args;
    const f = await resolveHeld(ref);
    if ("error" in f) return missed(f);
    const r = await call("gate.reject", { id: f.id, ...(words.length ? { reason: words.join(" ") } : {}) });
    if (r.error) return failTool(r.error);
    if (json()) return emit(r.data);
    out(`  ${beacon("discarded")} ${dim(id8(f.id) + " · nothing was sent")}`);
    return 0;
  },

  async revise(args) {
    const { flags, pos } = parse(args, FLAGS.revise);
    if (pos.length > 1) return usage("vyre gate revise <id> [--text <words> | --file <path>] [--subject <s>] [--to <a,b>] [--set key=value]");
    const f = await resolveHeld(pos[0]);
    if ("error" in f) return missed(f);
    const g = await call("gate.get", { id: f.id });
    if (g.error) return failTool(g.error, "vyre gate lists the held drafts");
    const c = current(g.data);
    const key = bodyKey(c);
    /** @type {Record<string, any>} */
    const edited = {};
    if (flags.text !== undefined && flags.file !== undefined) return usage("vyre gate revise: give --text or --file, not both");
    if (flags.text !== undefined) edited[key] = String(flags.text);
    else if (flags.file !== undefined) {
      try { edited[key] = fs.readFileSync(flags.file === "-" ? 0 : String(flags.file), "utf8"); }
      catch (e) { return fail(`could not read ${flags.file}: ${/** @type {Error} */ (e).message}`); }
    }
    if (flags.subject !== undefined) edited.subject = String(flags.subject);
    if (flags.to !== undefined) edited.to = String(flags.to).split(",").map(s => s.trim()).filter(Boolean);
    for (const kv of flags.set || []) {
      const at = String(kv).indexOf("=");
      if (at < 1) return usage(`--set takes key=value, got ${kv}`);
      edited[String(kv).slice(0, at)] = String(kv).slice(at + 1);
    }
    if (!Object.keys(edited).length && viewing()) {
      // A surface has no editor to open: it asks for the new words, and runs args with --text.
      const was = c[key];
      emit({ id: f.id, field: key, current: was ?? "" }, prompt({ name: "text", label: `The new words for ${id8(f.id)}`,
        args: ["gate", "revise", id8(f.id)], answer: "flag", flag: "text" }));
      return EXIT.USAGE;
    }
    if (!Object.keys(edited).length) {
      // Nothing given: the words, in the person's own editor. A body that is not text (an HTTP
      // sender's JSON) is edited as JSON and read back as JSON.
      const was = c[key];
      const asJson = was !== undefined && typeof was !== "string";
      let text;
      try { text = editText(asJson ? JSON.stringify(was, null, 2) + "\n" : String(was ?? ""), `${id8(f.id)}.${asJson ? "json" : "txt"}`); }
      catch (e) { return fail(/** @type {Error} */ (e).message, { next: "nothing was changed · try --text or --file" }); }
      if (text === null) return usage("vyre gate revise: no editor here (set $EDITOR), or give --text or --file", "vyre help gate");
      if (asJson) {
        try { edited[key] = JSON.parse(text); } catch { return fail(`the ${key} is not valid JSON; nothing was changed`, { next: `vyre gate revise ${id8(f.id)}` }); }
        if (JSON.stringify(edited[key]) === JSON.stringify(was)) delete edited[key];
      } else {
        // Editors add a final newline; one that was not there before is not a change.
        const next = typeof was === "string" && !was.endsWith("\n") ? text.replace(/\n$/, "") : text;
        if (next !== String(was ?? "")) edited[key] = next;
      }
      if (!Object.keys(edited).length) {
        if (json()) return emit(g.data);
        out(dim("  nothing changed"));
        return 0;
      }
    }
    const r = await call("gate.revise", { id: f.id, edited });
    if (r.error) return failTool(r.error);
    if (json()) return emit(r.data);
    out(`  ${signal("revised")} ${dim(id8(f.id) + " · still held; approving sends exactly this")}`);
    out(dim(`  vyre gate show ${id8(f.id)} · vyre gate approve ${id8(f.id)}`));
    return 0;
  },
};
run.ls = run.list;
run.get = run.show;
run.send = run.approve;
run.discard = run.reject;
run.edit = run.revise;

/**
 * Run a subcommand. `io` is the terminal callAsPerson asks for the proof (a test gives a fake).
 * @param {string[]} args @param {{ io?: any }} [opts]
 */
export async function gate(args, opts = {}) {
  const words = args.filter(a => a !== "--json");
  // No subcommand, or only flags: the list.
  const bare = words.length === 0 || words[0].startsWith("--");
  const sub = bare ? "list" : words[0];
  if (!SUBS.includes(sub)) return usage(`vyre gate ${sub}: not a subcommand`, "vyre gate list|show|approve|reject|revise · vyre help gate");
  const rest = bare ? words : words.slice(1);
  // A mistyped flag is refused before vyred is started for it. A reason is free text.
  if (!["reject", "discard", "revise", "edit"].includes(sub)) parse(rest, FLAGS[sub] || { values: [], cmd: "gate" });
  if (!(await up())) return 5;
  return run[sub](rest, opts);
}

export default {
  name: "gate", aliases: ["drafts"], order: 30, usage: "vyre gate [list|show <id>|approve <id>|reject <id> [reason]|revise <id>] [--json]",
  verbs: VERBS,
  summary: "drafts held at the Gate: list, show one, approve (send), reject, or revise the words",
  help: [
    "Everything an agent or session wants to send, spend or delete waits at the Gate until you say.",
    "",
    "  vyre gate                          the held drafts, newest first (--project, --thread)",
    "  vyre gate show <id>                one in full: where it goes, the words, what approving takes",
    "  vyre gate approve <id>             send exactly what show shows; asks you to prove it is you",
    "                                     once, then this terminal is trusted for 30 minutes",
    "  vyre gate reject <id> [reason]     discard it; nothing is sent",
    "  vyre gate revise <id>              change the words in $EDITOR, or --text <words> / --file <path>",
    "                                     (--file - reads stdin); --subject, --to a,b, --set key=value",
    "",
    "An id is its first few characters, as vyre needs and vyre gate print them.",
  ].join("\n"),
  /** @param {string[]} args */
  run: args => gate(args),
};
