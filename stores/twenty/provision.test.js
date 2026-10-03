import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { SCRATCH } from "../../test/scratch.mjs";
import { composeFile, firewallRules, names, provisionSpace, upgradeSpace, spaceDir, TWENTY_TESTED_TAG } from "./provision.js";
import { FakeTwenty } from "./testing/fake-twenty.js";

const dirs = [];
const tmp = () => { const d = fs.mkdtempSync(path.join(SCRATCH, "prov-")); dirs.push(d); return d; };
after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

test("the compose file publishes no port, keeps the network internal and mounts an empty front end", () => {
  const y = composeFile({ space: "harlow" });
  assert.ok(!/^\s*ports:/m.test(y), "no ports anywhere");
  assert.match(y, /networks:\n  store:\n    internal: true/);
  assert.match(y, /\.\/empty-front:\/app\/packages\/twenty-server\/dist\/front:ro/);
  assert.match(y, /twentycrm\/twenty:\$\{TWENTY_TAG:-v2\.44\.0\}/);
  assert.match(y, /OUTBOUND_HTTP_ALLOWED_INTERNAL_HOSTS: vyre-harlow\n/);
  assert.equal((y.match(/OUTBOUND_HTTP_ALLOWED_INTERNAL_HOSTS/g) ?? []).length, 2, "set on the worker as well as the server");
  assert.match(y, /--requirepass/);
  assert.match(y, /POSTGRES_PASSWORD: "\$\{PG_PASSWORD\}"/);
  assert.ok(!/postgres:postgres|password: ?postgres/i.test(y), "no default password");
  assert.match(y, /name: vyre-harlow-twenty\n/);
  assert.match(y, /IS_MULTIWORKSPACE_ENABLED: "false"/);
  for (const bad of ["Harlow", "x y", "../x", "", "a".repeat(40)]) assert.throws(() => composeFile({ space: bad }));
});

test("each Space gets its own network, volumes and aliases", () => {
  const a = names("harlow"), b = names("northwind");
  for (const k of ["project", "network", "serverAlias", "gatewayAlias"]) assert.notEqual(a[k], b[k]);
  assert.notEqual(a.volumes.db, b.volumes.db);
  assert.match(firewallRules({ space: "harlow", subnet: "172.30.4.0/24" }), /--uid-owner 2000-4294967294 -j REJECT/);
  assert.throws(() => firewallRules({ space: "harlow", subnet: "nope" }));
});

function fakeRunner(fake, calls) {
  return {
    exec: async (cmd, args, opts = {}) => { calls.push([cmd, ...args].join(" ")); if (args.includes("inspect")) return { stdout: "10.0.0.2\n", stderr: "" }; if (args.includes("pg_dump")) return { stdout: "-- dump\n", stderr: "" }; return { stdout: "", stderr: "" }; },
    fetch: (u, init) => fetch(String(u).replace(/^http:\/\/[^/]+/, fake.url), init),
    sleep: async () => {},
  };
}

test("provisioning brings Twenty up, creates the service key headlessly, and keeps secrets private", async () => {
  const fake = await new FakeTwenty().start(); const home = tmp(); const calls = [];
  const p = await provisionSpace({ home, space: "harlow", runner: fakeRunner(fake, calls), gatewayContainer: "vyre-vyre-1" });
  assert.deepEqual(fake.boot.calls, ["Boot_signUp", "Boot_workspace", "Boot_login", "Boot_activate", "Boot_roles", "Boot_key", "Boot_token", "Boot_close"]);
  assert.equal(fake.boot.closed, true, "password login is closed on the workspace");
  assert.ok(calls.some((c) => /compose .* up -d --wait/.test(c)));
  assert.ok(calls.some((c) => c.includes("network connect --alias vyre-harlow vyre-harlow-twenty_store vyre-vyre-1")));
  assert.equal(fs.readFileSync(p.keyFile, "utf8"), fake.key);
  assert.equal(p.url, "http://twenty-harlow:3000");
  const dir = spaceDir(home, "harlow");
  for (const f of [".env", "service.key", "webhook.secret", "admin.secret", "compose.yml"]) assert.equal(fs.statSync(path.join(dir, f)).mode & 0o777, 0o600, `${f} is 0600`);
  assert.equal(fs.statSync(dir).mode & 0o077, 0, "the Space folder is private");
  const env = fs.readFileSync(path.join(dir, ".env"), "utf8");
  assert.match(env, /^PG_PASSWORD=[0-9a-f]{32}$/m);
  assert.match(env, /^APP_SECRET=[0-9a-f]{64}$/m);
  assert.ok(!fs.readFileSync(path.join(dir, "compose.yml"), "utf8").includes(fake.key), "the key is never in the compose file");
  assert.ok(fs.existsSync(path.join(dir, "empty-front")));
  await fake.stop();
});

test("provisioning twice does not make a second workspace or key", async () => {
  const fake = await new FakeTwenty().start(); const home = tmp(); const calls = [];
  const a = await provisionSpace({ home, space: "harlow", runner: fakeRunner(fake, calls) });
  const n = fake.boot.calls.length;
  const b = await provisionSpace({ home, space: "harlow", runner: fakeRunner(fake, calls) });
  assert.equal(fake.boot.calls.length, n);
  assert.equal(a.workspaceId, b.workspaceId);
  await fake.stop();
});

test("two Spaces never share a folder, a secret or a key file", async () => {
  const fake = await new FakeTwenty().start(); const home = tmp();
  const a = await provisionSpace({ home, space: "harlow", runner: fakeRunner(fake, []) });
  const b = await provisionSpace({ home, space: "northwind", runner: fakeRunner(fake, []) });
  assert.notEqual(a.dir, b.dir);
  assert.notEqual(fs.readFileSync(path.join(a.dir, ".env"), "utf8"), fs.readFileSync(path.join(b.dir, ".env"), "utf8"));
  await fake.stop();
});

test("upgrade backs up first, verifies before reopening, and rolls back with the old image on a failed verify", async () => {
  const fake = await new FakeTwenty().start(); const home = tmp(); const calls = [];
  const runner = fakeRunner(fake, calls);
  await provisionSpace({ home, space: "harlow", runner });
  calls.length = 0;
  let verified = 0;
  const ok = await upgradeSpace({ home, space: "harlow", runner, toTag: "v2.45.0", verify: async () => { verified++; } });
  assert.equal(ok.ok, true); assert.equal(ok.rolledBack, false); assert.equal(ok.from, TWENTY_TESTED_TAG); assert.equal(verified, 1);
  assert.ok(calls[0].includes("pg_dump"), "the dump is the first thing that happens");
  assert.match(fs.readFileSync(path.join(spaceDir(home, "harlow"), ".env"), "utf8"), /^TWENTY_TAG=v2\.45\.0$/m);
  assert.ok(fs.existsSync(ok.backup));
  calls.length = 0; verified = 0;
  const bad = await upgradeSpace({ home, space: "harlow", runner, toTag: "v2.46.0", verify: async () => { verified++; if (verified === 1) throw new Error("isolation test failed"); } });
  assert.equal(bad.ok, false); assert.equal(bad.rolledBack, true); assert.equal(verified, 2, "verify runs again after the rollback");
  assert.match(fs.readFileSync(path.join(spaceDir(home, "harlow"), ".env"), "utf8"), /^TWENTY_TAG=v2\.45\.0$/m, "the old tag is back");
  assert.ok(calls.some((c) => c.includes("DROP DATABASE")) && calls.some((c) => c.includes("psql") && c.includes("ON_ERROR_STOP")));
  await fake.stop();
});
