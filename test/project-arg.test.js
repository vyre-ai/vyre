// @ts-check
// Every tool an agent can call that takes a project or a folder declares it (projectArg, cwdArg), so the registry
// checks the agent's grant once (core/modules/index.js). A new tool with a `project`, `projects` or `cwd` input and
// no declaration is silently uncovered: this fails until it declares one, or is named below with the reason.

import { test } from "node:test";
import assert from "node:assert/strict";
import { harvest, manifests } from "../scripts/lib/docs/reference.js";
import { toolEntries } from "../packages/module-sdk/manifest.js";

/** Tools reachable by an agent that are deliberately not covered, each with why. */
const EXEMPT = {
  "agents.update": "an agent changes only what it says about itself; the tool guards that (core/agents)",
  "sessions.accounts.bind": "an agent binds an account only when the person asked (askedOnly); the asked gate is the check",
  "vault.grant": "presence-gated and person-only at the vault; reviewer-2 has the vault grant and revoke review",
  "vault.revoke": "presence-gated and person-only at the vault; reviewer-2 has the vault grant and revoke review",
  "github.project.detect": "github checks the grant itself (inGrant, core/github)",
  "github.project.of": "github checks the grant itself (inGrant, core/github)",
  "wink.invite": "the owner's own act: the tool refuses any agent caller (owner(meta)) and its `projects` are slugs written into an offer",
  "work.situation": "`project` is a record reference (a kernel URN), not a project slug: the tool reads it under the caller's own kernel chain, which decides what is visible",
  "work.team.context": "`project` is a record reference (a kernel URN): read under the caller's own kernel chain",
  "work.team.add": "`project` is a record reference (a kernel URN); a person's act (ask-first for an agent), grants no wider than the adder's",
  "work.team.doing": "`project` is a record reference (a kernel URN): read under the caller's own kernel chain",
};
const PERSON = new Set(["cli", "local", "deck", "capsule", "module", "tailnet", "device", "space", "agent", "link", "mobile"]);

test("project grants: every agent-reachable tool with a project, projects or cwd input declares projectArg or cwdArg", () => {
  const h = harvest({});
  const declared = new Map();
  for (const m of manifests()) for (const e of toolEntries(m.manifest)) declared.set(e.name, e);
  const missing = [];
  const seen = new Set();
  for (const role of ["box", "local"]) for (const v of Object.values(h[role] || {})) for (const t of /** @type {any} */ (v).tools || []) {
    if (seen.has(t.name)) continue;
    seen.add(t.name);
    if (t.internal || t.name.startsWith("github.")) continue;
    const props = Object.keys((t.input && t.input.properties) || {});
    const wantsProject = props.some(p => p === "project" || p === "projects"), wantsCwd = props.includes("cwd");
    if (!wantsProject && !wantsCwd) continue;
    const agentReach = !t.callers || t.callers.some((/** @type {string} */ c) => !PERSON.has(c));
    if (!agentReach || EXEMPT[/** @type {keyof typeof EXEMPT} */ (t.name)]) continue;
    const d = declared.get(t.name) || {};
    if (wantsProject && d.projectArg == null) missing.push(`${t.name}: has a project input and no projectArg`);
    if (wantsCwd && d.cwdArg == null) missing.push(`${t.name}: has a cwd input and no cwdArg`);
  }
  assert.deepEqual(missing, [], "declare projectArg/cwdArg on these tools (core/modules/index.js enforces the agent's grant), or add them to EXEMPT with the reason");
});

test("project grants: a tool that takes `room` as an alias for `project` declares both, so an agent cannot name an ungranted project through room", () => {
  const h = harvest({});
  const declared = new Map();
  for (const m of manifests()) for (const e of toolEntries(m.manifest)) declared.set(e.name, e);
  const missing = [];
  const seen = new Set();
  for (const role of ["box", "local"]) for (const v of Object.values(h[role] || {})) for (const t of /** @type {any} */ (v).tools || []) {
    if (seen.has(t.name)) continue;
    seen.add(t.name);
    const props = Object.keys((t.input && t.input.properties) || {});
    if (t.internal || !props.includes("room") || !props.includes("project")) continue;
    const arg = (declared.get(t.name) || {}).projectArg;
    if (arg == null) continue;      // not declared at all: the test above says so
    const list = Array.isArray(arg) ? arg : [arg];
    if (!list.includes("room")) missing.push(`${t.name}: takes room and project, and projectArg names only ${list.join(", ")}`);
  }
  assert.deepEqual(missing, []);
});
