// @ts-check
// Every tool an agent can call that takes a project or a folder declares it (projectArg, cwdArg), so the registry
// checks the agent's grant once (core/modules/index.js). A new tool with a `project`, `projects` or `cwd` input and
// no declaration is silently uncovered: this fails until it declares one, or is named below with the reason.

import "../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { harvest, manifests } from "../scripts/lib/docs/reference.js";
import { toolEntries } from "../packages/module-sdk/manifest.js";
import fs from "node:fs";

/** Tools reachable by an agent that are deliberately not covered, each with why. */
const EXEMPT = {
  "agents.update": "an agent changes only what it says about itself; the tool guards that (core/agents)",
  "sessions.accounts.bind": "an agent binds an account only when the person asked (askedOnly); the asked gate is the check",
  "vault.grant": "presence-gated and person-only at the vault; reviewer-2 has the vault grant and revoke review",
  "vault.revoke": "presence-gated and person-only at the vault; reviewer-2 has the vault grant and revoke review",
  "github.project.detect": "github checks the grant itself (inGrant, core/github)",
  "github.project.of": "github checks the grant itself (inGrant, core/github)",
  "wink.invite": "the owner's own act: the tool refuses any agent caller (owner(meta)) and its `projects` are slugs written into an offer",
  "work.project.ref": "`project` is a record id, an address or a short name; the tool answers names only and reads under the caller's own chain",
  "spaces.moves.receive": "`project` names the project in the SOURCE space on another home (the move's own record address), not a project of this home: nothing here can resolve it, and the move engine checks the signed evidence and the person's chain (person-only)",
  "work.session.move": "`project` is a short name or a record address; the move runs under the caller's own kernel chain (records.update on the chat and the target Project), which decides who may",
  "work.situation": "`project` is a record reference (a kernel URN), not a project slug: the tool reads it under the caller's own kernel chain, which decides what is visible",
  "work.team.context": "`project` is a record reference (a kernel URN): read under the caller's own kernel chain",
  "work.team.add": "`project` is a record reference (a kernel URN); a person's act (ask-first for an agent), grants no wider than the adder's",
  "work.team.doing": "`project` is a record reference (a kernel URN): read under the caller's own kernel chain",
  "files.drive.space.read": "`path` is a path in the Space's Drive, not a project folder: a model reads it only in a team chat's turn, as the member who spoke, and the Space's own `drive.read` decides per path",
};
/** Input names that can point at a project's files or its name, besides project, projects and cwd. A tool with one and no declaration is named in UNJUDGED until someone decides whether an agent's grant must cover it. */
const FOLDERISH = ["repo", "folder", "folders", "workspace", "slug", "dir", "path", "paths"];
/** Agent-reachable tools with a FOLDERISH input that nobody has judged yet (issue 119), by tool. Judge one (declare projectArg/cwdArg, or move it to EXEMPT with the reason) and delete the line; never add one. */
const UNJUDGED = Object.fromEntries([
  "artifacts.capture.register", "documents.signed-link", "documents.send-signed", "files.stat", "files.preview", "files.fetch", "files.drive.list", "files.drive.read", "files.drive.measure", "files.drive.offer", "files.dirs", "files.drive.local",
  "glass.files.list", "glass.files.stat", "glass.files.preview", "glass.files.download", "glass.files.upload", "glass.files.mkdir", "glass.files.trash", "import.scan", "relay.devices.path", "threads.undo-edit", "vault.sweep", "vault.pass.create",
  "work.start-project", "work.file.share", "work.file.unshare", "work.project.create",
].map(t => [t, t.split(".")[0]]));
/** github.* tools that take a project and check the agent's grant themselves (inGrant, directly or through prTarget), each proved below by reading the tool's own code. A new github tool is not on this list. */
const GITHUB_OWN = new Set(["github.project.issue.get", "github.project.issue.list", "github.project.local-init", "github.project.pr.comments", "github.project.pr.get", "github.project.pr.merge", "github.project.pr.open",
  "github.project.pr.review", "github.project.pr.status", "github.session.history", "github.session.push", "github.session.redo", "github.session.undo"]);
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
    if (t.internal || GITHUB_OWN.has(t.name)) continue;
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

test("project grants: a tool with a repo, folder, workspace, slug, dir or path input is declared, exempt, or on the shrinking UNJUDGED list, and the check really looked at tools", () => {
  const h = harvest({});
  const declared = new Map();
  for (const m of manifests()) for (const e of toolEntries(m.manifest)) declared.set(e.name, e);
  const fresh = [];
  const hit = new Set();
  let checked = 0;
  const seen = new Set();
  for (const role of ["box", "local"]) for (const v of Object.values(h[role] || {})) for (const t of /** @type {any} */ (v).tools || []) {
    if (seen.has(t.name)) continue;
    seen.add(t.name);
    if (t.internal) continue;
    const props = Object.keys((t.input && t.input.properties) || {});
    if (!props.some(p => FOLDERISH.includes(p))) continue;
    const agentReach = !t.callers || t.callers.some((/** @type {string} */ c) => !PERSON.has(c));
    if (!agentReach) continue;
    checked++;
    const d = declared.get(t.name) || {};
    if (d.projectArg != null || d.cwdArg != null || EXEMPT[/** @type {keyof typeof EXEMPT} */ (t.name)]) continue;
    hit.add(t.name);
    if (!(t.name in UNJUDGED)) fresh.push(t.name);
  }
  assert.ok(checked > 15, `the scan looked at the tools that take a folder-like input (${checked})`);
  assert.deepEqual(fresh, [], "these agent-reachable tools take a repo, folder, workspace, slug, dir or path and declare nothing: declare projectArg/cwdArg, or add to EXEMPT with the reason");
  const settled = Object.keys(UNJUDGED).filter(t => !hit.has(t));
  assert.deepEqual(settled, [], "these are judged or gone: delete them from UNJUDGED");
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

test("project grants: every github tool that checks its own grant calls inGrant, directly or through prTarget (which does)", () => {
  const src = fs.readFileSync(new URL("../core/github/index.js", import.meta.url), "utf8");
  const starts = [...src.matchAll(/ctx\.tool\(\s*"([a-z.\-]+)"/g)].map(m => [m[1], m.index]);
  const block = (/** @type {string} */ name) => { const k = starts.findIndex(x => x[0] === name); return k < 0 ? "" : src.slice(starts[k][1], k + 1 < starts.length ? starts[k + 1][1] : src.length); };
  const pt = src.indexOf("prTarget = async") >= 0 ? src.indexOf("prTarget = async") : src.indexOf("function prTarget");
  assert.ok(pt > 0, "prTarget is where the guard expects it");
  assert.ok(/inGrant\(/.test(src.slice(pt, pt + 900)), "prTarget checks the agent's grant (inGrant)");
  const weak = [...GITHUB_OWN].filter(n => { const b = block(n); return !b || !(/inGrant\(|prTarget\(/.test(b)); });
  assert.deepEqual(weak, [], "these github tools no longer call inGrant or prTarget: they must declare projectArg or check the grant");
});
