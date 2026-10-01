#!/usr/bin/env node
// lock-changes: the dependency changes between two package-lock.json files, as a short list (for the release approver's summary).
//   node scripts/lock-changes.mjs <old-lock.json|-> <new-lock.json>     "-" or a missing file means no previous lock
// Reads the lock's `packages` map; prints "+ name@version" (added), "- name@version" (removed) and "~ name old -> new" (changed), sorted, and a
// count line; substitutions are printed first. A new `resolved` or `integrity` for the same version is reported too, since that is how a substituted package looks.
import fs from "node:fs";

/** @param {string} text @returns {Map<string, { version: string, resolved: string, integrity: string }>} */
export function packages(text) {
  const out = new Map();
  if (!text) return out;
  const j = JSON.parse(text);
  for (const [k, v] of Object.entries(j.packages || {})) {
    if (!k) continue;
    const name = k.replace(/^.*node_modules\//, "");
    const at = k.replace(/node_modules\/[^/]+(?:\/[^/]+)?$/, "").length ? k : name;
    out.set(at, { version: String(v.version || ""), resolved: String(v.resolved || ""), integrity: String(v.integrity || "") });
  }
  return out;
}

/** @param {string} oldText @param {string} newText @returns {string[]} */
export function changes(oldText, newText) {
  const a = packages(oldText), b = packages(newText), lines = [];
  const nm = k => k.replace(/^.*node_modules\//, "");
  for (const [k, v] of b) if (!a.has(k)) lines.push(`+ ${nm(k)}@${v.version}`);
  for (const [k, v] of a) if (!b.has(k)) lines.push(`- ${nm(k)}@${v.version}`);
  for (const [k, v] of b) {
    const o = a.get(k);
    if (!o) continue;
    if (o.version !== v.version) lines.push(`~ ${nm(k)} ${o.version} -> ${v.version}`);
    else if (o.integrity !== v.integrity || o.resolved !== v.resolved) lines.push(`~ ${nm(k)}@${v.version}: same version, different ${o.integrity !== v.integrity ? "integrity" : "source"}`);
  }
  // Substitutions (same version, different integrity or source) come first, so a long list that is cut for the approver can never hide them.
  const subst = l => l.includes(": same version, different ");
  const byName = (x, y) => x.slice(2).localeCompare(y.slice(2));
  return [...lines.filter(subst).sort(byName), ...lines.filter(l => !subst(l)).sort(byName)];
}

if (process.argv[1] && process.argv[1].endsWith("lock-changes.mjs")) {
  const [o, n] = process.argv.slice(2);
  const read = f => (!f || f === "-" || !fs.existsSync(f) ? "" : fs.readFileSync(f, "utf8"));
  const lines = changes(read(o), read(n));
  for (const l of lines) console.log(l);
  console.log(lines.length ? `${lines.length} dependency change(s)` : "no dependency changes");
}
