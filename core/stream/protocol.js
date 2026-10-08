// @ts-check
// protocol: the one typed frame a session stream carries (ADR 0052, team/archive/work-journals/chat.md "0.3").
//
// A frame is a projection of the kernel EventEnvelope (kernel/contracts/event.d.ts):
//   { v:1, id, cur, session, turn, type: "chat.<kind>", time, corr, data }
// `cur` is the per-session cursor, gapless from 1, assigned by the log (log.js). A frame is not
// hash-chained (deltas are too frequent); toEnvelope() lifts one into a real envelope when it must
// be logged (a finished tool, an ask, a file change, a typed terminal command).
//
// Two control frames are never logged and carry no cursor (cur 0): `reset` (the cursor is older
// than the log holds; read a snapshot, then resume from snapshot.cur) and `heartbeat` (the head
// cursor, so a client that missed a frame notices without waiting for the next one).
//
// A frame the log stored after merging neighbours (history only, never the live fan-out) carries
// `span` (how many cursors it covers, so its first is cur - span + 1) and, in `data.parts`, the
// length of each piece (characters for text-delta, bytes for term-chunk). A client that already
// holds part of the span trims by parts, so nothing is lost or repeated.

import crypto from "node:crypto";
import { redact } from "../../lib/sanitize.js";
import { kindOf, startOf, EPHEMERAL, isEphemeral, HOLDBACK, settle } from "./frame.js";

export const V = 1;

/** Frame kinds that are logged and cursored. */
export const KINDS = Object.freeze([
  "text-delta", "text-done", "tool-started", "tool-progress", "tool-finished", "term-chunk", "term-command",
  "file-changed", "ask", "ask-answered", "user-message", "status",
  // group chat (0.3): who is in it, what people do with a message, and a set of answers to one question
  "participant-joined", "participant-left", "reaction", "pin", "mention", "fanout", "fanout-keep", "text-cut",
  // One Chat: a run step (the tool calls between two of the assistant's messages), summarised once it closes
  "step-summary",
  // A request handed to a teammate (SPEC-0.3.0 11.2, team/0.3/IFACE-activity.md): one row per request, updated by later frames with the same request
  "handoff",
]);
/** Never logged: what the home sends a viewer in place of a frame they may not see (viewer.js forViewer). It keeps the cursor and holds nothing. */
export const STUBS = Object.freeze(["hidden"]);
export { EPHEMERAL, isEphemeral, HOLDBACK, settle };
/** Control kinds: never logged, no cursor. */
export const CONTROL = Object.freeze(["reset", "heartbeat"]);
export const BLOCKS = Object.freeze(["terminal", "diff", "files", "record", "task", "draft", "flow-change", "answer", "screen", "text", "field-ref", "field"]);
export const HANDOFF_STATES = Object.freeze(["queued", "running", "done", "failed", "cancelled"]);
export const STATES = Object.freeze(["starting", "working", "asking", "waiting", "paused", "stopped", "finished", "failed"]);

/** Longest text a block carries; a longer output is cut with a note, never sent whole. */
export const BLOCK_TEXT = 6000;
const TERM_CHUNK_MAX = 64 * 1024;

const isStr = (/** @type {unknown} */ v) => typeof v === "string";
const isInt = (/** @type {unknown} */ v) => Number.isInteger(v) && /** @type {number} */ (v) >= 0;
const isObj = (/** @type {unknown} */ v) => !!v && typeof v === "object" && !Array.isArray(v);
/** An author: "person:<id>", "assistant:<id>" or "model:<id>". */
export const isAuthor = (/** @type {unknown} */ v) => isStr(v) && /^(person|assistant|model):[^\s]{1,200}$/.test(/** @type {string} */ (v));
const idStr = (/** @type {unknown} */ v) => isStr(v) && /** @type {string} */ (v).length > 0 && /** @type {string} */ (v).length <= 256;

/**
 * An opaque encrypted message (private mode, DESIGN-chat "Who can read a chat, and private mode"): the algorithm and key names and
 * the ciphertext, all strings. The home stores and relays it without parsing it, and never holds the plaintext. No crypto here:
 * the shape only. @param {unknown} e
 */
