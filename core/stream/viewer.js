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
import { within } from "../../lib/within.js";

/** Block kinds whose `fields` are drawn per viewer. */
export const FIELD_BLOCKS = Object.freeze(["record", "draft", "answer"]);

/**
 * A viewer is { id, roles }. `resolve(record, field)` (server side only, never from a client) answers a cited field with the
 * spec the viewer's own authority yields: { label?, kind?, value, read_roles?, seal?, present? }, or null when it cannot be read or does not exist.
 * `may(frame)` (group chats, kernel on) answers "may this viewer receive this frame" from the chat's membership at the frame's stamp (`data.ver`); the stream never decides that itself (group.js asks its reply port).
 * `floor` is the cursor of the viewer's own join: a frame below it is not sent, except who joined and left (quiet, roster only).
 * @typedef {{ id?: string, roles?: readonly string[], resolve?: (record: string, field: string) => Promise<any>, resolveMs?: number, may?: (frame: any) => boolean, floor?: number }} Viewer
 */

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
  const str = (/** @type {unknown} */ x) => (typeof x === "string" ? x.slice(0, 120) : undefined);
  const base = { ...(str(f.name) !== undefined ? { name: str(f.name) } : {}), ...(str(f.label) !== undefined ? { label: str(f.label) } : {}) };
  const kind = str(f.kind) ?? "text";
  if (isSealed(f)) {
    const v = isObj(f.value) ? f.value : {};
    const cls = str(v.sealed) || str(f.sealed) || str(f.seal && f.seal.class) || str(f.label) || str(f.name) || "sealed";
    const reveal = Array.isArray(f.seal?.reveal_roles) ? f.seal.reveal_roles : [];
    const mine = viewer && Array.isArray(viewer.roles) ? viewer.roles : [];
    return { ...base, kind: "sealed", sealed: true, placeholder: true, value: { sealed: cls, present: presentOf(f), valid_format: typeof v.valid_format === "boolean" ? v.valid_format : true, can_reveal: reveal.some((/** @type {string} */ r) => mine.includes(r)) } };
  }
  return { ...base, kind, placeholder: true, value: { hidden: "role", kind, present: presentOf(f) } };
}

/**
 * A field's own `placeholder: true` is never believed (reviewer V-1): a flagged field is rebuilt by placeholder() from a whitelist of
 * keys, so a ref, hint, text, alt or any other key it carries is dropped, exactly like a field the viewer cannot read.
 * @param {any} f @param {Viewer} viewer
 */
const drawField = (f, viewer) => (!isObj(f) || (f.placeholder !== true && canRead(f, viewer)) ? f : placeholder(f, viewer));

/** The chip a cited field becomes when it cannot be read (or resolved): a typed placeholder, never a value. @param {any} b */
const unreadable = b => ({ block: "field", ...placeholder({ label: typeof b.label === "string" ? b.label : typeof b.field === "string" ? b.field : undefined, name: typeof b.field === "string" ? b.field : undefined, kind: "text", present: false }, { roles: [] }) });

