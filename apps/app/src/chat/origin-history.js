// @ts-check
// "Earlier in the original": what a forked thread was cut from. One read of the origin's frames, folded here (not into the thread's own store, so no sequence numbers mix), up to the reply the fork was made at.
// A private message is opened with the origin's key ring this device already holds; a device without it shows no history, only the banner.
import { kindOf } from "./frame-type.js";
import { decryptUserMessage } from "./private-text.js";

/** @typedef {{ id: string, role: "user" | "agent", text: string, enc?: { alg?: string, kid?: string, ct?: string } }} OriginRow */

/**
 * The rows of the origin up to and including the finished reply `upto`.
 * @param {readonly any[]} frames stream.read frames in order @param {string} upto the id of the reply the fork was made at
 * @returns {{ found: boolean, rows: OriginRow[] }}
 */
export function originRows(frames, upto) {
  /** @type {OriginRow[]} */ const rows = [];
  const at = new Map(/** @type {[string, OriginRow][]} */ ([]));
  for (const f of frames) {
    const kind = kindOf(f && f.type), d = (f && f.data) || {};
    const id = String(f.message ?? d.message ?? "");
    if (kind === "user-message") {
      if (d.state === "queued" || d.state === "cancelled" || !id || at.has("u:" + id)) continue;
      /** @type {OriginRow} */ const row = { id, role: "user", text: d.enc !== undefined ? "" : String(d.text ?? ""), ...(d.enc !== undefined ? { enc: d.enc } : {}) };
      at.set("u:" + id, row); rows.push(row);
    } else if (kind === "text-delta") {
      if (d.reasoning || d.notice || typeof d.text !== "string" || !id) continue;
      let row = at.get("a:" + id);
      if (!row) { row = { id, role: "agent", text: "" }; at.set("a:" + id, row); rows.push(row); }
      row.text += d.text;
    } else if (kind === "text-done" && id === upto && at.has("a:" + id)) {
      return { found: true, rows };
    }
  }
  return { found: false, rows: [] };
}

/**
 * Open the private messages. Null when any one cannot be opened: half a conversation would mislead.
 * @param {OriginRow[]} rows @param {(kid: string) => Promise<Uint8Array | null>} opener
 * @returns {Promise<OriginRow[] | null>}
 */
export async function openOriginRows(rows, opener) {
  /** @type {OriginRow[]} */ const out = [];
  for (const r of rows) {
    if (!r.enc) { out.push(r); continue; }
    const text = await decryptUserMessage(r.enc, opener);
    if (text === null) return null;
    out.push({ id: r.id, role: r.role, text });
  }
  return out;
}
