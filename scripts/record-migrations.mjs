// Records every module's migration list into test/migrations.released.json: for each module, the SHA-256 of each step's SQL in order. Run it when a release is cut, never otherwise:
// a released step is never moved, edited or removed, and a new step goes at the END (test/migrations-append-only.test.js). `node scripts/record-migrations.mjs`.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { migrationHashes } from "../test/migrations-lists.mjs";

const out = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "test", "migrations.released.json");
const lists = await migrationHashes();
fs.writeFileSync(out, JSON.stringify({ modules: lists }, null, 1) + "\n");
console.log(`recorded ${Object.keys(lists).length} modules, ${Object.values(lists).reduce((n, l) => n + l.length, 0)} steps`);
