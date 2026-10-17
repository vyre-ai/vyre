// Writes kernel/flows/golden/replay.json: the scrubbed ledger of every safety-net scenario (kernel/flows/safety-net.js). Run it where the tests run (CI), never on a person's Mac; the golden-refresh
// workflow does, and uploads the file to commit with the change that moved it.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SCENARIOS, ledger, runScenario } from "../safety-net.js";

const out = {};
for (const name of Object.keys(SCENARIOS)) { const r = await runScenario(name); out[name] = { ledger: ledger(r.root), runs: r.runs.length, world: JSON.parse(r.fingerprint) }; }
const file = path.join(path.dirname(fileURLToPath(import.meta.url)), "replay.json");
fs.writeFileSync(file, JSON.stringify(Object.fromEntries(Object.keys(out).sort().map(k => [k, out[k]])), null, 2) + "\n");
console.log(`wrote ${Object.keys(out).length} scenarios to ${file}`);
process.exit(0);
