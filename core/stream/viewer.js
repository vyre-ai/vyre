// @ts-check
// viewer: one shared frame, drawn per viewer (ADR 0052, group chats).
//
// A record, draft or answer block carries `fields`. A field the viewer cannot read (sealed for
// everyone in chat, or hidden by role) becomes a typed placeholder for THAT viewer. The shared frame
// is never mutated: render() returns a copy, and the original object is what every other viewer
// is drawn from. assertAskerCanRead() is the guard where an assistant reply is built: a reply never
// carries what the person who asked could not read.
//
// Field shapes follow kernel/contracts/fields.d.ts: a sealed field is `kind: "sealed"` or a value
// `{ sealed: <class>, ref, present, valid_format }` (SealedRefValue); `seal.reveal_roles` names who may
// reveal it on their own screen (never in chat). A field may carry `read_roles`: roles that may read it.
// A viewer is { id, roles }.
//
// Placeholders (typed, never a value or a ref):
//   sealed: { sealed: <class>, present, valid_format, can_reveal }   can_reveal: this viewer holds a reveal role
//   hidden: { hidden: "role", kind, present }

import { kindOf } from "./frame.js";

/** Block kinds whose `fields` are drawn per viewer. */
export const FIELD_BLOCKS = Object.freeze(["record", "draft", "answer"]);

/** @typedef {{ id?: string, roles?: readonly string[] }} Viewer */

const isObj = (/** @type {unknown} */ v) => !!v && typeof v === "object" && !Array.isArray(v);

/** True when the field holds a sealed value (or the slot for one). @param {any} f */
export function isSealed(f) {
  if (!isObj(f)) return false;
  return f.kind === "sealed" || f.sealed === true || typeof f.sealed === "string" || (isObj(f.value) && typeof f.value.sealed === "string");
}

/** True when f is already a placeholder: no value and no ref to carry. @param {any} f */
export function isPlaceholder(f) {
  if (!isObj(f) || f.placeholder !== true) return false;
  const v = f.value;
  if (v === undefined || v === null) return true;
  if (!isObj(v)) return false;
  if ("ref" in v || "hint" in v) return false;
  return (typeof v.sealed === "string" || v.hidden === "role") && Object.keys(v).every(k => ["sealed", "hidden", "present", "valid_format", "can_reveal", "kind"].includes(k));
}

/** @param {any} f @param {Viewer} viewer */
const hasRole = (f, viewer) => {
  const roles = Array.isArray(f.read_roles) ? f.read_roles : null;
  if (!roles || roles.length === 0) return true;
  const mine = viewer && Array.isArray(viewer.roles) ? viewer.roles : [];
  return roles.some((/** @type {string} */ r) => mine.includes(r));
};

/** Can this viewer read the field's value in a chat? A sealed value is read by no one here. @param {any} f @param {Viewer} viewer */
export function canRead(f, viewer) {
  if (isSealed(f)) return false;
  return hasRole(f, viewer);
}

/** @param {any} f */
const presentOf = f => (isObj(f.value) && typeof f.value.present === "boolean" ? f.value.present : typeof f.present === "boolean" ? f.present : f.value !== null && f.value !== undefined && f.value !== "");

/** The typed placeholder for a field this viewer cannot read. @param {any} f @param {Viewer} viewer */
export function placeholder(f, viewer) {
  const base = { ...(f.name !== undefined ? { name: f.name } : {}), ...(f.label !== undefined ? { label: f.label } : {}) };
  if (isSealed(f)) {
    const v = isObj(f.value) ? f.value : {};
    const cls = (typeof v.sealed === "string" && v.sealed) || (typeof f.sealed === "string" && f.sealed) || f.seal?.class || String(f.label ?? f.name ?? "sealed");
    const reveal = Array.isArray(f.seal?.reveal_roles) ? f.seal.reveal_roles : [];
    const mine = viewer && Array.isArray(viewer.roles) ? viewer.roles : [];
    return { ...base, kind: "sealed", sealed: true, placeholder: true, value: { sealed: cls, present: presentOf(f), valid_format: typeof v.valid_format === "boolean" ? v.valid_format : true, can_reveal: reveal.some((/** @type {string} */ r) => mine.includes(r)) } };
  }
  return { ...base, kind: f.kind ?? "text", placeholder: true, value: { hidden: "role", kind: f.kind ?? "text", present: presentOf(f) } };
}

