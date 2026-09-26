// @ts-check
// verify: did the action do anything?
//
// An accessibility action reporting success means the app accepted the message. It does not
// mean a button was pressed, that the button was the one meant, or that anything changed.
// Pressing a disabled control and pressing a live one produce identical output, so without this
// step every miss is reported as a win and the only way to notice is for the user to look.
//
// The check is blunt on purpose: sign the window before, sign it after, require the signatures to
// differ. Blunt is right here because the alternative, predicting what a click should change, is
// a second model call that can be wrong in the same direction as the first one.

import crypto from "node:crypto";

/** @typedef {import("./snapshot.js").Snapshot} Snapshot */

/**
 * A fingerprint of everything about a window that an action could plausibly move.
 *
 * Frames are deliberately excluded. A window that reflows by a pixel, a cursor blink, a progress
 * bar advancing on its own: all of those change geometry without anything having happened, and
 * including them would make every verification pass regardless of the action. What is included
 * is what an action changes: the title, which controls exist, their names, whether they are
 * enabled, what they contain, and where focus sits.
 * @param {Snapshot} snap
 */
export function signature(snap) {
  const parts = [snap.window || ""];
  for (const c of snap.controls || []) {
    parts.push([c.path, c.role, c.name || "", c.enabled === false ? "0" : "1", c.focused ? "f" : "",
      c.value == null ? "" : String(c.value)].join("\u0001"));
  }
  return crypto.createHash("sha256").update(parts.join("\u0002")).digest("hex").slice(0, 16);
}

/**
 * Did anything happen between these two observations? A reason either way, because "it did not
 * work" and "it worked" are both things the caller has to say out loud to the user.
 * @param {Snapshot} before
 * @param {Snapshot} after
 */
export function changed(before, after) {
  const a = signature(before), b = signature(after);
  if (a !== b) return { ok: true, why: "the window changed", before: a, after: b };
  return { ok: false, why: "nothing on screen changed, so the action did not land", before: a, after: b };
}

/**
 * What specifically moved: for the message to the user, and so a caller does not credit an
 * action whose only effect was something unrelated finishing in the background.
 * @param {Snapshot} before
 * @param {Snapshot} after
 */
export function diff(before, after) {
  /** @param {any} c */
  const key = c => c.path + "\u0001" + c.role;
  const was = new Map((before.controls || []).map(c => [key(c), c]));
  const now = new Map((after.controls || []).map(c => [key(c), c]));
  /** @type {{ appeared: string[], vanished: string[], altered: string[], title: null | { from: string, to: string } }} */
  const out = { appeared: [], vanished: [], altered: [], title: null };
  if ((before.window || "") !== (after.window || "")) out.title = { from: before.window || "", to: after.window || "" };
  for (const [k, c] of now) if (!was.has(k)) out.appeared.push(c.name || c.role);
  for (const [k, c] of was) if (!now.has(k)) out.vanished.push(c.name || c.role);
  for (const [k, c] of now) {
    const p = was.get(k);
    if (!p) continue;
    if (p.enabled !== c.enabled || String(p.value ?? "") !== String(c.value ?? "") || p.name !== c.name || Boolean(p.focused) !== Boolean(c.focused)) {
      out.altered.push(c.name || c.role);
    }
  }
  return out;
}
