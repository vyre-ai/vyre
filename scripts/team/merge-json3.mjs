#!/usr/bin/env node
// A git merge driver for the shared JSON lists (test counts, reach and plain-session allowlists,
// allowed dependencies): a three-way merge by key instead of by line, so two teams adding entries
// never conflict. Wired by scripts/team/setup.sh and the merge queue:
//   git config merge.json3.driver "node scripts/team/merge-json3.mjs %O %A %B"
// Rules: objects merge key by key; arrays keep ours, add theirs' new items and drop items theirs
// removed; a scalar changed on one side takes that side; changed differently on both sides is a
// real conflict (exit 1, git keeps ours and marks the file conflicted).
import fs from "node:fs";

const [base, ours, theirs] = process.argv.slice(2);
const read = (/** @type {string} */ f) => { try { const t = fs.readFileSync(f, "utf8"); return t.trim() ? JSON.parse(t) : {}; } catch { return undefined; } };
const B = read(base), O = read(ours), T = read(theirs);
if (O === undefined || T === undefined) process.exit(1);

let conflicts = 0;
const same = (/** @type {any} */ a, /** @type {any} */ b) => JSON.stringify(a) === JSON.stringify(b);
const isObj = (/** @type {any} */ v) => v !== null && typeof v === "object" && !Array.isArray(v);

/** @param {any} b @param {any} o @param {any} t @param {string} at @returns {any} */
function merge(b, o, t, at) {
  if (same(o, t)) return o;
  if (same(b, o)) return t;
  if (same(b, t)) return o;
  if (isObj(o) && isObj(t)) {
    const bb = isObj(b) ? b : {};
    /** @type {Record<string, any>} */ const out = {};
    for (const k of new Set([...Object.keys(o), ...Object.keys(t)])) {
      const inO = k in o, inT = k in t, inB = k in bb;
      if (inO && inT) out[k] = merge(bb[k], o[k], t[k], `${at}.${k}`);
      else if (inO) { if (!(inB && same(bb[k], o[k]))) out[k] = o[k]; }
      else if (inT) { if (!(inB && same(bb[k], t[k]))) out[k] = t[k]; }
    }
    return out;
  }
  if (Array.isArray(o) && Array.isArray(t)) {
    const bs = new Set((Array.isArray(b) ? b : []).map(x => JSON.stringify(x)));
    const ts = new Set(t.map(x => JSON.stringify(x)));
    const os = new Set(o.map(x => JSON.stringify(x)));
    const out = o.filter(x => !(bs.has(JSON.stringify(x)) && !ts.has(JSON.stringify(x))));
    for (const x of t) if (!os.has(JSON.stringify(x)) && !bs.has(JSON.stringify(x))) out.push(x);
    return out;
  }
  conflicts++;
  process.stderr.write(`merge-json3: ${at || "(root)"} changed differently on both sides; kept ours\n`);
  return o;
}

const result = merge(B === undefined ? {} : B, O, T, "");
const raw = fs.readFileSync(ours, "utf8");
const indent = /^\{\n( +)/.exec(raw)?.[1]?.length ?? 2;
fs.writeFileSync(ours, JSON.stringify(result, null, indent) + "\n");
process.exit(conflicts ? 1 : 0);
