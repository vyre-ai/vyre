// @ts-check
// sitestore: Vyre for Chrome's site knowledge as files, for a person with no Vyre server (team/0.2/chrome-learning-plan.md, section 7).
//
// One JSON record per origin at <dataDir>/sites/<sha256(origin)[0:16]>.json, written atomically. The same pure code as Vyre Memory does the cleaning
// and merging (extension/shared/sk/site-knowledge.js), so a record means the same thing in both and a box can later take these files as a replica
// (memory.site.sync, union by newest verified, tombstones win). Nothing here holds a value: a patch with anything secret-shaped is refused whole.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { sanitize, emptyRecord, mergeRecord, arrivalCard, keyOk, heal, itemId, testNow } from "../extension/shared/sk/site-knowledge.js";

/** @param {{ dataDir: string, now?: () => number }} o */
export function createSiteStore({ dataDir, now: clock = Date.now, env = process.env }) {
  // The store's ONE clock. Under a test flag (NODE_ENV=test or VYRE_CHROME_TEST) VYRE_SITE_TEST_CLOCK may name a file holding an ISO time, so a harness can put misses on different days; never a setting.
  const now = () => { const t = testNow(env, (/** @type {string} */ p) => fs.readFileSync(p, "utf8")); return t ?? clock(); };
  const dir = path.join(dataDir, "sites");
  const fileOf = (/** @type {string} */ key) => path.join(dir, `${crypto.createHash("sha256").update(key).digest("hex").slice(0, 16)}.json`);
  /** @param {string} key @returns {any} */
  const read = key => { try { return JSON.parse(fs.readFileSync(fileOf(key), "utf8")); } catch { return null; } };
  /** @param {any} rec */
  const write = rec => {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const f = fileOf(rec.key), tmp = `${f}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(rec), { mode: 0o600 });
    fs.renameSync(tmp, f);
  };
  return {
    /** The arrival card, or not_modified when the caller already has this rev. @param {{ origin: string, since_rev?: number }} i */
    get(i) {
      const key = String(i && i.origin || "");
      if (!keyOk(key)) return { error: { code: "bad_request", message: "not an origin" } };
      const rec = read(key);
      if (!rec) return { data: { origin: null, rev: 0 } };
      if (Number.isInteger(i.since_rev) && /** @type {number} */ (i.since_rev) >= rec.rev) return { data: { not_modified: true, rev: rec.rev } };
      return { data: { origin: arrivalCard(rec, { now: now() }), rev: rec.rev } };
    },
    /** Merge a patch, never replace. @param {{ origin: string, target?: string, patch: any }} i */
    put(i) {
      const key = String(i && i.origin || "");
      if (!keyOk(key)) return { error: { code: "bad_request", message: "not an origin" } };
      const s = sanitize({ ...(i.patch || {}), key });
      if (!s.ok) return { data: { accepted: false, refused: s.refused.map(r => ({ path: r.path, why: r.why })) } };
      const base = read(key) || emptyRecord(key);
      const rec = mergeRecord(base, s.record, { now: now() });
      write(rec);
      return { data: { accepted: true, rev: rec.rev, dropped: s.dropped.length } };
    },
    /** A stored fact worked or did not: its confidence moves (lib heal). @param {{ origin: string, part: string, id: string, outcome: string }} i */
    report(i) {
      const key = String(i && i.origin || "");
      if (!keyOk(key)) return { error: { code: "bad_request", message: "not an origin" } };
      if (!["controls", "api", "frames", "flows"].includes(String(i.part)) || !["ok", "miss"].includes(String(i.outcome))) return { error: { code: "bad_request", message: "bad part or outcome" } };
      const rec = read(key);
      const list = rec && rec[i.part];
      const at = Array.isArray(list) ? list.findIndex((/** @type {any} */ x) => itemId(i.part, x) === String(i.id)) : -1;
      if (at < 0) return { data: { known: false } };
      list[at] = heal(list[at], /** @type {"ok"|"miss"} */ (i.outcome), now());
      rec.rev = (rec.rev || 0) + 1; rec.updated = new Date(now()).toISOString();
      write(rec);
      return { data: { known: true, conf: list[at].conf, misses: list[at].misses || 0, quarantined: !!list[at].qAt } };
    },
    /** What is known, by origin. */
    list() {
      let files = []; try { files = fs.readdirSync(dir).filter(f => f.endsWith(".json")); } catch { /* none yet */ }
      return { data: files.map(f => { try { const r = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")); return { origin: r.key, rev: r.rev, updated: r.updated, controls: r.controls.length, api: r.api.length, flows: r.flows.length, frames: r.frames.length }; } catch { return null; } }).filter(Boolean) };
    },
    /** Forget one origin entirely. @param {{ origin: string }} i */
    forget(i) {
      const key = String(i && i.origin || "");
      if (!keyOk(key)) return { error: { code: "bad_request", message: "not an origin" } };
      try { fs.unlinkSync(fileOf(key)); return { data: { forgotten: true } }; } catch { return { data: { forgotten: false } }; }
    },
    /** The raw record, for tests and for `vyre-chrome` to show what it knows. @param {string} key */
    record: read,
  };
}
