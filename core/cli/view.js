// @ts-check
// view: what `vyre <cmd> --view` prints, so the Capsule, chat and the phone draw Vyre's answers
// natively instead of showing terminal text (docs/reference/cli-json.md).
//
// Every line on stdout is one frame, {v:1, cmd, view, data}, and the last is {v:1, done:true,
// exit}. `data` is exactly what --json prints for the verb. `view` says how to draw it:
//
//   table  {kind, columns:[{key,label}], rows, title?, empty?}
//   card   {kind, title?, fields:[{label,value}], state?}
//   text   {kind, lines}
//   qr     {kind, text, caption?}
//   checks {kind, items:[{id,label,state,note?}], title?}
//   prompt {kind, name, label, choices?, secret?, args, answer, flag?}
//   error  {kind, code, message, next?}
//
// Any view may carry actions: [{label, tool, input?}], buttons a surface offers next to it (the
// same field as platform's Render in packages/module-sdk).
//
// A prompt is how a verb asks under --view: it never reads a terminal, it exits 2 with a prompt
// frame, and the surface runs `vyre <args...>` again with the answer. `args` is the whole argv
// after `vyre` (kit.again() gives this run's). `answer` says where the answer goes:
//   word     appended as the last word            (threads rewind <thread> 3)
//   flag     appended as --<flag> <answer>        (gate revise <id> --text "...")
//   stdin    written to its stdin, never an arg   (secrets; args already carry --stdin)
//   confirm  run args as they are on yes, nothing on no (args already carry --yes)
//
// A verb picks its view (kit.emit(data, view)); one that does not gets one derived from its data
// here. A verb with no JSON at all still answers: its normal output, as a text frame.

export const VERSION = 1;
export const KINDS = Object.freeze(["table", "card", "text", "qr", "checks", "prompt", "error"]);

/** How many columns a derived table shows; the rest stay in `data`. */
const MAX_COLUMNS = 6;

const scalar = v => v === null || ["string", "number", "boolean"].includes(typeof v);
const plainObject = v => Boolean(v) && typeof v === "object" && !Array.isArray(v);

