// Record what a real vyred answers for the Skills screens, so gallery ?f=skills-real is shot with real shapes and no box behind it.
//   node scripts/capture-skills-fixtures.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { start } from "../core/daemon/index.js";
import { canonical } from "../kernel/core/canonical.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.env.VYRE_SEAL_DEV = "1";
process.env.VYRE_KERNEL_PATH_RULE = "1";
const used = new Set();
const presence = { check: async (q) => (q.chain && q.proof && q.proof.op === q.op && canonical(q.proof.fields) === canonical(q.fields) && !used.has(q.proof.n) && (used.add(q.proof.n), true) ? null : "wrong_payload") };
const skill = (name, about = "Use when the gallery needs a real skill on the box.") => `---\nname: ${name}\ndescription: ${about}\n---\n\n# ${name}\n\nDo the thing carefully.\n`;

const root = fs.mkdtempSync(path.join(os.tmpdir(), "vyre-skills-fx-"));
const d = await start({ root, log: () => {}, kernel: true, kernelPresence: presence });
const owner = d.kernel.id.owner;
const ownerChain = d.kernel.chains.fromFacts({ kind: "device", device_key_id: "d-o", person: owner, path: "direct", session: "s" });
const meta = async () => ({ token: (await d.kernel.surfaces.open(ownerChain, {})).token });
const cli = async (tool, input = {}) => d.registry.call(tool, input, "cli", await meta());
const out = {};
try {
  const dr = await cli("skills.draft", { name: "house-style", level: "space", body: skill("house-style") });
  await cli("skills.approve", { name: "house-style", level: "space", version: dr.data.version });
  const pd = await cli("skills.draft", { name: "gallery-plugin", level: "space", kind: "plugin", body: JSON.stringify({
    name: "gallery-plugin",
    description: "A small plugin for design pictures: one skill and one MCP server.",
    skills: [{ name: "gallery-hint", body: skill("gallery-hint", "Use when the UI gallery needs a plugin skill.") }],
    mcp: [{ name: "helper", transport: "http", url: "https://mcp.example.com/tools" }],
  }) });
  for (const t of ["skills.browse", "skills.versions", "skills.get", "connectors.connection.list"]) {
    const input = t === "skills.browse" ? { level: "space" }
      : t === "skills.versions" ? { name: "house-style", level: "space" }
        : t === "skills.get" ? { id: "space/house-style" }
          : {};
    const r = await cli(t, input);
    out[t] = r.error ? { error: r.error } : { data: r.data };
  }
  out["skills.draft.plugin"] = pd.error ? { error: pd.error } : { data: pd.data };
} finally { await d.stop(); }
const file = path.join(REPO, "apps/app/screens/skills/real-box.fixture.json");
fs.writeFileSync(file, JSON.stringify(out, null, 1) + "\n");
console.log(`wrote ${path.relative(REPO, file)} (${Object.keys(out).length} answers)`);
