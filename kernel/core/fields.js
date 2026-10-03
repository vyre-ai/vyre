// kernel/core/fields.js: `{{field:<urn>#<name>}}`, the placeholder a group chat's session sees in place of a value the whole room may not read. When an assistant puts one in the input of
// an OUTWARD tool (a send, a post), the dispatcher resolves it before the tool runs, from the record under the ASKER's own chain (the person the turn is for, their own grants, not
// the room's common view): the value goes into the action, which is then held for the person's one-tap approval with the resolution recorded so the approver sees what will be sent.
// The model never holds the value. A sealed field is never substituted: it stays a token in the input and is named in `slots`, so the sealing door merges it at the moment of the send
// under the destination rules (vault owns that step). A record or field the asker cannot read refuses the whole action (`placeholder_unreadable`) and nothing goes out.
import { KernelError } from "./errors.js";
import { segments } from "./urn.js";
import { isSealedShape } from "../store/values.js";

const TOKEN = /\{\{field:([^#}\s]+)#([A-Za-z0-9_-]{1,64})\}\}/g;
const MAX_TOKENS = 50;
const MAX_OUT = 256 * 1024;

/** Does a value (any depth) hold a placeholder? @param {any} v */
export function hasPlaceholder(v) {
  if (typeof v === "string") return v.includes("{{field:");
  if (Array.isArray(v)) return v.some(hasPlaceholder);
  if (v && typeof v === "object") return Object.values(v).some(hasPlaceholder);
  return false;
}

/**
 * @param {{ input: any, read: (urn: string) => Promise<any | null> }} o
 *   read: the record under the asker's own chain (null when they cannot read it or it does not exist)
 * @returns {Promise<{ input: any, resolved: { urn: string, field: string }[], slots: { record: string, field: string }[] }>}
 */
export async function resolveFields(o) {
  /** @type {Map<string, any>} */ const records = new Map();
  /** @type {{ urn: string, field: string }[]} */ const resolved = [];
  /** @type {{ record: string, field: string }[]} */ const slots = [];
  let tokens = 0, out = 0;
  const get = async (/** @type {string} */ urn) => {
    if (records.has(urn)) return records.get(urn);
    const s = segments(urn);
    let r = null;
    if (s && s.length === 3) { try { r = await o.read(urn); } catch { r = null; } }
    records.set(urn, r);
    return r;
  };
  const text = async (/** @type {string} */ str) => {
    let res = "", last = 0;
    for (const m of str.matchAll(TOKEN)) {
      if (++tokens > MAX_TOKENS) throw new KernelError("placeholder_unreadable", "too many placeholders in one action");
      const [tok, urn, field] = m;
      const r = await get(urn);
      if (!r || !r.data || !(field in r.data)) throw new KernelError("placeholder_unreadable", "a value this action names is not readable by the person it is for, so nothing was sent");
      const v = r.data[field];
      res += str.slice(last, /** @type {number} */ (m.index));
      if (isSealedShape(v)) { slots.push({ record: urn, field }); res += tok; } else { res += typeof v === "string" ? v : JSON.stringify(v); resolved.push({ urn, field }); }
      last = /** @type {number} */ (m.index) + tok.length;
      out += res.length;
      if (out > MAX_OUT) throw new KernelError("placeholder_unreadable", "that action is too large to resolve");
    }
    return res + str.slice(last);
  };
  const walk = async (/** @type {any} */ v) => {
    if (typeof v === "string") return v.includes("{{field:") ? text(v) : v;
    if (Array.isArray(v)) { const a = []; for (const x of v) a.push(await walk(x)); return a; }
    if (v && typeof v === "object") { const o2 = /** @type {Record<string, any>} */ ({}); for (const [k, x] of Object.entries(v)) o2[k] = await walk(x); return o2; }
    return v;
  };
  const input = await walk(o.input);
  return { input, resolved, slots };
}
