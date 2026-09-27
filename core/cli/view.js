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
//   prompt {kind, name, label, choices?, secret?, args}
//   error  {kind, code, message, next?}
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

/**
 * One frame line.
 * @param {string} cmd the words that name the verb ("threads list")
 * @param {any} data
 * @param {any} [view] the verb's own view; derived when left out
 */
export function frame(cmd, data, view) {
  return { v: VERSION, cmd, view: view && typeof view === "object" && view.kind ? view : derive(data), data: data === undefined ? null : data };
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
