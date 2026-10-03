// @ts-check
// The Block contract (docs/work/chat.md, 0.3): a tool result becomes one of
//   terminal | diff | files | record | task | draft | flow-change | answer | screen | text
// `normalizeBlock` checks the shape and returns a typed block the components draw. Anything unknown
// or malformed degrades to a short `text` block, never a JSON dump. A sealed field keeps no value:
// only its typed placeholder (class, present) survives here, so nothing downstream can render one.

/**
 * @typedef {{ label: string, kind: string, value: string, sealed?: false } | { label: string, kind: "sealed", sealed: true, cls: string, present: boolean }} RecordField
 * @typedef {{ block: "terminal", command: string, output: string, exit: number | null, running: boolean }
 *  | { block: "diff", files: DiffFile[] }
 *  | { block: "record", urn: string | null, type: string, title: string, fields: RecordField[] }
 *  | { block: "task", id: string, title: string, doer: string | null, state: string, why: string | null, face: boolean, approve: string, tags: string[] }
 *  | { block: "draft", kind: string, to: string | null, subject: string | null, body: string }
 *  | { block: "flow-change", title: string, steps: { op: string, label: string }[] }
 *  | { block: "answer", text: string, sources: { title: string, url: string | null }[] }
 *  | { block: "screen", label: string, live: boolean, frames: string[] }
 *  | { block: "text", text: string }} Block
 * @typedef {{ path: string, op: string, diff: string, add: number, del: number }} DiffFile
 */

const str = (/** @type {unknown} */ v, max = 8000) => (typeof v === "string" ? v.slice(0, max) : "");
const arr = (/** @type {unknown} */ v) => (Array.isArray(v) ? v : []);
const rec = (/** @type {unknown} */ v) => (v && typeof v === "object" && !Array.isArray(v) ? /** @type {Record<string, any>} */ (v) : null);

/** A short sentence for a block that could not be drawn: its own words, else the fallback. @param {unknown} raw @param {string} fallback */
function words(raw, fallback) {
  const o = rec(raw);
  if (typeof raw === "string") return raw.slice(0, 600);
  if (o) for (const k of ["text", "summary", "title", "message"]) if (typeof o[k] === "string" && o[k].trim()) return o[k].slice(0, 600);
  return fallback;
}

/** @param {unknown} raw @param {string} [fallback] @returns {Block} */
export function normalizeBlock(raw, fallback = "Done") {
  const o = rec(raw);
  const text = () => /** @type {Block} */ ({ block: "text", text: words(raw, fallback) });
  if (!o || typeof o.block !== "string") return text();
  switch (o.block) {
    case "terminal":
      return { block: "terminal", command: str(o.command, 400), output: str(o.output, 200000), exit: typeof o.exit === "number" ? o.exit : null, running: Boolean(o.running) };
    case "diff":
    case "files": {
      const files = arr(o.files).map((f) => rec(f)).filter(Boolean).map((f) => {
        const diff = str(f?.diff, 200000);
        const c = diff ? countDiff(diff) : { add: Number(f?.add) || 0, del: Number(f?.del) || 0 };
        return { path: str(f?.path, 300), op: ["create", "edit", "delete"].includes(f?.op) ? f?.op : "edit", diff, add: c.add, del: c.del };
      });
      return files.length ? { block: "diff", files: /** @type {DiffFile[]} */ (files) } : text();
    }
    case "record": {
      const title = str(o.title, 200);
      if (!title) return text();
      return { block: "record", urn: typeof o.urn === "string" ? o.urn : null, type: str(o.type, 60), title, fields: /** @type {RecordField[]} */ (arr(o.fields).map(normalizeField).filter(Boolean)).slice(0, 24) };
    }
    case "task": {
      const title = str(o.title, 300);
      if (!title) return text();
      const ap = rec(o.approve);
      return {
        block: "task", id: str(o.id, 80), title, doer: typeof o.doer === "string" ? o.doer : null,
        state: ["needs-approval", "open", "done", "declined"].includes(o.state) ? o.state : "open",
        why: typeof o.why === "string" ? o.why.slice(0, 400) : null,
        face: ap ? ap.face !== false : false,
        approve: ap && typeof ap.label === "string" ? ap.label.slice(0, 60) : "Approve",
        tags: arr(o.tags).filter((t) => typeof t === "string").slice(0, 6),
      };
    }
    case "draft": {
      const body = str(o.body, 20000);
      return body ? { block: "draft", kind: str(o.kind, 30) || "message", to: typeof o.to === "string" ? o.to : null, subject: typeof o.subject === "string" ? o.subject : null, body } : text();
    }
    case "flow-change": {
      const steps = arr(o.steps).map((s) => rec(s)).filter(Boolean).map((s) => ({ op: ["add", "remove", "change"].includes(s?.op) ? s?.op : "change", label: str(s?.label, 200) }));
      return steps.length ? { block: "flow-change", title: str(o.title, 200) || "Flow change", steps } : text();
    }
    case "answer": {
      const t = str(o.text, 8000);
      return t ? { block: "answer", text: t, sources: arr(o.sources).map((s) => rec(s)).filter(Boolean).map((s) => ({ title: str(s?.title, 200) || "Source", url: typeof s?.url === "string" ? s.url : null })).slice(0, 12) } : text();
    }
    case "screen": {
      const frames = arr(o.frames).filter((f) => typeof f === "string").slice(-4);
      return { block: "screen", label: str(o.label, 120), live: o.live !== false, frames };
    }
    case "text":
      return text();
    default:
      return text();
  }
}

