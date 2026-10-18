#!/usr/bin/env node
// Pull the official MCP registry and the Claude plugin repos into the committed catalog snapshot (lib/connector-presets/catalog.snapshot.json). The weekly workflow (.github/workflows/mcp-catalog.yml) runs this and opens a pull
// request with the diff, so a person reads every new entry before it can appear in the app. Run by hand the same way:
//   node scripts/mcp-catalog-snapshot.mjs --out lib/connector-presets/catalog.snapshot.json --diff-md /tmp/diff.md --plugins claude-plugins-official=/path/to/checkout@<sha> --plugins knowledge-work-plugins=/path@<sha>
// The snapshot is only rewritten when its entries changed (the date does not count), and a pull that finds under half of the entries it had is refused unless --force names it.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseRegistryPage, parsePlugins, mergeEntries, diffMarkdown } from "../lib/mcp-catalog.js";
import { pullRegistry, readPluginRepo, annotateProbes, REGISTRY } from "../lib/mcp-catalog-pull.js";
import { PLUGIN_LAYOUT } from "../lib/plugin-layout.js";
import { probeServer } from "../lib/mcp-probe.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** @param {string[]} argv */
function args(argv) {
  /** @type {{ out: string, reviewed: string, diffMd: string, registry: string, plugins: { repo: string, dir: string, sha: string }[], force: boolean, today: string }} */
  const o = { out: path.join(ROOT, "lib", "connector-presets", "catalog.snapshot.json"), reviewed: path.join(ROOT, "lib", "mcp-catalog.reviewed.json"), diffMd: "", registry: REGISTRY, plugins: [], force: false, today: new Date().toISOString().slice(0, 10) };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--out") o.out = path.resolve(argv[++i]);
    else if (a === "--reviewed") o.reviewed = path.resolve(argv[++i]);
    else if (a === "--diff-md") o.diffMd = path.resolve(argv[++i]);
    else if (a === "--registry") o.registry = argv[++i];
    else if (a === "--force") o.force = true;
    else if (a === "--plugins") { const m = /^([A-Za-z0-9._-]+)=(.+)@([0-9a-f]{7,40})$/.exec(argv[++i] || ""); if (!m) throw new Error("--plugins takes <repo>=<checkout dir>@<commit sha>"); o.plugins.push({ repo: m[1], dir: path.resolve(m[2]), sha: m[3] }); }
    else throw new Error(`unknown argument ${a}`);
  }
  return o;
}

/** @param {string} url */
async function fetchJson(url) {
  for (let attempt = 0; ; attempt++) {
    try {
      const r = await fetch(url, { headers: { accept: "application/json", "user-agent": "vyre-catalog-snapshot" }, signal: AbortSignal.timeout(30_000) });
      if (!r.ok) throw new Error(`${r.status} from ${new URL(url).host}`);
      return await r.json();
    } catch (e) { if (attempt >= 1) throw e; await new Promise(res => setTimeout(res, 2000)); }
  }
}

/**
 * Build the next snapshot from the pulled pieces. Exported for the test.
 * @param {{ registryPages: any[], plugins: { repo: string, sha: string, found: any[] }[], registry: string, today: string }} p
 */
export function buildSnapshot(p) {
  // The registry lists tens of thousands of servers, most of them nobody's product. A snapshot a person reviews keeps the ones a vendor published on its own domain; the plugin repos' entries are all kept.
  const allRegistry = p.registryPages.flatMap(parseRegistryPage);
  const fromRegistry = allRegistry.filter(e => e.verified);
  const perPlugin = p.plugins.map(x => parsePlugins({ repo: x.repo, sha: x.sha }, x.found));
  return {
    v: 1,
    generated: p.today,
    sources: { registry: { url: p.registry, seen: allRegistry.length, kept: fromRegistry.length }, plugins: p.plugins.map((x, i) => ({ repo: x.repo, sha: x.sha, servers: perPlugin[i].length })) },
    entries: mergeEntries(fromRegistry, ...perPlugin),
  };
}

/**
 * Keep what a person decided across a pull. A previous row with a `verdict` is reviewed: it wins over a new row at the same address (its identity, basis, probe and verdict stay; the sources of both are kept) and
 * stays when nothing lists it any more. A previous row with only a `probe` hands its answer to a new row with the same id and address.
 * @param {any[]} prevEntries @param {any[]} entries @returns {any[]}
 */
export function carryReviewed(prevEntries, entries) {
  const reviewed = prevEntries.filter(e => e && e.verdict);
  const known = new Map(prevEntries.filter(e => e && e.probe && !e.verdict).map(e => [`${e.id}|${e.url}`, e]));
  const probed = entries.map(e => { const k = known.get(`${e.id}|${e.url}`); return k ? { ...e, auth: k.auth, probe: k.probe } : e; });
  return reviewed.length ? mergeEntries(reviewed, probed) : probed;
}

/** @param {any} prev @param {any} next @param {boolean} force @returns {{ write: boolean, why: string }} */
export function decide(prev, next, force) {
  const had = prev && Array.isArray(prev.entries) ? prev.entries : [];
  if (JSON.stringify(had) === JSON.stringify(next.entries)) return { write: false, why: "unchanged" };
  if (!force && had.length >= 20 && next.entries.length < had.length / 2) return { write: false, why: `refused: ${next.entries.length} entries against ${had.length} before looks like a broken pull (--force names it on purpose)` };
  return { write: true, why: "changed" };
}

async function main() {
  const o = args(process.argv.slice(2));
  const prev = (() => { try { return JSON.parse(fs.readFileSync(o.out, "utf8")); } catch { return null; } })();
  const registryPages = await pullRegistry(fetchJson, { base: o.registry });
  const plugins = o.plugins.map(x => ({ repo: x.repo, sha: x.sha, found: readPluginRepo(x.dir, PLUGIN_LAYOUT.manifest) }));
  const next = buildSnapshot({ registryPages, plugins, registry: o.registry, today: o.today });
  // A person's review stands: a row with a verdict stays whole (and stays even if no source lists it now), and a row already probed keeps its answer until a reviewer re-probes it.
  const reviewedFile = (() => { try { return JSON.parse(fs.readFileSync(o.reviewed, "utf8")); } catch { return null; } })();
  const fromFile = reviewedFile && Array.isArray(reviewedFile.entries) ? reviewedFile.entries : [];
  const fileIds = new Set(fromFile.map(e => e.id));
  // the reviewed file is the reviewers' own list: its rows replace the same ids in the committed snapshot
  next.entries = carryReviewed([...(prev && Array.isArray(prev.entries) ? prev.entries : []).filter(e => !fileIds.has(e.id)), ...fromFile], next.entries);
  next.entries = await annotateProbes(next.entries, url => probeServer(url));
  const d = decide(prev, next, o.force);
  if (!d.write) { console.log(`catalog ${d.why}`); if (d.why.startsWith("refused")) process.exit(1); return; }
  fs.mkdirSync(path.dirname(o.out), { recursive: true });
  fs.writeFileSync(o.out, `${JSON.stringify(next, null, 1)}\n`);
  if (o.diffMd) fs.writeFileSync(o.diffMd, diffMarkdown(prev ? prev.entries : [], next.entries));
  console.log(`catalog written: ${next.entries.length} entries`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(e => { console.error(`catalog snapshot failed: ${e.message}`); process.exit(1); });