export const validEnc = e => isObj(e) && Object.keys(e).every(k => ["alg", "kid", "ct"].includes(k))
  && isStr(/** @type {any} */ (e).alg) && /** @type {any} */ (e).alg.length > 0 && /** @type {any} */ (e).alg.length <= 64
  && isStr(/** @type {any} */ (e).kid) && /** @type {any} */ (e).kid.length > 0 && /** @type {any} */ (e).kid.length <= 256
  && isStr(/** @type {any} */ (e).ct) && /** @type {any} */ (e).ct.length > 0 && /** @type {any} */ (e).ct.length <= 256 * 1024;

/**
 * Is this frame an opaque encrypted message? Search, memory, export and anything an assistant is given must skip it.
 * @param {any} f
 */
export const isEncrypted = f => Boolean(f && f.data && typeof f.data === "object" && f.data.enc !== undefined);

/** @type {Record<string, (d: any) => string|null>} */
const CHECK = {
  "text-delta": d => (idStr(d.message) && isInt(d.index) && isStr(d.text) && (d.parent === undefined || idStr(d.parent)) ? null : "text-delta needs message, index and text"),
  "text-done": d => (idStr(d.message) && (d.blocks === undefined || (Array.isArray(d.blocks) && d.blocks.length <= 8 && d.blocks.every(validBlock))) ? null : "text-done needs message, and blocks (up to 8, each a block such as field-ref) when it has any"),
  "tool-started": d => (idStr(d.tool_id) && isStr(d.tool) && isStr(d.kind) && isStr(d.summary) ? null : "tool-started needs tool_id, tool, kind and summary"),
  "tool-progress": d => (idStr(d.tool_id) && (d.text === undefined || isStr(d.text)) && (d.pct === undefined || (typeof d.pct === "number" && d.pct >= 0 && d.pct <= 100)) ? null : "tool-progress needs tool_id and text or pct"),
  "tool-finished": d => (idStr(d.tool_id) && typeof d.ok === "boolean" && validBlock(d.result) ? null : "tool-finished needs tool_id, ok and a result block"),
  "term-chunk": d => (idStr(d.term) && isInt(d.offset) && isStr(d.b64) && d.b64.length <= TERM_CHUNK_MAX * 2 ? null : "term-chunk needs term, offset and b64"),
  "term-command": d => (idStr(d.term) && isStr(d.command) ? null : "term-command needs term and command"),
  "file-changed": d => (isStr(d.path) && ["create", "edit", "delete"].includes(d.op) ? null : "file-changed needs path and op create, edit or delete"),
  "ask": d => (idStr(d.ask_id) && ["permission", "question", "approval"].includes(d.kind) ? null : "ask needs ask_id and kind permission, question or approval"),
  "ask-answered": d => (idStr(d.ask_id) ? null : "ask-answered needs ask_id"),
  "user-message": d => (idStr(d.message) && (d.parent === undefined || idStr(d.parent)) && (d.tz === undefined || (isStr(d.tz) && d.tz.length <= 64)) && (d.reply_to === undefined || (idStr(d.reply_to) && isObj(d.quote) && idStr(d.quote.message) && isAuthor(d.quote.author) && isStr(d.quote.text) && d.quote.text.length <= 200)) && ["sent", "queued", "picked-up", "cancelled"].includes(d.state) && (d.enc !== undefined ? d.text === undefined && validEnc(d.enc) : isStr(d.text)) ? null : "user-message needs message and state sent, queued, picked-up or cancelled, and text (or, in private mode, enc { alg, kid, ct } and no text)"),
  "status": d => (STATES.includes(d.state) ? null : `status needs state, one of ${STATES.join(", ")}`),
  "participant-joined": d => (isAuthor(d.who) && (d.role === undefined || isStr(d.role)) ? null : "participant-joined needs who, person:<id>, assistant:<id> or model:<id>"),
  "participant-left": d => (isAuthor(d.who) ? null : "participant-left needs who"),
  "presence": d => (isAuthor(d.who) && ["typing", "doing", "idle"].includes(d.state) && (d.doing === undefined || (isStr(d.doing) && d.doing.length <= 120)) ? null : "presence needs who, state typing, doing or idle, and doing (up to 120 characters) when doing"),
  "reaction": d => (idStr(d.message) && isStr(d.emoji) && d.emoji.length > 0 && d.emoji.length <= 32 && typeof d.on === "boolean" ? null : "reaction needs message, emoji and on (true or false)"),
  "pin": d => (idStr(d.message) && typeof d.on === "boolean" ? null : "pin needs message and on (true or false)"),
  "mention": d => (idStr(d.message) && Array.isArray(d.who) && d.who.length > 0 && d.who.length <= 50 && d.who.every(isAuthor) ? null : "mention needs message and who, a list of authors"),
  "read-marker": d => (isInt(d.upto) ? null : "read-marker needs upto, a cursor"),
  "fanout": d => (idStr(d.group) && idStr(d.message) && Array.isArray(d.members) && d.members.length >= 2 && d.members.length <= 8 && d.members.every((/** @type {any} */ m) => isObj(m) && isAuthor(m.who) && idStr(m.message)) ? null : "fanout needs group, message and members, two or more of { who, message }"),
  "step-summary": d => (idStr(d.step) && isInt(d.count) && isObj(d.kinds) && isStr(d.summary) && d.summary.length <= 200 && typeof d.ok === "boolean" ? null : "step-summary needs step, count, kinds, summary and ok"),
  "handoff": d => (idStr(d.request) && isObj(d.to) && isStr(d.to.agent) && isStr(d.to.role) && HANDOFF_STATES.includes(d.state) && isStr(d.text) && d.text.length <= 300 && (d.thread === undefined || idStr(d.thread)) && (d.result === undefined || (isStr(d.result) && d.result.length <= 600)) ? null : "handoff needs request, to {agent, role}, state queued, running, done, failed or cancelled, and text (up to 300 characters)"),
  "fanout-keep": d => (idStr(d.group) && idStr(d.keep) ? null : "fanout-keep needs group and keep, a message id"),
  "hidden": d => (Object.keys(d).length === 0 ? null : "hidden holds nothing"),
  "text-cut": d => (idStr(d.message) && isStr(d.note) ? null : "text-cut needs message and note"),
  "reset": d => (isStr(d.reason) ? null : "reset needs a reason"),
  "heartbeat": d => (isInt(d.head) ? null : "heartbeat needs head"),
};

