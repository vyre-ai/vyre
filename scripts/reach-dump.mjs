#!/usr/bin/env node
// Boots a registry (box and local) in a throwaway home and prints every tool's reach and callers as
// JSON: { tool, module, reach, roles: { box?, local? } } where each role has { callers, internal, hook, proof }. Used by test/reach-registry.test.js, which runs
// it in a child process with HOME and the XDG folders inside a temp dir. Never run against a real home.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
const root0 = fs.mkdtempSync(path.join(os.tmpdir(), "reach-dump-"));
process.env.VYRE_NO_DIALOGS = "1";
process.env.HOME = root0; process.env.USERPROFILE = root0;
process.env.XDG_CONFIG_HOME = path.join(root0, ".config"); process.env.XDG_DATA_HOME = path.join(root0, ".local", "share");
const here = path.dirname(new URL(import.meta.url).pathname);
const { start } = await import(path.join(here, "..", "core", "daemon", "index.js"));
const out = {};
for (const role of ["box", "local"]) {
  const root = path.join(root0, role);
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ role, transcripts: [], vault: { keystore: "file" }, modules: { enable: [], disable: [] } }));
  const d = await start({ root, log: () => {} });
  for (const [tool, def] of d.registry.tools) {
    const pres = d.registry.deps && d.registry.deps.presence;
    let proof = null;
    try { proof = pres ? Boolean(pres.required(tool, def, undefined)) : null; } catch { proof = null; }
    const now = { callers: Array.isArray(def.callers) ? def.callers : null, internal: Boolean(def.internal), hook: Boolean(def.hook), proof };
    out[tool] = out[tool] || { tool, module: def.module, reach: def.reach, roles: {} };
    out[tool].roles[role] = now;
  }
  await d.stop();
}
fs.rmSync(root0, { recursive: true, force: true });
process.stdout.write(JSON.stringify(Object.values(out)));
process.exit(0);
