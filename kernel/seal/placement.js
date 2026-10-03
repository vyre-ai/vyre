// kernel/seal/placement.js: where sealed data may live, and what a project folder holds instead. The sealing process's folder is private to its
// own user; no agent sandbox, lent machine or project folder mounts it or contains it. A generated document that holds a sealed value is a sealed
// derivative: the project gets a reference file, not the bytes (R5-2a).
import fs from "node:fs";
import path from "node:path";

const inside = (child, parent) => { const r = path.relative(path.resolve(parent), path.resolve(child)); return r === "" || (!r.startsWith("..") && !path.isAbsolute(r)); };

/** The default folder, under the service user's home and never under a project or an account home. */
export const sealDir = vyreHome => path.join(vyreHome, "seal");

/** The sandbox roots that contain the sealing folder or sit inside it. @param {string} dir @param {string[]} sandboxRoots */
export const overlaps = (dir, sandboxRoots) => sandboxRoots.filter(r => inside(dir, r) || inside(r, dir));

/** Refuse a placement where any sandbox root contains the sealing folder (or the reverse), or other users can read it. */
export function assertPlacement(dir, sandboxRoots) {
  for (const r of overlaps(dir, sandboxRoots)) throw new Error(`the sealing folder and ${r} overlap: a sandbox could reach sealed data`);
  const st = fs.statSync(dir);
  if (process.platform !== "win32" && (st.mode & 0o077) !== 0) throw new Error("the sealing folder is readable by other users");
}

/** The file a project folder holds in place of a sealed derivative. It names the output and its slots, never a value. */
export function writeReference(folder, name, { output_ref, sealed_slots }) {
  const f = path.join(folder, `${name.replace(/[^\w.-]/g, "_")}.sealed.json`);
  fs.writeFileSync(f, JSON.stringify({ vyre: "sealed-output", output_ref, slots: sealed_slots, note: "The filled document is sealed. Open it in Vyre to see it." }, null, 2) + "\n", { mode: 0o644 });
  return f;
}
