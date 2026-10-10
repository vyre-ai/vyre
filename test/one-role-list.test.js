// @ts-check
// R031-00c: one role list. The five roles, their rank, their labels and who may set whom are written once (kernel/contracts); everything else imports them. Three named lists mean something else and are
// allowed to exist: the wink pairing admins, the publish approvers and the assistant makers.
import "../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ROLE_IDS, ROLE_RANK, ROLE_LABELS, ROLE_MAY_SET } from "../kernel/contracts/index.js";
import { CORE_ROLES } from "../records/language/compile.js";
import { MAY_SET } from "../kernel/grants/roles.js";
import { roleRank, canAssign, roleAtLeast } from "../lib/spaces/members.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const ALLOWED = new Set([
  "kernel/contracts/index.js",
  "core/wink/pairing.js",        // ADMIN_ROLES: who may pair a device
  "lib/publish/flow.js",         // APPROVER_ROLES and the ask's role list: who approves a preview
  "core/vault/shared.js",        // the vault's own sharing roles (owner, admin, member, read-only): access levels of a vault, not Space roles (INVENTORY.md decision 1)
  "apps/app/screens/assistants/create-card-model.ts",   // MAKERS: who may make an assistant
]);

/** @param {string} dir @param {string[]} out */
function walk(dir, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name.startsWith(".")) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(js|mjs|ts|tsx)$/.test(e.name) && !/\.(test|d)\.(js|ts|tsx)$|\.test\.mjs$/.test(e.name) && !p.includes(`${path.sep}testing${path.sep}`) && !p.includes(`${path.sep}test${path.sep}`)) out.push(p);
  }
  return out;
}

test("the role order and who-may-set-whom are single tables: members and grants read the contracts', and rank is one direction", () => {
  assert.equal(MAY_SET, ROLE_MAY_SET);
  assert.deepEqual([...ROLE_MAY_SET.owner], [...ROLE_IDS]);
  assert.deepEqual([...ROLE_MAY_SET.admin], ["manager", "member", "temp"]);
  for (const r of ["manager", "member", "temp"]) assert.deepEqual([...ROLE_MAY_SET[/** @type {"manager"} */ (r)]], []);
  for (const r of ROLE_IDS) assert.equal(roleRank(r), ROLE_RANK[r], "lib/spaces/members.js no longer has a second rank");
  assert.ok(roleRank("owner") > roleRank("admin") && roleRank("admin") > roleRank("manager") && roleRank("temp") > roleRank("nobody"));
  assert.equal(canAssign("admin", "owner"), false);
  assert.equal(canAssign("admin", "temp"), true);
  assert.equal(roleAtLeast("manager", "manager") && roleAtLeast("owner", "manager") && !roleAtLeast("member", "manager") && !roleAtLeast("nobody", "temp"), true);
});

test("grep finds one role list: no source file but the contracts and four named special lists spells out the owner/admin sequence", () => {
  const files = [];
  for (const d of ["core", "lib", "kernel", "records", "apps/app/screens", "apps/app/src", "harness"]) if (fs.existsSync(path.join(ROOT, d))) walk(path.join(ROOT, d), files);
  const re = /["']owner["']\s*,\s*["']admin["']|["']admin["']\s*,\s*["']manager["']\s*,\s*["']member["']/;
  const hits = files.map((f) => path.relative(ROOT, f)).filter((f) => !ALLOWED.has(f) && re.test(fs.readFileSync(path.join(ROOT, f), "utf8")));
  assert.deepEqual(hits, [], "import ROLE_IDS / ROLE_MAY_SET from kernel/contracts (roleAtLeast from lib/spaces/members.js) instead, or add the file here with the reason");
});

test("the five roles, their rank and their labels come from kernel/contracts and agree, and a Kit role is built on the same five", () => {
  assert.deepEqual([...ROLE_IDS], ["owner", "admin", "manager", "member", "temp"]);
  assert.deepEqual(ROLE_IDS.map(id => ROLE_RANK[id]), [4, 3, 2, 1, 0]);
  assert.deepEqual(ROLE_IDS.map(id => ROLE_LABELS[id]), ["Owner", "Admin", "Manager", "Member", "Temp"]);
  assert.deepEqual(Object.keys(ROLE_LABELS), [...ROLE_IDS]);
  assert.deepEqual([...CORE_ROLES], [...ROLE_IDS], "CORE_ROLES is the contract's list, not a second one");
});

test("the Flows host offers all five roles, temp included, and the other role lists keep names that say what they are", () => {
  assert.match(fs.readFileSync(path.join(ROOT, "core/daemon/flows-host.js"), "utf8"), /roles: \[\.\.\.ROLE_IDS\]/);
  assert.match(fs.readFileSync(path.join(ROOT, "core/vault/shared.js"), "utf8"), /export const ROLE_LEVEL = Object\.freeze\(\{ owner: "manage", admin: "manage", member: "reveal", "read-only": "use" \}\);\nexport const VAULT_MEMBER_ROLES = Object\.keys\(ROLE_LEVEL\)/, "a vault's own sharing roles are access levels, not Space roles");
  assert.match(fs.readFileSync(path.join(ROOT, "core/wink/index.js"), "utf8"), /const WINK_PAIR_ROLES = /, "the roles a Wink invitation can carry");
});