/** "last_seen" or "lastSeen" -> "Last seen". @param {string} key */
export function label(key) {
  const s = String(key).replace(/_/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase().trim();
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}

/** A value as one short line for a card field. */
function show(v) {
  if (v === null || v === undefined) return "";
  if (scalar(v)) return String(v);
  if (Array.isArray(v) && v.every(scalar)) return v.join(", ");
  if (Array.isArray(v)) return `${v.length} item${v.length === 1 ? "" : "s"}`;
  return JSON.stringify(v);
}

/** The columns for rows of objects: keys with a plain value, in first-seen order. @param {any[]} rows */
export function columns(rows) {
  const keys = [];
  for (const r of rows.slice(0, 50)) {
    if (!plainObject(r)) continue;
    for (const [k, v] of Object.entries(r)) if (!keys.includes(k) && (scalar(v) || (Array.isArray(v) && v.every(scalar)))) keys.push(k);
  }
  return keys.slice(0, MAX_COLUMNS).map(key => ({ key, label: label(key) }));
}

/**
 * The view for data a verb did not describe itself.
 * @param {any} data
 * @returns {any}
 */
export function derive(data) {
  if (data === undefined || data === null) return { kind: "text", lines: [] };
  if (scalar(data)) return { kind: "text", lines: String(data).split("\n") };
  if (plainObject(data) && plainObject(data.error)) {
    const e = data.error;
    return { kind: "error", code: String(e.code || "failed"), message: String(e.message || e.code || "failed"), ...(e.next ? { next: String(e.next) } : {}) };
  }
  if (Array.isArray(data)) {
    if (data.length && data.every(scalar)) return { kind: "text", lines: data.map(String) };
    return { kind: "table", columns: columns(data), rows: data, ...(data.length ? {} : { empty: "Nothing here yet" }) };
  }
  // {things: [...], ...a few plain fields}: a table of the things, titled by the fields.
  const lists = Object.entries(data).filter(([, v]) => Array.isArray(v) && v.length && v.some(plainObject));
  const empties = Object.entries(data).filter(([, v]) => Array.isArray(v) && !v.length);
  const rest = Object.entries(data).filter(([, v]) => !Array.isArray(v));
  if (lists.length === 1 && rest.every(([, v]) => scalar(v))) {
    const [key, rows] = lists[0];
    const title = rest.length ? rest.map(([k, v]) => `${label(k)}: ${show(v)}`).join(" · ") : label(key);
    return { kind: "table", title, columns: columns(rows), rows };
  }
  if (!lists.length && empties.length === 1 && rest.every(([, v]) => scalar(v))) {
    return { kind: "table", title: label(empties[0][0]), columns: [], rows: [], empty: "Nothing here yet" };
  }
  return { kind: "card", fields: Object.entries(data).map(([k, v]) => ({ label: label(k), value: show(v) })) };
}

/** A check's or a card's state (platform's CheckState). */
export const STATES = Object.freeze(["ok", "wait", "failed", "unknown"]);

/**
 * What in a view does not fit platform's Render (packages/module-sdk/index.d.ts), as short
 * reasons; [] when it fits. Surfaces draw exactly that type, so the CLI's tests hold every view
 * the CLI makes to it.
 * @param {any} v
 * @returns {string[]}
 */
export function renderProblems(v) {
  const bad = [];
  const str = x => typeof x === "string";
  const list = (x, each, what) => { if (!Array.isArray(x)) bad.push(`${what} is not a list`); else x.forEach((e, i) => { const why = each(e); if (why) bad.push(`${what}[${i}]: ${why}`); }); };
  if (!v || typeof v !== "object" || !KINDS.includes(v.kind)) return [`kind is not one of ${KINDS.join(", ")}`];
  if (v.title !== undefined && !str(v.title)) bad.push("title is not text");
  if (v.actions !== undefined) list(v.actions, a => (a && str(a.label) && str(a.tool) ? null : "an action needs label and tool"), "actions");
  const known = { table: ["columns", "rows", "empty"], card: ["fields", "state"], text: ["lines"], qr: ["text", "caption"], checks: ["items"],
    prompt: ["name", "label", "choices", "secret", "args", "answer", "flag", "tool", "input"], error: ["code", "message", "next"] }[v.kind];
  for (const k of Object.keys(v)) if (!["kind", "title", "actions", ...known].includes(k)) bad.push(`${v.kind} has no field ${k}`);
  switch (v.kind) {
    case "table":
      list(v.columns, c => (c && str(c.key) && str(c.label) ? null : "a column is {key, label}"), "columns");
      list(v.rows, r => (r && typeof r === "object" && !Array.isArray(r) ? null : "a row is an object"), "rows");
      if (v.empty !== undefined && !str(v.empty)) bad.push("empty is not text");
      break;
    case "card":
      list(v.fields, f => (f && str(f.label) && "value" in f ? null : "a field is {label, value}"), "fields");
      if (v.state !== undefined && !STATES.includes(v.state)) bad.push(`state ${v.state} is not one of ${STATES.join(", ")}`);
      break;
    case "text": list(v.lines, l => (str(l) ? null : "a line is text"), "lines"); break;
    case "qr": if (!str(v.text) || !v.text) bad.push("qr needs its text"); if (v.caption !== undefined && !str(v.caption)) bad.push("caption is not text"); break;
    case "checks":
      list(v.items, c => (c && str(c.id) && str(c.label) && STATES.includes(c.state) ? null : "a check is {id, label, state}"), "items");
      break;
    case "prompt":
      if (!str(v.name) || !str(v.label)) bad.push("a prompt needs name and label");
      if (v.choices !== undefined) list(v.choices, c => (str(c) ? null : "a choice is text"), "choices");
      if (Array.isArray(v.args)) { if (!ANSWERS.includes(v.answer)) bad.push("an argv prompt needs answer"); if (v.answer === "flag" && !str(v.flag)) bad.push("a flag prompt names its flag"); }
      else if (!str(v.tool)) bad.push("a prompt is answered by args or a tool");
      break;
    case "error": if (!str(v.code) || !str(v.message)) bad.push("an error needs code and message"); break;
  }
  return bad;
}

/**
 * One frame line.
 * @param {string} cmd the words that name the verb ("threads list")
 * @param {any} data
 * @param {any} [view] the verb's own view; derived when left out
 */
export function frame(cmd, data, view) {
  // Tests run with VYRE_CHECK_VIEWS=1: a view that does not fit Render fails the verb there.
  if (process.env.VYRE_CHECK_VIEWS === "1" && view) {
    const bad = renderProblems(view);
    if (bad.length) throw new Error(`the ${cmd} view does not fit Render: ${bad.join("; ")}`);
  }
  return { v: VERSION, cmd, view: view && typeof view === "object" && view.kind ? view : derive(data), data: data === undefined ? null : data };
}

/** How a prompt's answer goes back in. */
export const ANSWERS = Object.freeze(["word", "flag", "stdin", "confirm"]);

/**
 * A prompt frame's view, checked: a verb builds it here so every prompt says where its answer goes.
 * @param {{ name: string, label: string, args: string[], answer: string, flag?: string, choices?: string[], secret?: boolean }} p
 */
export function prompt(p) {
  if (!ANSWERS.includes(p.answer)) throw new Error(`a prompt's answer is one of ${ANSWERS.join(", ")}`);
  if (p.answer === "flag" && !p.flag) throw new Error("a flag prompt names its flag");
  return { kind: "prompt", name: p.name, label: p.label, args: p.args, answer: p.answer, ...(p.flag ? { flag: p.flag } : {}),
    ...(p.choices ? { choices: p.choices } : {}), ...(p.secret || p.answer === "stdin" ? { secret: true } : {}) };
}

/** The last frame. @param {number} exit */
export const done = exit => ({ v: VERSION, done: true, exit });

/**
 * The words that name a verb, for `cmd`: the command and its first plain word, if any.
 * @param {string} name @param {string[]} args
 */
export function verbWords(name, args) {
  const first = args.find(a => !a.startsWith("-"));
  return first && /^[a-z][a-z-]*$/.test(first) ? `${name} ${first}` : name;
}

/** Text a person would see, without colour or cursor codes, as lines. @param {string[]} chunks */
export function textLines(chunks) {
  const s = chunks.join("").replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").replace(/\r/g, "");
  const lines = s.split("\n");
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  while (lines.length && !lines[0].trim()) lines.shift();
  return lines;
}
