// kernel/golden/allow-gen.js: the golden allow file is GENERATED from core/modules/agent-reach.js (OPEN, ASK_FIRST, ANYONE_OPEN), never written by hand. Each entry has its own reason,
// made from what the tool is (its manifest summary, else its module's description) and why it is on the list. `node kernel/golden/allow-gen.js --write` rewrites allow.json;
// kernel/golden/golden.test.js fails when allow.json differs from this output, so a hand-written entry cannot stay.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { OPEN, ASK_FIRST, ANYONE_OPEN } from "../../core/modules/agent-reach.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..", "..");
export const ALLOW_PATH = path.join(here, "allow.json");

/** What each tool is, from the manifests under core, local and modules. @returns {Map<string, string>} */
function whatItIs() {
  /** @type {Map<string, string>} */ const out = new Map();
  for (const top of ["core", "local", "modules"]) {
    const base = path.join(repo, top);
    if (!fs.existsSync(base)) continue;
    for (const d of fs.readdirSync(base).sort()) {
      let m; try { m = JSON.parse(fs.readFileSync(path.join(base, d, "module.json"), "utf8")); } catch { continue; }
      const first = String(m.description || m.name || "").split(/(?<=[.])\s/)[0].replace(/\s+/g, " ").trim();
      for (const t of (m.does && m.does.tools) || []) {
        const name = typeof t === "string" ? t : t.name;
        const own = typeof t === "object" && (t.summary || t.description) ? String(t.summary || t.description).split(/(?<=[.])\s/)[0].replace(/\s+/g, " ").trim() : "";
        if (name && !out.has(name)) out.set(name, own || `a ${m.name} tool (${first})`);
      }
    }
  }
  return out;
}

/** @returns {{ tool: string, reason: string }[]} sorted by tool */
export function generateAllow() {
  const what = whatItIs();
  /** @type {{ tool: string, reason: string }[]} */ const out = [];
  const lead = "user ruling 4 Oct 2026, an assistant can do what its person can";
  for (const t of OPEN) out.push({ tool: t, reason: `${lead}; ${t} is open to the person's assistant (agent-reach.js OPEN): ${what.get(t) || "no manifest summary"}` });
  for (const [t, why] of ASK_FIRST) out.push({ tool: t, reason: `${lead}; ${t} is open but held for a one-tap task (agent-reach.js ASK_FIRST): ${why}` });
  for (const [t, why] of ANYONE_OPEN) out.push({ tool: t, reason: `${lead}; ${t} is declared reach anyone and open to the person's assistant (agent-reach.js ANYONE_OPEN): ${why}` });
  return out.sort((a, b) => (a.tool < b.tool ? -1 : a.tool > b.tool ? 1 : 0));
}

if (process.argv[1] === fileURLToPath(import.meta.url) && process.argv[2] === "--write") {
  fs.writeFileSync(ALLOW_PATH, JSON.stringify(generateAllow(), null, 1) + "\n");
  console.log("wrote", ALLOW_PATH);
}
