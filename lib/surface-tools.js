// @ts-check
// The kernel tools the onboarding, device and invite screens call. One scanner, so the MCP catalog,
// the Needs-you hold and the coverage test cannot list different tools.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Screens and helpers that enrol a device, join or invite, or walk someone through first run. */
const SCAN = Object.freeze([
  "apps/app/screens/install",
  "apps/app/screens/devices",
  "apps/app/screens/onboard",
  "apps/app/screens/first-run",
  "apps/app/src/real/install.ts",
  "apps/app/src/real/pairing.ts",
  "apps/app/src/identity/add-device.ts",
  "apps/app/src/identity/add-device-core.js",
  "apps/app/src/real/enrol-phone.ts",
  "apps/app/src/real/team-invite.js",
  "apps/app/src/real/team-join.ts",
  "apps/app/src/real/join-team.js",
]);

/** Kernel tools an agent drives that those screens do not spell as a call. */
export const SURFACE_EXTRA = Object.freeze(["onboard.machine", "onboard.windows", "releases.info"]);

const CALL = /tool(?:<[^>\n]{0,80}>)?\(\s*["']([a-z][a-z0-9-]*\.[a-z][a-z0-9.-]*)["']/g;

/** @param {string} abs @param {Set<string>} out */
function walk(abs, out) {
  let st;
  try { st = fs.statSync(abs); } catch { return; }
  if (st.isDirectory()) {
    for (const name of fs.readdirSync(abs)) {
      if (name === "node_modules" || name.startsWith(".")) continue;
      walk(path.join(abs, name), out);
    }
    return;
  }
  if (!/\.(mjs|cjs|js|ts|tsx)$/.test(abs) || /\.test\./.test(abs)) return;
  const text = fs.readFileSync(abs, "utf8");
  for (const m of text.matchAll(CALL)) out.add(m[1]);
}

/** @type {readonly string[] | null} */
let cached = null;

/** Every scanned call, plus SURFACE_EXTRA, sorted. */
export function surfaceNames() {
  if (cached) return cached;
  const out = new Set(SURFACE_EXTRA);
  for (const rel of SCAN) walk(path.join(REPO, rel), out);
  cached = Object.freeze([...out].sort());
  return cached;
}

/** @type {Set<string> | null} */
let asSet = null;

/** @param {string} name */
export function isSurface(name) {
  if (!asSet) asSet = new Set(surfaceNames());
  return asSet.has(String(name || ""));
}
