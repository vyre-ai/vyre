// @ts-check
// verify: did the action do anything?
//
// A click that the browser accepted is not a click that landed. Pressing a disabled control and
// pressing a live one both "succeed" at the protocol level, so without a check every miss is
// reported as a win and the only way to notice is for someone to look at the screen.
//
// The check is blunt on purpose: sign the page before, sign it after, require the signatures to
// differ. Predicting what a click should change would be a second guess that can be wrong in
// the same direction as the first.

import crypto from "node:crypto";

/**
 * A fingerprint of what an action could plausibly move: title, url, which controls exist, their
 * names, whether they are enabled, what they hold and where focus is, plus a hash of the
 * visible text. Geometry is left out: a reflow by a pixel or a spinner turning changes boxes
 * without anything having happened, and would make every verification pass.
 * @param {{ title?: string, url?: string, text?: string, controls?: any[] }} snap
 */
export function signature(snap) {
  const parts = [snap.title || "", snap.url || "", crypto.createHash("sha256").update(snap.text || "").digest("hex")];
  for (const c of snap.controls || []) {
    parts.push([
      c.path, c.role, c.name || "",
      c.enabled === false ? "0" : "1",
      c.focused ? "f" : "",
      c.value == null ? "" : String(c.value),
      // A password's value is never read out, but its length is, so typing into one still
      // counts as a change.
      c.length == null ? "" : String(c.length),
    ].join("\u0001"));
  }
  return crypto.createHash("sha256").update(parts.join("\u0002")).digest("hex").slice(0, 16);
}

/**
 * Did anything happen between these two snapshots? A reason either way, because "it did not
 * land" and "it landed" both have to be said out loud.
 */
export function changed(before, after) {
  const a = signature(before), b = signature(after);
  if (a !== b) return { ok: true, why: "the page changed", before: a, after: b };
  return { ok: false, why: "nothing changed, so the action did not land", before: a, after: b };
}

/** What specifically moved, by control name only: never page text. */
export function diff(before, after) {
  const key = c => c.path + "\u0001" + c.role;
  const was = new Map((before.controls || []).map(c => [key(c), c]));
  const now = new Map((after.controls || []).map(c => [key(c), c]));
  /** @type {{ appeared: string[], vanished: string[], altered: string[], title: null|{from: string, to: string}, url: null|{from: string, to: string}, text: boolean }} */
  const out = { appeared: [], vanished: [], altered: [], title: null, url: null, text: (before.text || "") !== (after.text || "") };
  if ((before.title || "") !== (after.title || "")) out.title = { from: before.title || "", to: after.title || "" };
  if ((before.url || "") !== (after.url || "")) out.url = { from: before.url || "", to: after.url || "" };
  for (const [k, c] of now) if (!was.has(k)) out.appeared.push(c.name || c.role);
  for (const [k, c] of was) if (!now.has(k)) out.vanished.push(c.name || c.role);
  for (const [k, c] of now) {
    const p = was.get(k);
    if (!p) continue;
    if (p.enabled !== c.enabled || String(p.value ?? "") !== String(c.value ?? "") || p.length !== c.length || p.name !== c.name) out.altered.push(c.name || c.role);
  }
  return out;
}
