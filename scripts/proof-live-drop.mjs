#!/usr/bin/env node
// scripts/proof-live-drop.mjs: free the throwaway names a live walk made (scripts/proof-install.mjs --live), with the support admin drop.
//   VYRE_NAMES_ADMIN_SECRET=... node scripts/proof-live-drop.mjs <names.json | name ...>
// The secret is read from the environment and never printed. It runs no Vyre: it only makes HTTPS calls to names.vyre.run.
import fs from "node:fs";

const base = process.env.VYRE_NAMES_BASE || "https://names.vyre.run";
const secret = process.env.VYRE_NAMES_ADMIN_SECRET || "";
const args = process.argv.slice(2);
if (!secret || !args.length) { console.error("usage: VYRE_NAMES_ADMIN_SECRET=... proof-live-drop.mjs <names.json | name ...>"); process.exit(64); }
const names = args.length === 1 && args[0].endsWith(".json") ? JSON.parse(fs.readFileSync(args[0], "utf8")) : args;
let bad = 0;
for (const name of names) {
  const r = await fetch(`${base}/v1/names/admin/drop`, { method: "POST", headers: { "content-type": "application/json", "x-vyre-admin": secret }, body: JSON.stringify({ name }) });
  const j = await r.json().catch(() => null);
  const gone = j && j.error && j.error.code === "no_such_name";
  const ok = r.status === 200 || gone;
  if (!ok) bad++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}: ${r.status === 200 ? "freed" : gone ? "already free" : `${r.status} ${JSON.stringify(j && j.error || j).slice(0, 100)}`}`);
}
process.exit(bad ? 1 : 0);
