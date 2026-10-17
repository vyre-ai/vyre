// Every client that creates an identity, joins, invites, or adds a computer calls the onboard tools.
// The tool names come from core/onboard/module.json. The tools those wrap are the call() names in core/onboard/first-run.js.
// A screen, a route, or a native shell that calls a wrapped tool has grown a second implementation of the same checks.
import "../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SKIP_DIR = new Set(["node_modules", "dist", ".expo", ".git", "generated"]);

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIR.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

function onboardNames() {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "core/onboard/module.json"), "utf8"));
  const names = [];
  for (const t of manifest.does.tools) {
    const name = typeof t === "string" ? t : t.name;
    if (/^onboard\.(person|space|join|member|computer|phone|github)\./.test(name)) names.push(name);
  }
  return names.sort();
}

/** call("a.b") inside the one onboard implementation. spaces.list and identity.status are general reads the rest of the app uses. */
function wrappedWrites() {
  const src = fs.readFileSync(path.join(ROOT, "core/onboard/first-run.js"), "utf8");
  const names = new Set();
  for (const m of src.matchAll(/\b(?:call|personCall|relayTool)\(\s*"([a-z][a-z0-9]*(?:\.[a-z][a-z0-9_-]*)+)"/g)) names.add(m[1]);
  names.delete("spaces.list");
  names.delete("identity.status");
  // Settings connects AI accounts the same way; onboarding reaches it only through onboard.agent.signin in the app.
  names.delete("sessions.accounts.signin");
  return [...names].sort();
}

const CALL = /\b(?:ask|call|callT|tool|read|write)(?:<[^>\n]{0,80}>)?\(\s*"([a-z][a-z0-9]*(?:\.[a-z][a-z0-9_-]*)+)"/g;

function clientCalls(file) {
  const text = fs.readFileSync(file, "utf8");
  const found = [];
  for (const m of text.matchAll(CALL)) found.push(m[1]);
  return found;
}

test("the onboard tools are the registry's, and first run is the only place that calls what they wrap", () => {
  const onboard = onboardNames();
  assert.ok(onboard.includes("onboard.person.create"));
  assert.ok(onboard.includes("onboard.space.join"));
  assert.ok(onboard.includes("onboard.space.open"));
  assert.ok(onboard.includes("onboard.member.link"));
  const wrapped = new Set(wrappedWrites());
  for (const name of ["identity.create", "identity.github.link", "spaces.invites.accept", "spaces.invites.create", "wink.install.issue", "wink.install.status", "vault.space.create"]) {
    assert.ok(wrapped.has(name), name);
  }
  const roots = [path.join(ROOT, "apps/app"), path.join(ROOT, "local/capsule")];
  const hits = [];
  for (const root of roots) {
    for (const f of walk(root)) {
      if (/\.test\.(js|ts|tsx)$|mock|generated/.test(f)) continue;
      if (!/\.(js|ts|tsx|mjs)$/.test(f)) continue;
      for (const name of clientCalls(f)) if (wrapped.has(name)) hits.push(`${path.relative(ROOT, f)}: ${name}`);
    }
  }
  assert.deepEqual(hits.sort(), []);
});

test("each onboarding door calls an onboard tool, and the native shells open that same app", () => {
  const onboard = new Set(onboardNames());
  const doors = [
    "apps/app/screens/first-run/real.js",
    "apps/app/src/real/install.ts",
    "apps/app/screens/devices/RealInvite.tsx",
    "apps/app/screens/devices/RealAdd.tsx",
  ];
  for (const rel of doors) {
    const names = clientCalls(path.join(ROOT, rel)).filter((n) => onboard.has(n));
    assert.ok(names.length > 0, `${rel} does not call an onboard tool`);
  }
  const win = fs.readFileSync(path.join(ROOT, "local/capsule/native-win/app/src/main.rs"), "utf8");
  const show = win.slice(win.indexOf("fn show_first_run"), win.indexOf("fn show_panel"));
  assert.match(show, /show_app/);
  assert.doesNotMatch(show, /first-run\.html/);
  const mac = fs.readFileSync(path.join(ROOT, "local/capsule/native/Sources/Host/Shell.swift"), "utf8");
  assert.match(mac, /web app's own first-run/);
  for (const rel of ["apps/app/app/u/setup/server.tsx"]) {
    assert.match(fs.readFileSync(path.join(ROOT, rel), "utf8"), /\/onboard/);
  }
  // The old first-run addresses are no route files: the two not-found routes send them to /onboard through the one map.
  for (const rel of ["apps/app/app/+not-found.tsx", "apps/app/app/u/+not-found.tsx"]) assert.match(fs.readFileSync(path.join(ROOT, rel), "utf8"), /oldRouteTarget/);
  assert.equal(fs.existsSync(path.join(ROOT, "apps/app/app/u/install")), false);
});
