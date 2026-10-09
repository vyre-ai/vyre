// @ts-check
// There is ONE list of Space roles: kernel/contracts ROLE_IDS (owner, admin, manager, member, temp), with ROLE_RANK and ROLE_LABELS beside it. A source file does not type the five again;
// it imports them. The lists that are NOT Space roles (a vault's own sharing roles, the roles a Wink invitation can carry, the admin pair) have their own names and are listed here with why.
// Inventory item 5 (team/0.3.1/INVENTORY.md).
import "../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ROLE_IDS, ROLE_RANK, ROLE_LABELS } from "../kernel/contracts/index.js";
import { CORE_ROLES } from "../records/language/compile.js";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const SKIP = new Set(["node_modules", ".git", "dist", "dist-ios", "dist-web", "docs", "team", "reference", "native", "native-win", "vendor"]);
function* files(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* files(p);
    else if (/\.(m?js|ts|tsx)$/.test(e.name) && !/\.(test|d)\.(m?js|ts)$/.test(e.name) && !/\.test\./.test(e.name)) yield p;
  }
}

test("the five roles, their rank and their labels come from kernel/contracts and agree", () => {
  assert.deepEqual([...ROLE_IDS], ["owner", "admin", "manager", "member", "temp"]);
  assert.deepEqual(ROLE_IDS.map(id => ROLE_RANK[id]), [4, 3, 2, 1, 0]);
  assert.deepEqual(ROLE_IDS.map(id => ROLE_LABELS[id]), ["Owner", "Admin", "Manager", "Member", "Temp"]);
  assert.deepEqual(Object.keys(ROLE_LABELS), [...ROLE_IDS]);
});

test("a Kit role is built on one of the five: CORE_ROLES is the contract's list, not a second one", () => {
  assert.deepEqual([...CORE_ROLES], [...ROLE_IDS]);
});

test("no source file types the five roles again; the lists that are not Space roles have their own names", () => {
  const FIVE = /["']owner["']\s*,\s*["']admin["']\s*,\s*["']manager["']\s*,\s*["']member["']\s*,\s*["']temp["']/;
  const typed = [];
  for (const top of ["core", "kernel", "lib", "records", "apps/app", "local", "modules", "names", "relay", "scripts"]) {
    const dir = path.join(root, top);
    if (!fs.existsSync(dir)) continue;
    for (const f of files(dir)) {
      const rel = path.relative(root, f).split(path.sep).join("/");
      if (rel === "kernel/contracts/index.js") continue;
      if (FIVE.test(fs.readFileSync(f, "utf8"))) typed.push(rel);
    }
  }
  assert.deepEqual(typed, [], "import ROLE_IDS from kernel/contracts instead of typing the roles");
  // not Space roles, each under a name that says so
  assert.match(fs.readFileSync(path.join(root, "core/vault/shared.js"), "utf8"), /export const VAULT_MEMBER_ROLES = \["owner", "admin", "member", "read-only"\]/, "a vault's own sharing roles (they become access levels with item 6)");
  assert.match(fs.readFileSync(path.join(root, "core/wink/index.js"), "utf8"), /const WINK_PAIR_ROLES = /, "the roles a Wink invitation can carry");
});

test("the Flows host offers all five roles, temp included", () => {
  const src = fs.readFileSync(path.join(root, "core/daemon/flows-host.js"), "utf8");
  assert.match(src, /roles: \[\.\.\.ROLE_IDS\]/);
});
