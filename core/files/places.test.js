// @ts-check
// files.places: a person's places are the projects and agents the kernel shows THEM; one they cannot read is not listed, a call with no person is refused, and a project that moved away is not a place.
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { placesOf, registerPlaces } from "./places.js";

const SPACE = "spc_abcdefghijkl";
const chainOf = (/** @type {string} */ who) => ({ hops: [{ actor: { kind: "person", id: who, space: SPACE } }] });
const project = (/** @type {string} */ id, /** @type {string} */ name, /** @type {any} */ over = {}) => ({ id: `rec_${id}`, data: { slug: name.toLowerCase().replace(/\W+/g, "-"), name, drive_path: `Projects/${id}`, ...over } });
const agent = (/** @type {string} */ uid, /** @type {string} */ name) => ({ id: `rec_${uid}`, data: { uid, name, folder: `agents/${uid}` } });

/** The kernel's own filter, stood in: each person reads only the rows listed for them. */
function rig(/** @type {Record<string, { project?: any[], agent?: any[] }>} */ visible, { chain = true, levels = /** @type {Record<string, Record<string, string>>} */ ({}) } = {}) {
  /** @type {Map<string, any>} */ const tools = new Map();
  let current = "";
  const ctx = {
    tool: (/** @type {string} */ n, /** @type {any} */ d) => tools.set(n, d), call: async (/** @type {string} */ t, /** @type {any} */ i) => (t === "agents.level" ? { data: { agent: i.agent, level: (levels[current] || {})[i.agent] || "none" } } : {}),
    kernel: { space: SPACE, owner: "per_ana", for: async () => ({ gateway: { records: { query: async (/** @type {any} */ c, /** @type {string} */ type) => ({ rows: ((visible[c.hops[0].actor.id] || {}))[/** @type {"project"} */ (type)] || [] }) } }, surfaces: {} }),
      chainIn: async (/** @type {string} */ _space, /** @type {any} */ meta) => { if (!chain || !meta.who) throw Object.assign(new Error("no person"), { code: "denied" }); return chainOf(meta.who); } },
  };
  registerPlaces(ctx);
  return { run: (/** @type {any} */ i, /** @type {any} */ meta) => { current = meta.who; return tools.get("files.places").run(i, { caller: "deck", ...meta }); }, tool: tools.get("files.places") };
}

test("the places are the person's own, their projects with the Drive folder to open, and their agents with theirs, by name", () => {
  const p = placesOf([project("p2", "Northwind"), project("p1", "Spring launch")], [agent("agt_b", "writer"), agent("agt_a", "ads")], new Map([["writer", "use"], ["ads", "edit"]]));
  assert.deepEqual(p, { mine: { path: "" }, projects: [{ slug: "northwind", name: "Northwind", path: "Projects/p2/files" }, { slug: "spring-launch", name: "Spring launch", path: "Projects/p1/files" }], agents: [{ name: "ads", path: "agents/agt_a" }, { name: "writer", path: "agents/agt_b" }] });
});

test("a project that moved away, one with no Drive folder and a record with a path outside the layout are not places", () => {
  const p = placesOf([project("p1", "Gone", { status: "moved" }), project("p2", "Bare", { drive_path: undefined }), project("p3", "Odd", { drive_path: "../etc" }), project("p4", "Fine")], [{ id: "x", data: { name: "x", folder: "Projects/p9" } }, { id: "y", data: { name: "y" } }], new Map([["x", "use"], ["y", "use"]]));
  assert.deepEqual(p.projects.map((x) => x.name), ["Fine"]);
  assert.deepEqual(p.agents, [], "an agent whose folder is not under agents/ is not listed");
});

test("under each person's own chain: a project or an agent the kernel does not show them is not listed", async () => {
  const r = rig({ per_ana: { project: [project("p1", "Spring launch"), project("p2", "Secret")], agent: [agent("agt_a", "ads"), agent("agt_s", "private-agent")] }, per_ben: { project: [project("p1", "Spring launch")], agent: [agent("agt_a", "ads"), agent("agt_s", "private-agent")] } },
    { levels: { per_ana: { ads: "edit", "private-agent": "edit" }, per_ben: { ads: "use", "private-agent": "none" } } });
  const ana = await r.run({}, { who: "per_ana" }), ben = await r.run({}, { who: "per_ben" });
  assert.deepEqual(ana.projects.map((x) => x.name), ["Secret", "Spring launch"]);
  assert.deepEqual(ben.projects.map((x) => x.name), ["Spring launch"], "Ben is not on Secret");
  assert.deepEqual(ana.agents.map((x) => x.name), ["ads", "private-agent"], "Ana owns both");
  assert.deepEqual(ben.agents.map((x) => x.name), ["ads"], "Ben is on ads only: a readable agent record he has no level on is not listed");
  assert.deepEqual((await r.run({}, { who: "per_cy" })), { mine: { path: "" }, projects: [], agents: [] }, "someone on nothing has only their own");
});

test("a call that proved no person is refused, and the read is open to a model in a chat turn as the member", async () => {
  const r = rig({}, { chain: false });
  assert.ok(await r.run({}, { who: "per_ana" }).then(() => null, (e) => e.code || "refused"), "refused");
  assert.deepEqual(r.tool.callers, ["cli", "local", "deck", "capsule", "mobile", "device", "mcp"]);
});

test("a call that is not a person's own surface lists no agents, whatever the records say", async () => {
  const r = rig({ per_ana: { agent: [agent("agt_a", "ads")] } }, { levels: { per_ana: { ads: "edit" } } });
  const out = await r.run({}, { who: "per_ana", caller: "mcp" });
  assert.deepEqual(out.agents, []);
});
