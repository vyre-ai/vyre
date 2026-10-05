// @vyre/ui tasks world: one read of the store into the plain data the screens draw (model.js World). No React.
import { aid } from "../../src/vendor/deck/ui/kernel-view.js";
import { viewDefOf } from "../../src/vendor/deck/ui/view-defs.js";

/**
 * @param {import("../../src/vendor/deck/ui/contracts.js").Store} store @param {() => number} [clock]
 * @returns {Promise<import("./model.js").World>}
 */
export async function loadWorld(store, clock = Date.now) {
  const [me, actors, spaces, types, tasks, events, calendar] = await Promise.all([
    store.me ? store.me() : Promise.resolve("alex"), store.actors(), store.spaces(), store.types(), store.tasks({}), store.events({ limit: 60 }),
    store.calendar ? store.calendar() : Promise.resolve([]),
  ]);
  /** @type {Map<string, any>} */
  const records = new Map();
  const urns = [...new Set([...tasks.map((t) => t.record), ...tasks.map((t) => t.template)].filter((u) => !!u))];
  await Promise.all(urns.map(async (u) => { const r = await store.get(/** @type {string} */ (u)); if (r) records.set(/** @type {string} */ (u), r); }));
  void aid;
  return { me, actors, spaces, types: new Map(types.map((t) => [t.name, t])), tasks, events, calendar, records, now: clock() };
}

/** Every record of a type that holds work (Matters, Projects, Trips), with its definition. @param {import("./model.js").World} w @param {import("../../src/vendor/deck/ui/contracts.js").Store} store */
export async function loadWork(w, store) {
  const work = [...w.types.values()].filter((t) => viewDefOf(t).holdsWork);
  const lists = await Promise.all(work.map(async (def) => ({ def, rows: await store.list(def.name) })));
  return lists.flatMap(({ def, rows }) => rows.map((row) => ({ def, row })));
}

/**
 * Everything a project page draws: the world, the record of a type that holds work (found by its id), its type, its events and the records it links to.
 * @param {import("../../src/vendor/deck/ui/contracts.js").Store} store @param {string} id @param {() => number} [clock]
 */
export async function loadProject(store, id, clock = Date.now) {
  const world = await loadWorld(store, clock);
  const found = (await loadWork(world, store)).find((x) => x.row.id === id);
  if (!found) return { world, found: null };
  const { def, row } = found;
  const events = await store.events({ record: row.urn });
  const links = (
    await Promise.all(def.fields.filter((/** @type {any} */ f) => f.kind === "link" || f.kind === "ref").map(async (/** @type {any} */ f) => {
      const urn = row.data?.[f.name]?.urn;
      const r = urn ? await store.get(urn) : null;
      return r ? { field: f.label, rec: r, def: world.types.get(r.type) } : null;
    }))
  ).filter(Boolean);
  for (const l of links) if (l) world.records.set(l.rec.urn, l.rec);
  world.records.set(row.urn, row);
  return { world, found: { def, row, events, links } };
}
