// @ts-check
// Vyre's own tips, as shipped in every module.json under teaches.tips: each one passes the
// checker the tips module uses, each docs link lands on a real page and heading, and every surface
// has tips of each kind. Tips waiting on unmerged code sit in docs/work/tips-pending.json.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { checkTips, SURFACES } from "../core/tips/check.js";
import { slugger } from "../scripts/lib/docs/slug.js";

const ROOT = path.resolve(import.meta.dirname, "..");
const manifests = ["core", "local", "modules"].flatMap(d => fs.readdirSync(path.join(ROOT, d), { withFileTypes: true })
  .filter(e => e.isDirectory() && fs.existsSync(path.join(ROOT, d, e.name, "module.json")))
  .map(e => ({ file: `${d}/${e.name}/module.json`, m: JSON.parse(fs.readFileSync(path.join(ROOT, d, e.name, "module.json"), "utf8")) })));
const all = manifests.flatMap(({ file, m }) => {
  const r = checkTips(m.name, m.teaches && m.teaches.tips);
  return r.tips.map(t => ({ ...t, file }));
});

/** Anchors on one docs page, as the build makes them (fenced code skipped). @type {Map<string, Set<string>>} */
const anchors = new Map();
const anchorsOf = (/** @type {string} */ page) => {
  if (anchors.has(page)) return anchors.get(page);
  const file = path.join(ROOT, "docs", page);
  const set = fs.existsSync(file) ? new Set() : null;
  if (set) {
    const next = slugger();
    let fence = false;
    for (const line of fs.readFileSync(file, "utf8").split("\n")) {
      if (/^\s*(```|~~~)/.test(line)) fence = !fence;
      else if (!fence && /^#{1,6}\s/.test(line)) set.add(next(line.replace(/^#{1,6}\s+/, "")));
    }
  }
  anchors.set(page, /** @type {any} */ (set));
  return set;
};

test("tips content: every tip in every manifest passes the tips checker", () => {
  const problems = manifests.flatMap(({ file, m }) => checkTips(m.name, m.teaches && m.teaches.tips).problems.map(p => `${file}: ${p}`));
  assert.deepEqual(problems, []);
  assert.ok(all.length >= 250, `only ${all.length} tips`);
});

test("tips content: ids are unique and texts are not repeated", () => {
  const ids = new Set(), texts = new Map();
  for (const t of all) {
    assert.ok(!ids.has(t.id), `${t.id} twice`);
    ids.add(t.id);
    assert.ok(!texts.has(t.text), `${t.id} repeats ${texts.get(t.text)}`);
    texts.set(t.text, t.id);
  }
});

test("tips content: each docs link lands on a real page and heading", () => {
  const bad = [];
  for (const t of all.filter(x => x.docs)) {
    const [page, hash] = String(t.docs).split("#");
    const set = anchorsOf(page);
    if (!set) bad.push(`${t.id}: no page docs/${page}`);
    else if (hash && !set.has(hash)) bad.push(`${t.id}: no heading #${hash} on ${page}`);
  }
  assert.deepEqual(bad, []);
});

test("tips content: every surface has first-use, power and discovery tips", () => {
  // The status line is one short line Claude Code draws; it carries no tips of its own yet.
  for (const s of SURFACES.filter(x => x !== "statusline")) {
    const mine = all.filter(t => t.surfaces.includes(s));
    for (const lv of ["first-use", "power", "discovery"]) assert.ok(mine.some(t => t.level === lv), `${s} has no ${lv} tip`);
  }
});

test("tips content: examples use only the sample world", () => {
  // An address in a tip (mail or ssh) is the sample world's or example.com's, never someone's real one.
  const ok = /@(example\.com|harlowlegal\.com|northwindbakery\.com|192\.0\.2\.\d+)$/i; // 192.0.2.x is the documentation range
  const leaks = all.filter(t => ((t.text + " " + (t.command || "")).match(/[\w.+-]+@[\w-]+\.[\w.]+/g) || []).some(a => !ok.test(a)));
  assert.deepEqual(leaks.map(t => t.id), []);
});

test("tips content: the tips waiting on unmerged code are well formed", () => {
  const pending = JSON.parse(fs.readFileSync(path.join(ROOT, "docs/work/tips-pending.json"), "utf8"));
  const problems = pending.flatMap((/** @type {any} */ p) => checkTips(p.module, [p.tip]).problems.map(x => `${p.module}: ${x}`));
  assert.deepEqual(problems, []);
});
