// @ts-check
// update: bring the Space's computers to the image and layout this Vyre expects. A Vyre update changes the image a computer should run (computers.image, set by the release) and sometimes the layout of the
// state volume it keeps (driver/policy.js LAYOUT_VERSION: agent homes, browser profiles and the like). The host's updater pulls the image before vyred restarts; this remakes each computer from it, keeping
// its volumes, and puts the folders the new layout needs into an old volume on the way (the archive PUT in Pool.ensure). It runs by itself when vyred starts, so no box needs a computer remade by hand,
// and the owner can ask for it with computers.update.

/**
 * @param {{ pool: import("./pool.js").Pool, onRemade?: (agent: string) => void, log?: (m: string) => void }} d
 * @param {{ force?: boolean }} [o]
 * @returns {Promise<{ image: string, updated: string[], current: string[], failed: Array<{ agent: string, error: string }> }>}
 */
export async function updateComputers(d, o = {}) {
  const log = d.log || (() => {});
  /** @type {string[]} */ const updated = [], current = [];
  /** @type {Array<{ agent: string, error: string }>} */ const failed = [];
  for (const r of d.pool.rows()) {
    const agent = String(r.agent);
    try {
      const x = await d.pool.update(agent, { force: o.force === true });
      if (x.updated) { updated.push(agent); d.onRemade?.(agent); } else current.push(agent);
    } catch (e) {
      // the container may already be gone: say so, and the next use of the computer makes it from the image
      failed.push({ agent, error: String(/** @type {Error} */ (e).message).slice(0, 200) });
      log(`update ${agent}'s computer: ${/** @type {Error} */ (e).message}`);
    }
  }
  return { image: d.pool.opts.image, updated, current, failed };
}
