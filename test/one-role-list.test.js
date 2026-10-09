// @ts-check
// R031-00c: one role list. The five roles, their rank, their labels and who may set whom are written once (kernel/contracts); everything else imports them. Three named lists mean something else and are
// allowed to exist: the wink pairing admins, the publish approvers and the assistant makers.
import "../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ROLE_IDS, ROLE_RANK, ROLE_MAY_SET } from "../kernel/contracts/index.js";
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
