// The vault module starts in a real vyred: every tool it registers is declared in its manifest (the registry refuses to start a module that registers one it does not declare),
// the tools added for the forward, files and provider tokens included.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { start } from "../daemon/index.js";
import { tempHome, present } from "../../test/helpers.js";

test("a real vyred starts the vault module, and the manifest declares everything it registers", async t => {
  const root = tempHome(t); fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ name: "test-box", vault: { keystore: "file" } }));
  const d = await start({ root, presence: present, log: () => {} }); t.after(() => d.stop());
  const vault = d.registry.status().find(m => m.name === "vault");
  assert.equal(vault?.state, "running", JSON.stringify(vault));
  const manifest = JSON.parse(fs.readFileSync(new URL("./module.json", import.meta.url), "utf8")), declared = new Set(manifest.does.tools.map(x => x.name));
  for (const n of ["vault.forward", "vault.forward.file", "vault.provider.set", "vault.provider.remove", "vault.provider.status"]) assert.ok(declared.has(n), `${n} is declared`);
  for (const n of ["vault.forward", "vault.forward.file"]) { const r = await d.registry.call(n, { credential: "x", method: "GET", url: "https://x.test/", session: "s" }, "cli", {}); assert.ok(r.error, `${n}: a person's surface cannot call the kernel's forward`); }
});