/**
 * @param {unknown} b
 * @returns {boolean} true when b is a Block (one of BLOCKS, with its own text-only or typed props)
 */
export function validBlock(b) {
  if (!isObj(b)) return false;
  const o = /** @type {any} */ (b);
  if (!BLOCKS.includes(o.block)) return false;
  switch (o.block) {
    case "text": return isStr(o.text);
    case "terminal": return isStr(o.command) && isStr(o.output);
    case "diff": return isStr(o.path) && Array.isArray(o.hunks);
    case "files": return Array.isArray(o.files);
    case "task": return Array.isArray(o.items);
    // A cited field: which record and which field, never its value (the server draws it per viewer into a `field` block).
    case "field-ref": return isStr(o.record) && o.record.length > 0 && o.record.length <= 400 && isStr(o.field) && o.field.length > 0 && o.field.length <= 120 && Object.keys(o).every(k => ["block", "record", "field", "label"].includes(k)) && (o.label === undefined || isStr(o.label));
    case "field": return isStr(o.label);
    default: return true;
  }
}

/**
 * @param {unknown} f
 * @returns {{ ok: true } | { ok: false, error: string }}
 */
export function validate(f) {
  if (!isObj(f)) return { ok: false, error: "a frame is an object" };
  const o = /** @type {any} */ (f);
  if (o.v !== V) return { ok: false, error: `v must be ${V}` };
  if (!isStr(o.type) || !o.type.startsWith("chat.")) return { ok: false, error: "type must be chat.<kind>" };
  const kind = o.type.slice(5);
  const control = CONTROL.includes(kind) || EPHEMERAL.includes(kind);
  if (!control && !KINDS.includes(kind) && !STUBS.includes(kind)) return { ok: false, error: `unknown kind ${kind}` };
  if (!idStr(o.id)) return { ok: false, error: "id is required" };
  if (!idStr(o.session)) return { ok: false, error: "session is required" };
  if (control ? o.cur !== 0 : !(Number.isInteger(o.cur) && o.cur >= 1)) return { ok: false, error: control ? "a control frame has cur 0" : "cur must be an integer from 1" };
  if (o.span !== undefined && !(Number.isInteger(o.span) && o.span >= 2 && o.span <= o.cur)) return { ok: false, error: "span must be an integer from 2 up to cur" };
  if (o.author !== undefined && !isAuthor(o.author)) return { ok: false, error: "author must be person:<id>, assistant:<id> or model:<id>" };
  if (o.acts_for !== undefined) {
    if (!/^person:[^\s]{1,200}$/.test(String(o.acts_for))) return { ok: false, error: "acts_for must be person:<id>" };
    if (!isStr(o.author) || o.author.startsWith("person:")) return { ok: false, error: "acts_for belongs to an assistant or model frame" };
  }
  if (o.message !== undefined && !idStr(o.message)) return { ok: false, error: "message must be a message id" };
  if (!Number.isFinite(o.time)) return { ok: false, error: "time must be a number" };
  if (!isStr(o.turn) && o.turn !== null) return { ok: false, error: "turn must be a string or null" };
  if (!isObj(o.data)) return { ok: false, error: "data must be an object" };
  const bad = CHECK[kind](o.data);
  if (bad) return { ok: false, error: bad };
  if (o.data.via !== undefined && !idStr(o.data.via)) return { ok: false, error: "via must be a request id" };
  if (o.span !== undefined && !(Array.isArray(o.data.parts) && o.data.parts.length === o.span)) return { ok: false, error: "a spanned frame needs one part per cursor" };
  return { ok: true };
}

