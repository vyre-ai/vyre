// @ts-check
// The Space's profile photos that no profile names any more (records/core-types.js MEMBER_PHOTO): a photo replaced or taken away whose old record the app could not wipe or remove, or one made
// for a profile save that never finished. This removes them, under the records module's own service chain, which the kernel lets remove a member-photo and nothing else of a profile
// (kernel/gateway/ownership.js). It runs a little after start and then every six hours. A photo made in the last hour is left, so a save that is still on its way keeps its picture.

const HOUR = 3_600_000;
export const SWEEP = Object.freeze({ firstMs: 120_000, everyMs: 6 * HOUR, graceMs: HOUR });

/** Every row of a type, page by page. @param {any} k @param {any} chain @param {string} type */
async function all(k, chain, type) {
  const out = [];
  let cursor;
  for (let i = 0; i < 100; i++) {
    const r = await k.records.query(chain, type, { page: { limit: 200, ...(cursor ? { cursor } : {}) } });
    out.push(...(r && Array.isArray(r.rows) ? r.rows : []));
    cursor = r && r.next_cursor;
    if (!cursor) break;
  }
  return out;
}

/** When a row was made, in ms (its created_at, else updated_at), or 0. @param {any} r */
const madeAt = (r) => { const t = Date.parse(String(r && (r.created_at || r.updated_at) || "")); return Number.isFinite(t) ? t : Number(r && (r.created_at || r.updated_at)) || 0; };

/**
 * Remove the photos no profile names. What it does is said back: how many it looked at and removed, and why any could not go.
 * @param {{ records: any, serviceChain: () => any }} k the records module's kernel handle @param {{ now?: number, graceMs?: number }} [o]
 * @returns {Promise<{ photos: number, removed: string[], failed: { id: string, why: string }[] }>}
 */
export async function sweepPhotos(k, o = {}) {
  const chain = k.serviceChain(), now = o.now ?? Date.now(), grace = o.graceMs ?? SWEEP.graceMs;
  const named = new Set((await all(k, chain, "member-profile")).map((r) => r && r.data && r.data.photo).filter((x) => typeof x === "string" && x));
  const photos = await all(k, chain, "member-photo");
  /** @type {string[]} */ const removed = [];
  /** @type {{ id: string, why: string }[]} */ const failed = [];
  for (const r of photos) {
    if (!r || named.has(r.id) || now - madeAt(r) < grace) continue;
    try { await k.records.remove(chain, "member-photo", r.id, r.version); removed.push(r.id); }
    catch (e) { failed.push({ id: String(r.id), why: String((e && /** @type {any} */ (e).message) || e) }); }
  }
  return { photos: photos.length, removed, failed };
}

/**
 * The sweep on a timer: a little after start, then every six hours, never two at once. A Space whose photo type is not there yet (an older store) is skipped quietly until it is.
 * @param {{ records: any, serviceChain: () => any }} k @param {(line: string) => void} log @param {{ firstMs?: number, everyMs?: number }} [o]
 */
export function startPhotoSweep(k, log, o = {}) {
  let busy = false, stopped = false;
  const run = async () => {
    if (busy || stopped) return null;
    busy = true;
    try {
      const r = await sweepPhotos(k);
      if (r.removed.length) log(`profile photos: removed ${r.removed.length} that no profile names`);
      if (r.failed.length) log(`profile photos: ${r.failed.length} could not be removed (${r.failed[0].why}); the next sweep tries again`);
      return r;
    } catch (e) {
      if (!/not_found|unknown type|no such type/i.test(String(e && /** @type {any} */ (e).message))) log(`profile photos: the sweep did not run (${String(e && /** @type {any} */ (e).message || e)}); it runs again in six hours`);
      return null;
    } finally { busy = false; }
  };
  const first = setTimeout(() => { void run(); }, o.firstMs ?? SWEEP.firstMs), every = setInterval(() => { void run(); }, o.everyMs ?? SWEEP.everyMs);
  first.unref?.(); every.unref?.();
  return { run, stop: () => { stopped = true; clearTimeout(first); clearInterval(every); } };
}
