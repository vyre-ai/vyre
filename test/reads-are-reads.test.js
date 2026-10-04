// @ts-check
// reviewer-2's "reads are reads" invariant (RG-3): every tool that declares `effect: "read"` (manifest entry, does.reads or ctx.tool def) is called as the person with an empty input in a
// throwaway home, and must write nothing: no event emitted, no row changed in the daemon's database, no call to a tool that declares `effect: "write"`. A tool that needs input fails on its own
// check before it writes, which proves nothing either way, so this is a floor and not a proof: it catches a read that writes on its first call (a lazy migration, a seen marker, an index kick).
// A tool that must write on a read declares `effect: "write"` and says who may call it. KNOWN_WRITERS is today's exceptions and only shrinks. A test box, never a Mac.
import { test } from "node:test";
import assert from "node:assert/strict";
import { tempHome } from "./helpers.js";
import { start } from "../core/daemon/index.js";
import fs from "node:fs";
import path from "node:path";

/** Reads that write today, by name, each to be redeclared `write` (with callers) or fixed by its owner. Never add one. */
const KNOWN_WRITERS = new Set([
  "appearance.resolve", "settings.get", "settings.snapshot", // three existing settings rows change on every call (settings)
  "vault.health", // appends to vault_audit (vault)
]);

test("a tool declared effect read changes no state when called with no input", { timeout: 280_000 }, async t => {
  const root = tempHome(t);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ role: "box", name: "reads", transcripts: [], vault: { keystore: "file" } }));
  const d = await start({ root, log: () => {} });
  t.after(() => d.stop());
  const reg = d.registry;
  const db = reg.deps.db;
  const changes = () => /** @type {any} */ (db.prepare("SELECT total_changes() AS n").get()).n;
  /** @type {string[]} */
  const writeCalls = [];
  const real = reg.call.bind(reg);
  reg.call = (tool, input, caller, meta) => { const def = reg.tools.get(tool); if (def && def.effect === "write" && !def.internal && String(caller).startsWith("module:")) writeCalls.push(tool); return real(tool, input, caller, meta); };
  const tables = () => { /** @type {Record<string, number>} */ const o = {}; for (const r of /** @type {any[]} */ (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all())) { try { o[r.name] = /** @type {any} */ (db.prepare(`SELECT COUNT(*) AS n FROM "${r.name}"`).get()).n; } catch { /* virtual */ } } return o; };
  const reads = [...reg.tools.entries()].filter(([, def]) => def.effect === "read" && !def.internal && !def.hook).map(([n]) => n).sort();
  assert.ok(reads.length > 200, `${reads.length} read tools`);
  const offenders = [];
  for (const name of reads) {
    if (KNOWN_WRITERS.has(name)) continue;
    // Background jobs write too: a tool is an offender only when three calls in a row each change something.
    /** @type {string[]} */ let why = [];
    for (let attempt = 0; attempt < 3; attempt++) {
      await new Promise(r => setTimeout(r, 5));
      await Promise.race([real(name, {}, "cli", {}), new Promise(r => setTimeout(r, 4000))]).catch(() => null);
      const ev0 = reg.deps.events.latestId(), ch0 = changes(), t0 = tables(); writeCalls.length = 0;
      await Promise.race([real(name, {}, "cli", {}), new Promise(r => setTimeout(r, 4000))]).catch(() => null);
      await new Promise(r => setTimeout(r, 20));
      const ev1 = reg.deps.events.latestId(), ch1 = changes();
      const now = [];
      if (ev1 !== ev0) now.push(`${ev1 - ev0} event(s)`);
      if (ch1 !== ch0) { const t1 = tables(); now.push(`${ch1 - ch0} row change(s) in ${Object.keys(t1).filter(k => t1[k] !== t0[k]).join(", ") || "existing rows"}`); }
      if (writeCalls.length) now.push(`calls write tools ${[...new Set(writeCalls)].join(", ")}`);
      if (!now.length) { why = []; break; }
      why = now;
    }
    if (why.length) offenders.push(`${name}: ${why.join("; ")}`);
  }
  console.log(`reads-are-reads: ${reads.length} read tools, ${offenders.length} wrote`);
  assert.deepEqual(offenders, [], "a tool that writes declares effect write and says who may call it");
});
