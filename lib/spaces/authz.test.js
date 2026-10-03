// @ts-check
import test from "node:test";
import assert from "node:assert/strict";
import { createRoleAuthorize, personChain, ACTIONS } from "./authz.js";

const NOW = Date.UTC(2026, 9, 3);
const roles = { alex: { space: "harlow", person: "alex", role: "owner" }, ada: { space: "harlow", person: "ada", role: "admin" }, mo: { space: "harlow", person: "mo", role: "manager" },
  sam: { space: "harlow", person: "sam", role: "member" }, tem: { space: "harlow", person: "tem", role: "temp", scope: ["vyre://harlow/project/p1"], expires: NOW + 1000 } };
const authorize = createRoleAuthorize({ membership: (space, p) => (space === "harlow" ? roles[p] : null), now: () => NOW, policy: () => ({ allow_copy: true }) });
const as = (person, action, extra) => authorize({ chain: personChain({ space: "harlow", person, extra }), action });

test("authz: owners and admins share and accept bridges, managers and members do not", async () => {
  assert.equal((await as("alex", "views.share")).effect, "ask", "an outward share is held for approval even for the owner");
  assert.equal((await as("ada", "bridges.accept")).effect, "allow");
  for (const p of ["mo", "sam", "tem"]) assert.equal((await as(p, "bridges.accept")).reason, "no_grant", p);
});

test("authz: publishing is held; previewing is a member's work; temp reaches nothing space-wide", async () => {
  assert.equal((await as("sam", "deploy.preview")).effect, "allow");
  assert.equal((await as("sam", "deploy.publish")).reason, "no_grant");
  const pub = await as("mo", "deploy.publish");
  assert.equal(pub.effect, "ask");
  assert.ok(pub.obligations.some(o => o.type === "ask" && o.checker_must_be_person));
  assert.equal((await as("tem", "deploy.preview")).reason, "no_grant");
});

test("authz: a model in the chain is held for anything outward and refused admin acts", async () => {
  const agent = [{ kind: "agent", id: "juno" }];
  assert.equal((await as("alex", "deploy.publish", agent)).effect, "ask");
  assert.equal((await as("alex", "bridges.revoke", agent)).reason, "chain_not_person");
  assert.equal((await as("alex", "deploy.preview", agent)).effect, "allow", "it may do what the person may in write");
});

test("authz: non-members, expired temps, unknown actions and sealed copies are refused", async () => {
  assert.equal((await authorize({ chain: personChain({ space: "harlow", person: "stranger" }), action: "deploy.read" })).reason, "not_a_member");
  const late = createRoleAuthorize({ membership: (_s, p) => roles[p], now: () => NOW + 5000 });
  assert.equal((await late({ chain: personChain({ space: "harlow", person: "tem" }), action: "tasks.continue" })).reason, "expired");
  assert.equal((await as("alex", "nope")).reason, "unknown_action");
  assert.equal((await as("alex", "copy.sealed")).effect, "deny");
  assert.equal((await authorize({ chain: { space: "harlow", hops: [{ actor: { kind: "agent", id: "juno", space: "harlow" } }] }, action: "deploy.read" })).reason, "chain_not_person");
  assert.ok(Object.keys(ACTIONS).includes("views.read"));
});

test("authz: copying needs the Space's policy to allow it", async () => {
  const no = createRoleAuthorize({ membership: (_s, p) => roles[p], now: () => NOW, policy: () => ({}) });
  assert.equal((await no({ chain: personChain({ space: "harlow", person: "sam" }), action: "records.copy" })).reason, "no_grant");
  assert.equal((await as("sam", "records.copy")).effect, "ask");
});
