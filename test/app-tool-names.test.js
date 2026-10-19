// Every tool name a screen sends is a tool the server has (a registry tool declared in a module.json, or a row of the member door's table, which the app reaches over the team's door). A name that exists nowhere answers "no such
// tool" when the button is pressed: the lessons screen sent `learn.skill_retire` for "dismiss" (the tool is `learn.skill-dismiss`) and the Find screen searched `files.drive.space.search`, which is not a tool. Run after any
// change to a screen's source file or a module's tool list.
import "../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MEMBER_TOOLS } from "../core/work/member-tools.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const walk = (/** @type {string} */ dir, /** @type {string[]} */ out = []) => {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (["node_modules", "dist", ".expo", ".git"].includes(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out); else out.push(p);
  }
  return out;
};

test("every tool a screen's source file sends exists on the server", () => {
  const have = new Set(Object.keys(MEMBER_TOOLS));
  for (const f of walk(path.join(ROOT, "core")).filter(f => f.endsWith("module.json"))) {
    const j = JSON.parse(fs.readFileSync(f, "utf8"));
    for (const t of (j.does && j.does.tools) || []) have.add(typeof t === "string" ? t : t.name);
  }
  assert.ok(have.size > 500, "the server's tools were read");
  // names the app sends that are not registry tools: the door's own call names (chat, accounts, sidebar, member rows spelled differently) and the stream's
  const OTHER = new Set(["files.list", "files.read", "files.upload"]);
  // Tools the page answers itself when it has no daemon (apps/app/src/host/host-core.js): the first run's sign-in, space-name, "Not your server? Remove it", Assistant, AI-account and API-key steps. Not registry tools, so each must be a key of that host's table.
  const hostSrc = fs.readFileSync(path.join(ROOT, "apps/app/src/host/host-core.js"), "utf8");
  for (const n of ["onboard.signin", "onboard.signin.github", "onboard.signin.unlock", "onboard.space.name", "onboard.space.remove",
    "onboard.assistant.set", "onboard.assistant.models", "onboard.assistant.model", "onboard.assistant.current", "onboard.agent.key", "onboard.accounts.copyable", "onboard.accounts.copy",
    // join by address (the asker's screens, real.js) and Settings, Account on a page with no daemon (its box holds no identity, so the host answers the person's list and recovery code)
    "onboard.space.ask", "onboard.space.ask.status", "identity.entries", "identity.code.replace", "identity.entry.remove", "identity.agree.status", "identity.agree.retry"]) {
    assert.ok(hostSrc.includes(`"${n}": async`), `${n} is answered by the page host`);
    OTHER.add(n);
  }
  /** @type {string[]} */ const missing = [];
  const CALL = /\b(?:ask|call|callT|tool|read|write)\w*\(\s*"([a-z][a-z0-9]*(?:\.[a-z][a-z0-9_-]*)+)"/g;
  for (const f of walk(path.join(ROOT, "apps/app/screens")).filter(f => /source\.(ts|js)$|real\.(ts|js)$/.test(f) && !/\.test\.|mock/.test(f))) {
    const text = fs.readFileSync(f, "utf8");
    for (const m of text.matchAll(CALL)) if (!have.has(m[1]) && !OTHER.has(m[1])) missing.push(`${path.relative(ROOT, f)}: ${m[1]}`);
  }
  assert.deepEqual([...new Set(missing)].sort(), [], "a screen sends a tool the server does not have");
});