// kindOf and startOf live in frame.js (no imports, so the app's bundle can take the client without this file).
export { kindOf, startOf };

/**
 * Build a frame. `cur` is 0 until a log assigns it (control frames keep 0).
 * @param {string} kind one of KINDS or CONTROL
 * @param {any} data
 * @param {{ session: string, turn?: string|null, cur?: number, time?: number, id?: string }} ctx
 */
export function frame(kind, data, ctx) {
  if (!KINDS.includes(kind) && !CONTROL.includes(kind) && !EPHEMERAL.includes(kind)) throw new Error(`unknown frame kind ${kind}`);
  const turn = ctx.turn ?? null;
  return {
    v: V,
    id: ctx.id || crypto.randomUUID(),
    cur: ctx.cur ?? 0,
    session: ctx.session,
    turn,
    type: `chat.${kind}`,
    time: ctx.time ?? Date.now(),
    corr: turn,
    ...(ctx.author ? { author: ctx.author } : {}),
    ...(ctx.acts_for ? { acts_for: ctx.acts_for } : {}),
    ...(ctx.message ? { message: ctx.message } : {}),
    data,
  };
}

/** A control frame the transport sends (never logged). @param {string} session @param {string} reason @param {number} [head] */
export const resetFrame = (session, reason, head) => frame("reset", { reason, ...(head !== undefined ? { head } : {}) }, { session });
/** @param {string} session @param {number} head */
export const heartbeatFrame = (session, head) => frame("heartbeat", { head }, { session });

/**
 * Lift a frame into the kernel EventEnvelope shape, for the few frames that must be logged
 * (tool-finished, ask, ask-answered, file-changed, term-command, user-message). The kernel fills
 * seq, chain, commit, prev and hash when it appends; they are zero or empty here. The subject is
 * the session's urn and corr is the turn.
 * @param {any} f
 * @param {{ space?: string, actor?: string, trust?: string, red?: string, vis?: string }} [ctx]
 */
