// @ts-check
// targets: what a call to watchers.create or watchers.preset acts on, as the keys lib/said/watchers.js
// records from the person's own words. The registry asks these (reach "asked", `target`) so the person's
// "turn it on" binds to exactly the code the card showed, and a model's call for anything else is refused.
//   watchers.create:<project>/<name>@<hash>
//   watchers.preset:<project>/<kind>

import * as folder from "./folder.js";

/**
 * @param {{ input?: any }} call the asked call: { tool, input }
 * @param {{ read?: (name: string) => { spec: { project: string } | null, hash: string | null, problems: string[] } }} deps
 * @returns {{ to: string[] }} empty when the call cannot be tied to what the person saw
 */
export function createTarget(call, { read }) {
  const input = (call && call.input) || {};
  const name = String(input.name || "");
  if (!folder.NAME.test(name) || !read) return { to: [] };
  const f = read(name);
  if (!f.spec || !f.hash || f.problems.length) return { to: [] };
  // The call must carry the hash of the code the person saw; a folder changed since is not what they agreed to.
  if (typeof input.hash !== "string" || input.hash !== f.hash) return { to: [] };
  return { to: [`watchers.create:${f.spec.project}/${name}@${f.hash}`] };
}

/** @param {{ input?: any }} call */
export function presetTarget(call) {
  const input = (call && call.input) || {};
  const project = String(input.project || ""), kind = String(input.kind || "");
  if (!project || !/^(mail|calendar|repo|slack|feed)$/.test(kind)) return { to: [] };
  return { to: [`watchers.preset:${project}/${kind}`] };
}
