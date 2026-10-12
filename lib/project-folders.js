// @ts-check
// The projects of a box that live under the work folder, and handing all of them to their project groups at once (the spawner's project-group op; team/0.3.4/PROJECT-GROUPS.md). One place, so the
// switchboard (a launch) and the projects module (projects.sync) read the folders the same way.

import path from "node:path";
import { projectGroup } from "../core/spawner/client.js";

export const workRoot = () => path.resolve(process.env.VYRE_WORK || "/work");
export const under = (/** @type {string} */ p, /** @type {string} */ dir) => p === dir || p.startsWith(dir + path.sep);

/**
 * Each project whose folders are under the work folder, with those folders (its home and any workspace inside it). `call` is a module's ctx.call.
 * @param {(tool: string, input: any) => Promise<any>} call @returns {Promise<{ slug: string, folders: string[] }[]>}
 */
export async function mappedProjects(call) {
  const r = await call("projects.list", {}).catch(() => null);
  const all = r && r.data && Array.isArray(r.data.projects) ? r.data.projects : (r && Array.isArray(r.data) ? r.data : []);
  const work = workRoot();
  /** @type {{ slug: string, folders: string[] }[]} */ const out = [];
  for (const p of all) {
    if (!p || typeof p.slug !== "string") continue;
    const folders = [p.home, ...(Array.isArray(p.workspaces) ? p.workspaces.map((/** @type {any} */ w) => (w && w.path) || w) : [])]
      .filter((/** @type {unknown} */ f) => typeof f === "string" && f && path.isAbsolute(f)).map((/** @type {string} */ f) => path.resolve(f)).filter((/** @type {string} */ f) => f !== work && under(f, work));
    if (folders.length) out.push({ slug: p.slug, folders: [...new Set(folders)] });
  }
  return out;
}

/**
 * Every mapped project's folders handed to their groups, one project after another; one that cannot be done does not stop the others, and each is reported.
 * @param {(tool: string, input: any) => Promise<any>} call @param {typeof projectGroup} [ask]
 * @returns {Promise<{ projects: { project: string, folders: number, migrated: number, error?: string }[] }>}
 */
export async function syncAll(call, ask = projectGroup) {
  /** @type {{ project: string, folders: number, migrated: number, error?: string }[]} */ const rows = [];
  for (const p of await mappedProjects(call)) {
    let migrated = 0;
    try { for (const f of p.folders) { const r = await ask(p.slug, f); if (r && r.migrated) migrated++; } rows.push({ project: p.slug, folders: p.folders.length, migrated }); }
    catch (e) { rows.push({ project: p.slug, folders: p.folders.length, migrated, error: String(/** @type {Error} */ (e).message || e).slice(0, 300) }); }
  }
  return { projects: rows };
}