export function toEnvelope(f, ctx = {}) {
  const space = ctx.space || "local";
  return {
    v: 1,
    id: f.id,
    seq: 0,
    space,
    type: f.type,
    sv: 1,
    time: f.time,
    received_at: f.time,
    actor: ctx.actor || f.author || `agent:session@${space}`,
    // The chain is [asker, assistant]: acts_for is the first hop, the author the second.
    chain: f.acts_for && f.author ? [f.acts_for, f.author] : [],
    via: { session: f.session },
    subject: `urn:vyre:session:${f.session}`,
    ...(f.corr ? { corr: f.corr } : {}),
    trust: ctx.trust || "member",
    source_spaces: [space],
    vis: ctx.vis || "space",
    red: ctx.red || "internal",
    // A private message goes into the kernel log as the fact that it passed, never what it said: no ct, no key name.
    data: isEncrypted(f) ? { message: f.data.message, state: f.data.state, enc: true } : f.data,
    commit: "",
    prev: "",
    hash: "",
  };
}

/** Frames that belong in the kernel log, not only the stream. */
export const LOGGED = Object.freeze(["tool-finished", "ask", "ask-answered", "file-changed", "term-command", "user-message",
  "participant-joined", "participant-left", "reaction", "pin", "mention", "fanout", "fanout-keep"]);

// ---- blocks ------------------------------------------------------------------------------------

/** Redact secrets and cut to n characters, keeping the end when `tail` (a command's last lines matter most). */
function clip(/** @type {unknown} */ v, n = BLOCK_TEXT, tail = false) {
  let s = redact(v == null ? "" : typeof v === "string" ? v : "").text;
  if (s.length > n) s = tail ? `... ${s.length - n} characters earlier\n${s.slice(s.length - n)}` : `${s.slice(0, n)}\n... ${s.length - n} more characters`;
  return s;
}
const one = (/** @type {unknown} */ v, n = 160) => {
  const s = redact(String(v ?? "")).text.replace(/\s+/g, " ").trim();
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
};
const ofPath = (/** @type {any} */ i) => one(i && (i.file_path || i.notebook_path || i.path), 300);
const lines = (/** @type {unknown} */ s) => (typeof s === "string" && s ? s.split("\n") : []);

/** Output a tool returns, as plain text: a string, or the text parts of a content array. Never JSON. @param {unknown} out */
export function outputText(out) {
  if (typeof out === "string") return out;
  if (Array.isArray(out)) return out.map(p => (p && typeof p === "object" && typeof /** @type {any} */ (p).text === "string" ? /** @type {any} */ (p).text : "")).filter(Boolean).join("\n");
  if (out && typeof out === "object" && typeof /** @type {any} */ (out).text === "string") return /** @type {any} */ (out).text;
  return "";
}

/** A short, safe line for any tool: what it did, never its arguments dumped. */
export function summarize(/** @type {string} */ tool, /** @type {any} */ input) {
  const i = input && typeof input === "object" ? input : {};
  if (tool === "Bash") return one(i.command);
  if (["Write", "Edit", "MultiEdit", "Read", "NotebookEdit"].includes(tool)) return `${tool} ${ofPath(i)}`.trim();
  if (tool === "WebFetch") return `fetch ${one(i.url)}`;
  if (tool === "WebSearch") return `search ${one(i.query)}`;
  if (tool === "Glob" || tool === "Grep") return `${tool} ${one(i.pattern)}${i.path ? " in " + one(i.path, 80) : ""}`;
  if (tool === "TodoWrite") return `${Array.isArray(i.todos) ? i.todos.length : 0} todos`;
  if (tool === "Task" || tool === "Agent") return `${tool} ${one(i.description || i.subagent_type)}`;
  const first = Object.entries(i).find(([, v]) => typeof v === "string");
  return one(`${tool}${first ? ` ${first[0]}: ${first[1]}` : ""}`);
}