/** @param {any} f @param {Viewer} viewer */
const drawField = (f, viewer) => (!isObj(f) || isPlaceholder(f) || canRead(f, viewer) ? f : placeholder(f, viewer));

/** @param {any} b @param {Viewer} viewer */
function drawBlock(b, viewer) {
  if (!isObj(b) || !FIELD_BLOCKS.includes(b.block) || !Array.isArray(b.fields)) return b;
  let changed = false;
  const fields = b.fields.map((/** @type {any} */ f) => { const d = drawField(f, viewer); if (d !== f) changed = true; return d; });
  return changed ? { ...b, fields } : b;
}

/** The blocks a frame carries: a tool-finished result, an answer, or data that is itself a block. @param {any} f */
function blocksOf(f) {
  const d = f && f.data;
  if (!isObj(d)) return [];
  /** @type {any[]} */ const out = [];
  if (isObj(d.result)) out.push(["result", d.result]);
  if (isObj(d.block) && typeof d.block === "object") out.push(["block", d.block]);
  else if (typeof d.block === "string") out.push([null, d]);
  if (Array.isArray(d.blocks)) d.blocks.forEach((/** @type {any} */ b, /** @type {number} */ i) => out.push([i, b]));
  return out;
}

/**
 * The frame as `viewer` sees it. Returns the SAME object when nothing needed replacing, else a copy;
 * the shared frame is never mutated.
 * @param {any} frame @param {Viewer} viewer
 */
export function render(frame, viewer) {
  if (!isObj(frame) || !isObj(frame.data)) return frame;
  const d = frame.data;
  let data = d;
  const swap = (/** @type {string} */ k, /** @type {any} */ v) => { if (data === d) data = { ...d }; data[k] = v; };
  if (isObj(d.result)) { const r = drawBlock(d.result, viewer); if (r !== d.result) swap("result", r); }
  if (isObj(d.block)) { const r = drawBlock(d.block, viewer); if (r !== d.block) swap("block", r); }
  if (Array.isArray(d.blocks)) {
    let ch = false;
    const bs = d.blocks.map((/** @type {any} */ b) => { const r = drawBlock(b, viewer); if (r !== b) ch = true; return r; });
    if (ch) swap("blocks", bs);
  }
  if (typeof d.block === "string" && Array.isArray(d.fields)) {
    const r = drawBlock(d, viewer);
    if (r !== d) data = r;
  }
  return data === d ? frame : { ...frame, data };
}

/**
 * Throw when the frame holds a field the asker cannot read, with its value or ref in it. A reply is
 * built under the asker's authority (acts_for): call this where it is built.
 * @param {any} frame @param {Viewer} asker
 */
export function assertAskerCanRead(frame, asker) {
  /** @type {string[]} */ const bad = [];
  const check = (/** @type {any} */ b) => {
    if (!isObj(b) || !FIELD_BLOCKS.includes(b.block) || !Array.isArray(b.fields)) return;
    for (const f of b.fields) if (isObj(f) && !isPlaceholder(f) && !canRead(f, asker)) bad.push(String(f.label ?? f.name ?? "field"));
  };
  const d = frame && frame.data;
  if (isObj(d)) {
    check(d.result); check(d.block); check(d);
    if (Array.isArray(d.blocks)) d.blocks.forEach(check);
  }
  if (bad.length) {
    const e = /** @type {any} */ (new Error(`the reply holds fields the asker cannot read: ${bad.join(", ")}`));
    e.code = "asker-cannot-read";
    e.fields = bad;
    throw e;
  }
}

/**
 * The note a `text-cut` frame carries, and the data for it (door.stream saw a sealed value about to be shown).
 * @param {string} message
 */
export const cutData = message => ({ message, note: "stopped: a sealed value was about to be shown" });

export { kindOf };
