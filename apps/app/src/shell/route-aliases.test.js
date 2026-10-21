// @ts-check
import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ALIASES, aliasOf } from "./route-aliases.js";
import { productionRoutes } from "./production-routes.js";

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../app");

test("a production build lists every /u route, and the folded and demo routes are absent", () => {
  const routes = productionRoutes(appDir);
  assert.ok(routes.includes("/u/now") && routes.includes("/u/files") && routes.includes("/u/agents/[name]"), routes.join(" "));
  assert.ok(routes.includes("/u") && routes.includes("/u/drive") && routes.includes("/u/templates"), "an alias stays as a route so it can answer 302");
  for (const gone of ["/u/now/needs", "/u/now/doing", "/u/planner"]) {
    assert.equal(routes.includes(gone), false, gone);
    assert.equal(fs.existsSync(path.join(appDir, gone.slice(1) + ".tsx")), false, `${gone} file is gone`);
  }
  assert.equal(routes.includes("/u/vault-design"), false);
  assert.equal(routes.includes("/u/flows/shot"), false);
  assert.ok(fs.existsSync(path.join(appDir, "u/vault-design.tsx")), "the demo file stays for the mock build");
  assert.ok(!routes.some((r) => /gallery|shots-|demo|proof/.test(r)), routes.filter((r) => /gallery|shots-|demo|proof/.test(r)).join(" "));
  assert.ok(routes.every((r) => r === "/u" || r.startsWith("/u/")), "the list is only /u");
});

test("each old address answers 302 and names the one page", () => {
  assert.deepEqual(aliasOf("/u"), { status: 302, to: "/u/now" });
  assert.deepEqual(aliasOf("/u/"), { status: 302, to: "/u/now" });
  assert.deepEqual(aliasOf("/u/templates"), { status: 302, to: "/u/playbooks" });
  assert.deepEqual(aliasOf("/u/templates/abc"), { status: 302, to: "/u/playbooks/abc" });
  assert.deepEqual(aliasOf("/u/drive"), { status: 302, to: "/u/files" });
  assert.deepEqual(aliasOf("/u/assistants"), { status: 302, to: "/u/chats" });
  assert.deepEqual(aliasOf("/u/assistants/qi"), { status: 302, to: "/u/agents/qi" });
  assert.deepEqual(aliasOf("/u/assistants/a%20b"), { status: 302, to: "/u/agents/a%20b" });
  assert.deepEqual(aliasOf("/u/settings/assistants"), { status: 302, to: "/u/chats" });
  assert.deepEqual(aliasOf("/u/settings/assistants/new"), { status: 302, to: "/u/chats" });
  assert.deepEqual(aliasOf("/u/settings/assistants/qi"), { status: 302, to: "/u/agents/qi" });
  assert.deepEqual(aliasOf("/u/agents"), { status: 302, to: "/u/chats" });
  assert.deepEqual(aliasOf("/u/profile"), { status: 302, to: "/u/settings/profile" });
  assert.equal(aliasOf("/u/now"), null);
  assert.equal(aliasOf("/u/agents/qi"), null);
  assert.equal(aliasOf("/u/files"), null);
  for (const rule of ALIASES) {
    const pattern = rule.from.replace(/:([A-Za-z]+)/g, "[$1]");
    assert.ok(productionRoutes(appDir).includes(pattern), `${pattern} is a route`);
    assert.equal(aliasOf(rule.from.replace(/:([A-Za-z]+)/g, "x"))?.status, 302, rule.from);
  }
});