/** A record field with a sealed value keeps its class and presence, never the value or its ref. @param {unknown} raw @returns {RecordField | null} */
function normalizeField(raw) {
  const f = rec(raw);
  if (!f) return null;
  const label = str(f.label ?? f.name, 80);
  if (!label) return null;
  const v = rec(f.value);
  if (f.kind === "sealed" || f.sealed === true || (v && typeof v.sealed === "string")) {
    const cls = (v && typeof v.sealed === "string" && v.sealed) || (typeof f.sealed === "string" ? f.sealed : "") || label;
    const present = v && typeof v.present === "boolean" ? v.present : f.present !== false;
    return { label, kind: "sealed", sealed: true, cls: String(cls).slice(0, 60), present };
  }
  const value = typeof f.value === "string" ? f.value : typeof f.value === "number" || typeof f.value === "boolean" ? String(f.value) : v && typeof v.amount === "number" ? `${v.currency ?? ""} ${v.amount}`.trim() : "";
  return { label, kind: str(f.kind, 20) || "text", value: value.slice(0, 300) };
}

/** True when a record's field list has a sealed field. @param {{ fields?: { sealed?: boolean }[] } | null | undefined} r */
export const sealedCount = (r) => (r && Array.isArray(r.fields) ? r.fields.filter((f) => f.sealed).length : 0);

/** @typedef {{ t: "add" | "del" | "ctx" | "hunk", text: string }} DiffLine */

/** A unified diff as lines; file headers are dropped. @param {string} diff @returns {DiffLine[]} */
export function parseUnified(diff) {
  /** @type {DiffLine[]} */ const out = [];
  for (const line of String(diff).split("\n")) {
    if (/^(diff --git|index |--- |\+\+\+ )/.test(line)) continue;
    if (line.startsWith("@@")) out.push({ t: "hunk", text: line });
    else if (line.startsWith("+")) out.push({ t: "add", text: line.slice(1) });
    else if (line.startsWith("-")) out.push({ t: "del", text: line.slice(1) });
    else if (line.length || out.length) out.push({ t: "ctx", text: line.startsWith(" ") ? line.slice(1) : line });
  }
  while (out.length && out[out.length - 1].t === "ctx" && out[out.length - 1].text === "") out.pop();
  return out;
}

/** @param {string} diff */
export function countDiff(diff) {
  let add = 0, del = 0;
  for (const l of parseUnified(diff)) { if (l.t === "add") add++; else if (l.t === "del") del++; }
  return { add, del };
}

/** Side by side: deletions and additions of one hunk paired in order. @param {DiffLine[]} lines @returns {{ left: DiffLine | null, right: DiffLine | null }[]} */
export function sideBySide(lines) {
  /** @type {{ left: DiffLine | null, right: DiffLine | null }[]} */ const out = [];
  for (let i = 0; i < lines.length; ) {
    const l = lines[i];
    if (l.t === "ctx" || l.t === "hunk") { out.push({ left: l, right: l }); i++; continue; }
    const dels = [], adds = [];
    while (i < lines.length && lines[i].t === "del") dels.push(lines[i++]);
    while (i < lines.length && lines[i].t === "add") adds.push(lines[i++]);
    for (let k = 0; k < Math.max(dels.length, adds.length); k++) out.push({ left: dels[k] ?? null, right: adds[k] ?? null });
  }
  return out;
}

/** Many files fold into a tree summary (a folder, its files with counts). @param {DiffFile[]} files */
export function fileTree(files) {
  /** @type {Map<string, DiffFile[]>} */ const by = new Map();
  for (const f of files) {
    const i = f.path.lastIndexOf("/");
    const dir = i < 0 ? "." : f.path.slice(0, i);
    (by.get(dir) ?? by.set(dir, []).get(dir))?.push(f);
  }
  return [...by.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([dir, list]) => ({ dir, files: list.map((f) => ({ name: f.path.slice(dir === "." ? 0 : dir.length + 1), op: f.op, add: f.add, del: f.del })) }));
}

/** More than this many files show as a tree summary first. */
export const TREE_AT = 3;
