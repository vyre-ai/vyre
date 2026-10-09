// @ts-check
// lib/receipt: what a tool call leaves behind once its output is gone (R031-00q). A receipt is made when the result arrives (core/switchboard/translate.js) and kept on the thread's tool event;
// it is the only trace of the output that Vyre keeps in the thread's event log, and it never holds output text:
//   out   one word: ok, held, refused or error
//   n     how many items the result listed (a list, or the longest list under one key)
//   size  characters in the result
//   ids   at most three id-shaped strings under id-like keys: { k, v }
// An id is a short string of letters, digits and _ . / : @ - under a key named id, handle, ref, url, path or ending in _id. A sealed placeholder ({{field:...}}) has braces, so it is never an id; a
// string that starts like a credential (lib/credential-shapes.js) never is either. Pure.
import { startsLikeCredential } from "./credential-shapes.js";

const ID_KEY = /^(id|handle|ref|url|path|uuid|task|run|thread|request)$|_id$/;
const ID_VALUE = /^[A-Za-z0-9_./:@-]{1,60}$/;
const REFUSED = /^(denied|presence_required|not_found|no_such_tool|held_unavailable|placeholder_unreadable|person_session_required|not_in_grant|no_dialog)\b/;

/** The result's text: a string, or the text blocks of a content array. @param {any} content */
function textOf(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((/** @type {any} */ b) => (b && typeof b.text === "string" ? b.text : "")).join("");
  return "";
}

/**
 * Up to `max` id-shaped values under id-like keys, anywhere in a value (a few levels down, a few hundred nodes): the one rule for a receipt's ids and for the ids in a call's arguments.
 * @param {any} data @param {number} [max] @returns {{ k: string, v: string }[]}
 */
export function idsOf(data, max = 3) {
  /** @type {{ k: string, v: string }[]} */ const ids = [];
  let seen = 0;
  /** @param {any} v @param {number} depth */
  const walk = (v, depth) => {
    if (ids.length >= max || seen++ > 300 || depth > 4 || v === null || typeof v !== "object") return;
    for (const [k, x] of Object.entries(v)) {
      if (ids.length >= max) return;
      if (typeof x === "string" && ID_KEY.test(k) && ID_VALUE.test(x) && !startsLikeCredential(x) && !ids.some((i) => i.v === x)) ids.push({ k, v: x });
      else if (typeof x === "object") walk(x, depth + 1);
    }
  };
  walk(data, 0);
  return ids;
}

/**
 * What a Vyre tool call asked, without a value: the names of the arguments it passed (the tool's own, or the inner tool's when it went through tools_call or work_call), and the id-shaped
 * values among them (the same filter as a receipt, so a name, an address or a sentence is never kept). For the repeated-work draft (R031-00s): keys say the shape of a call, ids say where one
 * call's result fed the next.
 * @param {string} name @param {any} input @returns {{ keys: string[], ids: { k: string, v: string }[] }}
 */
export function argsOf(name, input) {
  const bare = String(name).replace(/^mcp__.*?__/, "");
  const obj = (/** @type {any} */ v) => (v && typeof v === "object" && !Array.isArray(v) ? v : {});
  const args = bare === "tools_call" ? obj(obj(input).arguments) : bare === "work_call" ? obj(obj(input).input) : bare === "tools_run" ? {} : obj(input);
  return { keys: Object.keys(args).filter((k) => /^[A-Za-z0-9_.-]{1,40}$/.test(k)).slice(0, 12), ids: idsOf(args) };
}

/**
 * @param {any} content a tool_result's content @param {boolean} [isError]
 * @returns {{ out: "ok" | "held" | "refused" | "error", n?: number, size: number, ids?: { k: string, v: string }[] }}
 */
export function receiptOf(content, isError = false) {
  const text = textOf(content);
  const size = text.length;
  if (isError) return { out: REFUSED.test(text.trim()) ? "refused" : "error", size };
  /** @type {any} */ let data = null;
  if (/^\s*[[{]/.test(text) && size <= 400_000) { try { data = JSON.parse(text); } catch { data = null; } }
  /** @type {{ k: string, v: string }[]} */ const ids = [];
  let n;
  let out = /** @type {"ok" | "held" | "refused" | "error"} */ ("ok");
  if (data && typeof data === "object") {
    if (Array.isArray(data)) n = data.length;
    else { const lens = Object.values(data).filter(Array.isArray).map((a) => /** @type {any[]} */ (a).length); if (lens.length) n = Math.max(...lens); }
    // tools_run answers carry their own status; a held answer is held whatever tool made it
    const status = /** @type {any} */ (data).status;
    if (status === "held" || data.state === "held" || (data.held !== undefined && data.held !== null && data.held !== false)) out = "held";
    else if (status === "refused") out = "refused";
    else if (status === "error") out = "error";
    ids.push(...idsOf(data));
  }
  return { out, size, ...(n !== undefined ? { n } : {}), ...(ids.length ? { ids } : {}) };
}
