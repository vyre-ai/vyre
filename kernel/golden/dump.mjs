#!/usr/bin/env node
// K0: the golden-decision recorder. Boots today's registry (box and local roles) in a throwaway home,
// replaces every tool's body with a sentinel so nothing runs, then asks Registry.call the same question
// for every tool, caller shape and world, and prints what it decided as JSON. The decision code is the
// real code; only what happens after the last gate is stubbed. Never run against a real home.
//
// A cell is one letter: R the tool would have run, otherwise a letter for the refusal code (see legend).
// A row is the cells for one tool in one role, caller-major, world-minor.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CALLERS as GOLDEN_CALLERS, GENERATED_CALLERS, WORLDS } from "./matrix.js";
const CALLERS = process.argv.includes("--generated") ? GENERATED_CALLERS : GOLDEN_CALLERS;

const root0 = fs.mkdtempSync(path.join(os.tmpdir(), "kernel-golden-"));
process.env.VYRE_NO_DIALOGS = "1";
process.env.HOME = root0; process.env.USERPROFILE = root0;
process.env.XDG_CONFIG_HOME = path.join(root0, ".config"); process.env.XDG_DATA_HOME = path.join(root0, ".local", "share");
const here = path.dirname(new URL(import.meta.url).pathname);
const { start } = await import(path.join(here, "..", "..", "core", "daemon", "index.js"));

const SENT = "__would_run__";
const legend = { R: "would run" };
const letters = "abcdefghijklmnopqrstuvwxyz";
const letterOf = code => {
  const have = Object.entries(legend).find(([, v]) => v === code);
  if (have) return have[0];
  const l = letters[Object.keys(legend).length - 1];
  legend[l] = code;
  return l;
};

const out = { v: 1, callers: CALLERS.map(c => c.id), worlds: WORLDS.map(w => w.id), roles: {} };
for (const role of ["box", "local"]) {
  const root = path.join(root0, role);
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ role, transcripts: [], vault: { keystore: "file" }, modules: { enable: [], disable: [] } }));
  const d = await start({ root, log: () => {} });
  const reg = d.registry;
  // --gates: decide the static gates, presence and asked requirements through the kernel retrofit instead of the inline rules.
  if (process.argv.includes("--gates")) { const { createLegacyGates } = await import(path.join(here, "..", "retrofit", "gates.js")); reg.deps.gates = createLegacyGates({ registry: reg }); }
  const world = { proof: false, said: false };
  const realSchemas = new Map();
  // Nothing runs: every body is the sentinel, the said-match door answers from the world, and the
  // presence verifier answers from the world. Required-ness, reach, callers, rules stay the real ones.
  for (const [tool, def] of reg.tools) {
    realSchemas.set(tool, def.input);
    def.run = async () => (tool === "vault.said.match" ? { matched: world.said } : SENT);
  }
  if (reg.deps && reg.deps.presence) reg.deps.presence.verify = async () => (world.proof ? { ok: true, method: "golden", keyId: null } : { ok: false, code: "presence_required", message: "golden" });
  const rows = {}, emptyBad = {};
  const { checkInput } = await import(path.join(here, "..", "..", "core", "modules", "index.js"));
  for (const [tool, def] of [...reg.tools].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const real = realSchemas.get(tool);
    let row = "";
    for (const c of CALLERS) for (const w of WORLDS) {
      world.proof = w.proof; world.said = w.said;
      def.input = undefined; // the schema is judged on its own (below); here we want the gates after it
      const input = {};
      if (w.named) for (const a of [def.projectArg, def.cwdArg].flat()) if (typeof a === "string") input[a] = "x";
      let r;
      try { r = await reg.call(tool, input, c.caller(reg), { ...(w.person ? { person: true } : {}), ...(c.meta || {}), ...(w.proof ? { proof: { golden: true } } : {}) }); }
      catch (e) { r = { error: { code: "threw:" + (e && e.code ? e.code : "unknown") } }; }
      row += r.error ? letterOf(r.error.code) : r.data === SENT ? "R" : letterOf("ran:" + typeof r.data);
    }
    def.input = real;
    rows[tool] = row;
    // What the real schema says about an empty input: the one decision the stripped pass skips.
    const problems = real ? checkInput(real, {}) : [];
    emptyBad[tool] = problems.length ? 1 : 0;
  }
  out.roles[role] = { rows, emptyBad };
  await d.stop();
}
out.legend = legend;
fs.rmSync(root0, { recursive: true, force: true });
process.stdout.write(JSON.stringify(out), () => process.exit(0));
