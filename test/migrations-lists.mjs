// The migration lists of every module, from a real daemon in each role, as { module: [sha256 of each step's SQL] }. Shared by the recorder and the hygiene test.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { start } from "../core/daemon/index.js";
import { MIGRATION_LISTS } from "../core/store/index.js";
import { tempHome } from "./helpers.js";

/** @param {any} [t] a test context (for tempHome cleanup) */
export async function migrationHashes(t) {
  const lists = {};
  for (const role of ["box", "local"]) {
    const root = t ? tempHome(t) : fs.mkdtempSync(path.join(process.env.TMPDIR || "/tmp", "vyre-mig-"));
    fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ role, transcripts: [], name: "migrations" }));
    const d = await start({ root, log: () => {} });
    try {
      for (const [m, steps] of MIGRATION_LISTS) lists[m] = steps.map(sql => crypto.createHash("sha256").update(String(sql)).digest("hex").slice(0, 16));
    } finally { await d.stop(); if (!t) fs.rmSync(root, { recursive: true, force: true }); }
  }
  return Object.fromEntries(Object.entries(lists).sort(([a], [b]) => a.localeCompare(b)));
}
