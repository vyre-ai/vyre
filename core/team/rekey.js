// @ts-check
// An upgrade step the SQL migrations cannot make: before the Project record id keyed these tables they held the project's short name in `project`. Each such row is re-keyed to
// the Project record's id (Records says which, through work.project.ref). A row whose project Records does not know is left exactly as it is and named in a log line, never dropped.
// Idempotent: a row that already holds an id is not looked at, so it can run at every start and again when Records was not ready the first time.

import { isProjectRecordId } from "../../lib/project-id.js";

const TABLES = ["team_teammates", "team_requests", "team_duties", "team_project_settings"];

/**
 * @param {{ db: any, refOf: (project: string) => Promise<{ id: string }>, log?: (m: string) => void }} o
 * @returns {Promise<{ rekeyed: number, unknown: string[] }>} unknown: the short names Records could not place (the caller may try again later)
 */
export async function rekeyLegacy({ db, refOf, log = () => {} }) {
  /** @type {Set<string>} */ const names = new Set();
  for (const t of TABLES) {
    for (const r of /** @type {any[]} */ (db.prepare(`SELECT DISTINCT project FROM ${t}`).all())) if (!isProjectRecordId(String(r.project))) names.add(String(r.project));
  }
  let rekeyed = 0;
  /** @type {string[]} */ const unknown = [];
  for (const slug of names) {
    let id = null;
    try { id = (await refOf(slug)).id; } catch { id = null; }
    if (!id || !isProjectRecordId(id)) { unknown.push(slug); continue; }
    for (const t of TABLES) {
      if (t === "team_project_settings") {
        // The id's own row wins when both exist (the setting was changed after the re-key started); otherwise the short name's row moves.
        const has = db.prepare("SELECT 1 FROM team_project_settings WHERE project = ?").get(id);
        if (has) db.prepare("DELETE FROM team_project_settings WHERE project = ?").run(slug);
        else rekeyed += Number(db.prepare("UPDATE team_project_settings SET project = ? WHERE project = ?").run(id, slug).changes);
      } else rekeyed += Number(db.prepare(`UPDATE ${t} SET project = ? WHERE project = ?`).run(id, slug).changes);
    }
  }
  if (unknown.length) log(`team: ${unknown.length} project name(s) in the team tables have no Project record yet and were left as they are: ${unknown.join(", ")}`);
  return { rekeyed, unknown };
}
