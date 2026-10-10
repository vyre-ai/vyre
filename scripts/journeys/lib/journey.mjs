// @ts-check
// What a journey file exports, and how its steps are named. A journey is one default export:
//   { id: "J1", title, owner, world: "daemon" | "box", store: "records" | "plain", steps(w, J) }
// `w` is the world (lib/world.mjs); `J.step(name, fn, needs?)` runs one step on the shared reporter: one PASS/FAIL/SKIP line, a FAIL naming the team that owns the part that broke (FOUNDATION
// section 11), later steps that need a failed one SKIPped. `owner` on a step overrides the journey's owner for a step that belongs to another team.
/**
 * @param {ReturnType<typeof import("../../lib/proof/run.mjs").createRun>} run
 * @param {{ id: string, owner: string }} j
 */
export function stepper(run, j) {
  const name = (/** @type {string} */ n) => `${j.id} ${n}`;
  return {
    name,
    /**
     * @param {string} n @param {() => Promise<any> | any} fn @param {{ needs?: string[], owner?: string }} [o]
     */
    step(n, fn, o = {}) {
      const owner = o.owner || j.owner;
      return run.step(name(n), async () => {
        try { return await fn(); } catch (e) {
          if (e && /** @type {any} */ (e).skip) throw e;
          const err = /** @type {any} */ (e instanceof Error ? e : new Error(String(e)));
          if (!/\(owner: /.test(err.message)) err.message = `${err.message} (owner: ${owner})`;
          throw err;
        }
      }, { needs: (o.needs || []).map(name) });
    },
  };
}

/**
 * The same reporter for code that takes a `run` (scripts/lib/proof/walk.mjs): every failure it prints names the owning team, like a J.step failure.
 * @param {ReturnType<typeof import("../../lib/proof/run.mjs").createRun>} run @param {string} owner
 */
export function ownedRun(run, owner) {
  return { ...run, step: (/** @type {string} */ n, /** @type {() => any} */ fn, /** @type {any} */ o) => run.step(n, async () => {
    try { return await fn(); } catch (e) {
      if (e && /** @type {any} */ (e).skip) throw e;
      const err = /** @type {any} */ (e instanceof Error ? e : new Error(String(e)));
      if (!/\(owner: /.test(err.message)) err.message = `${err.message} (owner: ${owner})`;
      throw err;
    }
  }, o) };
}