/** The kind a tool call belongs to, for the row's icon: shell, edit, read, search, todo, web, agent, other. */
export function kindOfTool(/** @type {string} */ tool) {
  if (tool === "Bash") return "shell";
  if (["Edit", "Write", "MultiEdit", "NotebookEdit"].includes(tool)) return "edit";
  if (tool === "Read") return "read";
  if (tool === "Grep" || tool === "Glob") return "search";
  if (tool === "TodoWrite") return "todo";
  if (tool === "WebFetch" || tool === "WebSearch") return "web";
  if (tool === "Task" || tool === "Agent") return "agent";
  return "other";
}

const hunk = (/** @type {unknown} */ del, /** @type {unknown} */ add) => ({ del: clip(del, 2000), add: clip(add, 2000) });

/**
 * What a tool result becomes. Known tools get a typed block; any other tool a short text summary
 * (its words, or what it was asked to do), never raw JSON. All text is redacted and cut.
 * @param {string} tool @param {any} input @param {unknown} output
 * @returns {{ block: string, [k: string]: any }}
 */
export function blockFor(tool, input, output) {
  const i = input && typeof input === "object" ? input : {};
  const out = outputText(output);
  switch (tool) {
    case "Bash": {
      const m = /(?:^|\n)(?:exit(?: code)?|Exit code)[: ]+(\d+)\s*$/i.exec(out);
      return { block: "terminal", command: clip(i.command, 1000), output: clip(out, BLOCK_TEXT, true), ...(m ? { exit: Number(m[1]) } : {}) };
    }
    case "Edit":
      return { block: "diff", path: ofPath(i), hunks: [hunk(i.old_string, i.new_string)] };
    case "Write":
      return { block: "diff", path: ofPath(i), hunks: [hunk("", i.content)], created: true };
    case "MultiEdit":
      return { block: "diff", path: ofPath(i), hunks: (Array.isArray(i.edits) ? i.edits : []).slice(0, 40).map((/** @type {any} */ e) => hunk(e && e.old_string, e && e.new_string)) };
    case "NotebookEdit":
      return { block: "diff", path: ofPath(i), hunks: [hunk("", i.new_source)] };
    case "Read":
      return { block: "files", files: [{ path: ofPath(i) }], note: "read", ...(out ? { text: clip(out, 1200) } : {}) };
    case "Glob": {
      const files = lines(out).map(l => l.trim()).filter(Boolean).slice(0, 200).map(p => ({ path: one(p, 300) }));
      return { block: "files", files, note: `${files.length} found for ${one(i.pattern, 80)}` };
    }
    case "Grep": {
      const rows = lines(out).map(l => l.trim()).filter(Boolean);
      const hits = rows.filter(r => /^[^\s:]+:\d+[:-]/.test(r)).slice(0, 100).map(r => {
        const m = /^([^:]+):(\d+)[:-](.*)$/.exec(r);
        return m ? { path: one(m[1], 300), line: Number(m[2]), text: one(m[3], 200) } : { path: one(r, 300) };
      });
      const files = hits.length ? hits : rows.slice(0, 100).map(r => ({ path: one(r, 300) }));
      return { block: "files", files, note: `${files.length} for ${one(i.pattern, 80)}` };
    }
    case "TodoWrite": {
      const items = (Array.isArray(i.todos) ? i.todos : []).slice(0, 100).map((/** @type {any} */ t) => ({
        text: one(t && (t.content || t.text || t.activeForm), 200), status: t && t.status === "completed" ? "done" : t && t.status === "in_progress" ? "running" : "pending",
      }));
      return { block: "task", items };
    }
    default: {
      const s = out ? one(out, 400) : summarize(tool, i);
      return { block: "text", text: s || tool };
    }
  }
}

/** Split bytes into term-chunk specs at consecutive offsets. @param {string} term @param {number} offset @param {Buffer} bytes @param {number} [max] */
export function termChunks(term, offset, bytes, max = 16 * 1024) {
  const out = [];
  for (let i = 0; i < bytes.length; i += max) {
    const part = bytes.subarray(i, i + max);
    out.push({ kind: "term-chunk", data: { term, offset: offset + i, b64: part.toString("base64") } });
  }
  return out;
}
