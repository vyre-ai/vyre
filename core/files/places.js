// @ts-check
// core/files/places.js: where a person's files are, as places for the Files screen: their own, the projects they are on, and the agents they can see. One read, `files.places`, under the CALLER'S own
// chain in the Space it names (lib/gateway-door.js), asking the kernel's records for the `project` and `agent` types: the kernel shows each person only the rows it lets them read, so a project or an agent
// a person has no seat on is not listed, and nothing here decides who may see what. Each place carries the Drive path to open with files.drive.space.list; that call is the kernel's again, so a path that is
// listed but not readable still refuses.
import { createDoor } from "../../lib/gateway-door.js";
import { projectFiles, whereIs } from "../../lib/files/layout.js";
import { personCallOpts } from "../../lib/person-relay.js";

const READ_CALLERS = ["cli", "local", "deck", "capsule", "mobile", "device", "mcp"];

/**
 * The places out of the records the caller may read. A project is listed by its record's Drive folder (`Projects/<id>`), kept out when it moved away or has none; an agent by the folder its record names.
 * An agent is listed only when the caller is "on" it: `levels` (agents.level by name) says edit or use. An agent with no level answered, or none, is left out.
 * @param {readonly any[]} projectRows @param {readonly any[]} agentRows @param {ReadonlyMap<string, string>} [levels]
 * @returns {{ mine: { path: string }, projects: { slug: string, name: string, path: string }[], agents: { name: string, path: string }[] }}
 */
export function placesOf(projectRows, agentRows, levels = new Map()) {
  const projects = [];
  for (const r of projectRows) {
    const d = r && r.data;
    if (!d || typeof d.drive_path !== "string" || d.status === "moved") continue;
    const w = whereIs(d.drive_path);
    if (!w || w.kind !== "project" || !w.id) continue;
    const slug = typeof d.slug === "string" ? d.slug : w.id;
    projects.push({ slug, name: typeof d.name === "string" && d.name ? d.name : slug, path: projectFiles(w.id) });
  }
  const agents = [];
  for (const r of agentRows) {
    const d = r && r.data;
    if (!d || typeof d.folder !== "string" || !d.folder || typeof d.name !== "string") continue;
    const w = whereIs(d.folder);
    if (!w || w.kind !== "agent") continue;
    const level = levels.get(d.name);
    if (level !== "edit" && level !== "use") continue;
    agents.push({ name: d.name, path: d.folder });
  }
  const by = (/** @type {{ name: string }} */ a, /** @type {{ name: string }} */ b) => a.name.localeCompare(b.name);
  return { mine: { path: "" }, projects: projects.sort(by), agents: agents.sort(by) };
}

/** @param {any} ctx */
export function registerPlaces(ctx) {
  const door = createDoor(ctx);
  ctx.tool("files.places", {
    description: "Where your files are: your own, the projects you are on and the agents you own or have been given (each with its Drive folder): { mine, projects: [{ slug, name, path }], agents: [{ name, path }] }. A listed place is not a grant: the Drive decides when you open it (files.drive.space.list).",
    input: { type: "object", properties: { space: { type: "string" } } },
    callers: READ_CALLERS,
    run: async (/** @type {any} */ i, /** @type {any} */ meta) => {
      const d = await door.open(i || {}, meta);
      const rows = async (/** @type {string} */ type) => {
        try { return (await d.gateway.records.query(d.chain, type, { page: { limit: 500 } })).rows || []; }
        catch (e) { const c = /** @type {any} */ (e).code; if (c === "not_found" || c === "unknown_type" || c === "bad_input") return []; throw e; }   // a Space that has no such type has none of them
      };
      const [p, a] = await Promise.all([rows("project"), rows("agent")]);
      // the agents this person is on (agents.level, asked as them): a call that is not a person's own surface has none
      const opts = personCallOpts(String((meta && meta.caller) || ""), meta);
      const levels = new Map();
      if (opts) {
        await Promise.all(a.map(async (/** @type {any} */ r) => {
          const name = r && r.data && typeof r.data.name === "string" ? r.data.name : "";
          if (!name) return;
          try { const x = /** @type {any} */ (await ctx.call("agents.level", { agent: name }, opts)); const v = x && x.data !== undefined ? x.data : x; levels.set(name, v && !v.error ? String(v.level) : "none"); }
          catch { levels.set(name, "none"); }
        }));
      }
      return placesOf(p, a, levels);
    },
  });
}