/** @param {any} b @param {Viewer} viewer */
function drawBlock(b, viewer) {
  // A cited field the server did not resolve for this viewer is a chip, never a value. A `field` block is one field, drawn like a record's.
  if (isObj(b) && b.block === "field-ref") return unreadable(b);
  if (isObj(b) && b.block === "field") return b.placeholder !== true && canRead(b, viewer) ? b : { block: "field", ...placeholder(b, viewer) };
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

const REF_MAX = 120;
/** How long a viewer's resolver may take for one cited field before the chip is sent instead (reviewer F-1). */
export const RESOLVE_MS = 3000;
/** @param {any} b */
const refOk = b => isObj(b) && b.block === "field-ref" && typeof b.record === "string" && b.record.length > 0 && b.record.length <= 400 && typeof b.field === "string" && b.field.length > 0 && b.field.length <= REF_MAX;

/** Does the frame carry a cited field (a field-ref block)? @param {any} frame */
export function hasRefs(frame) {
  for (const [, b] of blocksOf(frame)) if (isObj(b) && b.block === "field-ref") return true;
  return false;
}

/**
 * Draw every field-ref in the frame for THIS viewer, from their own authority (viewer.resolve): the value as `{ block: "field", label, kind, value }`
 * when they may read it, else the placeholder chip. The shared frame is not mutated. A ref that cannot be resolved, or resolves to nothing, is a chip.
 * @param {any} frame @param {Viewer} viewer
 */
export async function resolveRefs(frame, viewer) {
  if (!hasRefs(frame)) return frame;
  const one = async (/** @type {any} */ b) => {
    if (!isObj(b) || b.block !== "field-ref") return b;
    if (!refOk(b) || !viewer || typeof viewer.resolve !== "function") return unreadable(b);
    // F-1: a resolver that never answers must not stall the frames behind this one: after the deadline the cited field is the chip.
    let spec = null;
    const ms = Number.isFinite(viewer.resolveMs) && /** @type {number} */ (viewer.resolveMs) > 0 ? /** @type {number} */ (viewer.resolveMs) : RESOLVE_MS;
    try { spec = await within(viewer.resolve(b.record, b.field), ms, null); } catch { spec = null; }
    if (!isObj(spec) || spec.placeholder === true) return unreadable(b);
    const f = { ...spec, name: b.field, label: typeof b.label === "string" ? b.label : typeof spec.label === "string" ? spec.label : b.field };
    if (!canRead(f, viewer)) return { block: "field", ...placeholder(f, viewer) };
    return { block: "field", name: String(b.field).slice(0, REF_MAX), label: String(f.label).slice(0, REF_MAX), kind: typeof spec.kind === "string" ? spec.kind.slice(0, 40) : "text", value: spec.value };
  };
  const d = frame.data;
  const data = { ...d };
  if (isObj(d.result)) data.result = await one(d.result);
  if (isObj(d.block)) data.block = await one(d.block);
  if (Array.isArray(d.blocks)) data.blocks = await Promise.all(d.blocks.map(one));
  return { ...frame, data };
}

/** forViewer for a frame that may carry cited fields: they are resolved for the viewer first. A frame the viewer may not see is never resolved. @param {any} frame @param {Viewer} viewer */
export async function forViewerAsync(frame, viewer) {
  if (!viewer || !hasRefs(frame) || !(frame.cur >= 1) || !mayView(frame, viewer) || !mayReceive(frame, viewer)) return forViewer(frame, viewer);
  return forViewer(await resolveRefs(frame, viewer), viewer);
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
 * May this viewer see the frame at all? A block that names `read_roles` (a record the viewer is not cleared for) is
 * not for a viewer who holds none of them. @param {any} frame @param {Viewer} viewer
 */
export function mayView(frame, viewer) {
  const mine = viewer && Array.isArray(viewer.roles) ? viewer.roles : [];
  for (const [, b] of blocksOf(frame)) {
    if (!isObj(b) || !Array.isArray(b.read_roles) || b.read_roles.length === 0) continue;
    if (!b.read_roles.some((/** @type {string} */ r) => mine.includes(r))) return false;
  }
  return true;
}

/** Does the viewer's `may` let this frame through? A frame with no stamp (not a reply) always passes. @param {any} frame @param {Viewer} viewer */
function mayReceive(frame, viewer) {
  if (!viewer || typeof viewer.may !== "function") return true;
  try { return viewer.may(frame) !== false; } catch { return false; }
}

/**
 * A cursor-only placeholder: no author, no text, no block, no message id. It keeps a viewer's cursor gapless over frames they may not have. `span` > 1 covers a run
 * of cursors (cur - span + 1 .. cur) in one frame.
 * @param {string} session @param {number} cur @param {number} span @param {number} time @param {string} [id]
 */
export function hiddenFrame(session, cur, span, time, id) {
  return { v: 1, id: id || `hidden-${session}-${cur}`, cur, ...(span > 1 ? { span } : {}), session, turn: null, type: "chat.hidden", time, corr: null, data: {} };
}

/**
 * The frame a connection is sent: what `viewer` may see. A frame they may not see is replaced by a `hidden` frame that
 * keeps its cursor (so the client's gapless check holds) and carries nothing of it: no author, no text, no block, no
 * ref. Every other frame goes through render(): sealed and hidden fields are placeholders. Control and ephemeral frames
 * (cur 0) hold no record and pass. The server calls this once per connection, before conn.send, for replay and live alike;
 * a client never decides what it may see. @param {any} frame @param {Viewer} viewer
 */
export function forViewer(frame, viewer) {
  if (!viewer || !isObj(frame) || !isObj(frame.data)) return frame;
  if (!(frame.cur >= 1)) return frame;
  if (!mayView(frame, viewer) || !mayReceive(frame, viewer)) return hiddenFrame(frame.session, frame.cur, 1, frame.time, frame.id);
  return render(frame, viewer);
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
