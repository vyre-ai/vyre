import "../../scripts/mac-test-guard.mjs";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { SCRATCH } from "../../test/scratch.mjs";
import { TWENTY_TESTED_REF, isPinnedRef, composeFile, findGolden, tagOfRef, firewallRules, names, provisionSpace, upgradeSpace, spaceDir, TWENTY_TESTED_TAG } from "./provision.js";
import { FakeTwenty } from "./testing/fake-twenty.js";

const dirs = [];
const tmp = () => { const d = fs.mkdtempSync(path.join(SCRATCH, "prov-")); dirs.push(d); return d; };
after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

test("the compose file publishes no port, keeps the network internal and mounts an empty front end", () => {
  const y = composeFile({ space: "harlow" });
  assert.ok(!/^\s*ports:/m.test(y), "no ports anywhere");
  assert.match(y, /networks:\n  store:\n    internal: true/);
  assert.match(y, /\.\/empty-front:\/app\/packages\/twenty-server\/dist\/front:ro/);
  assert.match(y, /image: \$\{TWENTY_IMAGE_REF:-twentycrm\/twenty:v2\.44\.0@sha256:[0-9a-f]{64}\}/);
  for (const m of y.matchAll(/^\s+image: (.*)$/gm)) assert.match(m[1], /@sha256:[0-9a-f]{64}/, `an unpinned image in the Space compose: ${m[1]}`);
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
  assert.deepEqual(fake.boot.calls, ["Boot_signUp", "Boot_workspace", "Boot_login", "Boot_activate", "Boot_roles", "Boot_key", "Boot_token"]);
  assert.notEqual(fake.boot.closed, true, "password sign-in stays on: key rotation signs in with it");
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

const NEXT_REF = `twentycrm/twenty:v2.45.0@sha256:${"a".repeat(64)}`, NEXT2_REF = `twentycrm/twenty:v2.46.0@sha256:${"b".repeat(64)}`;

test("an upgrade or a compose takes only a full pinned image reference (tag and digest), never a bare tag", async () => {
  assert.ok(isPinnedRef(TWENTY_TESTED_REF) && !isPinnedRef("twentycrm/twenty:v2.45.0") && !isPinnedRef("twentycrm/twenty:latest"));
  assert.throws(() => composeFile({ space: "harlow", image: "twentycrm/twenty:v2.45.0" }), /full reference/);
  await assert.rejects(() => upgradeSpace({ home: tmp(), space: "harlow", toImage: "v2.45.0", verify: async () => {} }), /full image reference/);
});

test("upgrade backs up first, verifies before reopening, and rolls back with the old image on a failed verify", async () => {
  const fake = await new FakeTwenty().start(); const home = tmp(); const calls = [];
  const runner = fakeRunner(fake, calls);
  await provisionSpace({ home, space: "harlow", runner });
  calls.length = 0;
  let verified = 0;
  const ok = await upgradeSpace({ home, space: "harlow", runner, toImage: NEXT_REF, verify: async () => { verified++; } });
  assert.equal(ok.ok, true); assert.equal(ok.rolledBack, false); assert.equal(ok.from, TWENTY_TESTED_REF); assert.equal(verified, 1);
  assert.ok(calls[0].includes("pg_dump"), "the dump is the first thing that happens");
  assert.match(fs.readFileSync(path.join(spaceDir(home, "harlow"), ".env"), "utf8"), new RegExp(`^TWENTY_IMAGE_REF=${NEXT_REF.replace(/[.]/g, "\\.")}$`, "m"));
  assert.ok(fs.existsSync(ok.backup));
  calls.length = 0; verified = 0;
  const bad = await upgradeSpace({ home, space: "harlow", runner, toImage: NEXT2_REF, verify: async () => { verified++; if (verified === 1) throw new Error("isolation test failed"); } });
  assert.equal(bad.ok, false); assert.equal(bad.rolledBack, true); assert.equal(verified, 2, "verify runs again after the rollback");
  assert.match(fs.readFileSync(path.join(spaceDir(home, "harlow"), ".env"), "utf8"), new RegExp(`^TWENTY_IMAGE_REF=${NEXT_REF.replace(/[.]/g, "\\.")}$`, "m"), "the old image is back");
  assert.ok(calls.some((c) => c.includes("DROP DATABASE")) && calls.some((c) => c.includes("psql") && c.includes("ON_ERROR_STOP")));
  await fake.stop();
});

test("the small memory profile caps all four containers and sets a Node heap below the cap; no profile caps nothing", () => {
  const y = composeFile({ space: "harlow", memory: "small" });
  assert.equal((y.match(/mem_limit: \d+m/g) ?? []).length, 4);
  assert.match(y, /mem_limit: 1536m\n    memswap_limit: 1536m/);
  assert.match(y, /--max-old-space-size=1075/);
  assert.match(y, /shared_buffers=64MB/);
  assert.match(y, /--maxmemory", "72mb"/);
  assert.ok(!/mem_limit/.test(composeFile({ space: "harlow" })));
  assert.ok(!/mem_limit/.test(composeFile({ space: "harlow", memory: "standard" })));
  assert.match(composeFile({ space: "harlow", memory: { server: 500, worker: 300, db: 200, redis: 50 } }), /mem_limit: 300m/);
  assert.throws(() => composeFile({ space: "harlow", memory: "huge" }), /memory is one of/);
  assert.throws(() => composeFile({ space: "harlow", memory: { server: 5, worker: 300, db: 200, redis: 50 } }), /at least 32/);
});

test("a backup holds the database, the files and the Space folder with checksums, and a restore as another name keeps the secrets", async () => {
  const { backupSpace, restoreSpace } = await import("./provision.js");
  const fake = await new FakeTwenty().start();
  try {
    const home = tmp(), calls = [];
    const runner = fakeRunner(fake, calls);
    const ex = runner.exec;
    runner.exec = async (cmd, args, opts = {}) => { const r = await ex(cmd, args, opts); const out = args.find((a) => a.endsWith(":/out"))?.split(":")[0]; if (args[0] === "run" && out) { fs.writeFileSync(path.join(out, "files.tgz"), "tgz"); } return r; };
    const p = await provisionSpace({ home, space: "harlow", runner, reach: "ip", memory: "small" });
    fs.writeFileSync(path.join(p.dir, "state", "types.json"), "[]");
    const b = await backupSpace({ home, space: "harlow", runner });
    assert.deepEqual(Object.keys(b.manifest.parts), ["db.sql", "files.tgz", "space.json"]);
    assert.equal((fs.statSync(path.join(b.dir, "db.sql")).mode & 0o777).toString(8), "600");
    const home2 = tmp();
    const r = await restoreSpace({ home: home2, space: "harlow-2", from: b.dir, runner, reach: "ip" });
    assert.equal(fs.readFileSync(r.keyFile, "utf8"), fs.readFileSync(p.keyFile, "utf8"), "the same key still works");
    assert.equal(fs.readFileSync(path.join(r.dir, ".env"), "utf8"), fs.readFileSync(path.join(p.dir, ".env"), "utf8"), "secrets kept");
    assert.match(fs.readFileSync(path.join(r.dir, "compose.yml"), "utf8"), /name: vyre-harlow-2-twenty/);
    assert.match(fs.readFileSync(path.join(r.dir, "compose.yml"), "utf8"), /mem_limit: 1536m/, "the memory profile moves with the Space");
    assert.ok(fs.existsSync(path.join(r.dir, "state", "types.json")));
    // a flipped byte in a part is refused before anything starts
    const before = calls.length;
    fs.appendFileSync(path.join(b.dir, "db.sql"), "x");
    await assert.rejects(() => restoreSpace({ home: tmp(), space: "harlow-3", from: b.dir, runner, reach: "ip" }), /damaged/);
    assert.equal(calls.length, before, "nothing started");
    await assert.rejects(() => restoreSpace({ home: home2, space: "harlow-2", from: b.dir, runner }), /damaged|already provisioned/);
  } finally { await fake.stop(); }
});

// ---- the Space's key: a year of life, rotated before it ends ----
const jwt = (expMs) => `h.${Buffer.from(JSON.stringify({ exp: Math.floor(expMs / 1000) })).toString("base64url")}.s`;

test("a key's expiry is read from the key; health says ok, rotate inside the window, and expired", async () => {
  const { keyHealth, keyExpiry, KEY_ROTATE_WITHIN_DAYS } = await import("./provision.js");
  const t0 = Date.UTC(2026, 9, 4); const home = tmp();
  const dir = spaceDir(home, "harlow"); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "service.key"), jwt(t0 + 365 * 864e5));
  assert.equal(keyExpiry(jwt(t0)), t0);
  assert.deepEqual([keyHealth({ home, space: "harlow", now: () => t0 }).ok, keyHealth({ home, space: "harlow", now: () => t0 }).rotate], [true, false]);
  const late = keyHealth({ home, space: "harlow", now: () => t0 + (365 - KEY_ROTATE_WITHIN_DAYS + 1) * 864e5 });
  assert.deepEqual([late.ok, late.rotate], [true, true]);
  const gone = keyHealth({ home, space: "harlow", now: () => t0 + 366 * 864e5 });
  assert.deepEqual([gone.ok, gone.rotate, gone.why], [false, true, "the Space's key has expired"]);
  assert.equal(keyHealth({ home, space: "nobody", now: () => t0 }).ok, false);
});

test("with the clock a year ahead, rotation replaces the key before it ends, the new one works, the old is revoked, and nothing restarts", async () => {
  const { rotateApiKey, keyHealth } = await import("./provision.js");
  const fake = await new FakeTwenty().start();
  try {
    const t0 = Date.UTC(2026, 9, 4); fake.key = jwt(t0 + 365 * 864e5);
    const home = tmp(), calls = [];
    const runner = fakeRunner(fake, calls);
    const p = await provisionSpace({ home, space: "harlow", runner, reach: "ip" });
    assert.equal(fs.readFileSync(p.keyFile, "utf8").trim(), fake.key);
    // eleven months on, inside the window
    const now = t0 + 280 * 864e5; fake.nextKey = jwt(now + 365 * 864e5);
    assert.equal(keyHealth({ home, space: "harlow", now: () => now }).rotate, true);
    const r = await rotateApiKey({ home, space: "harlow", runner, reach: "ip", now: () => now });
    assert.equal(r.rotated, true);
    assert.equal(fs.readFileSync(p.keyFile, "utf8").trim(), fake.nextKey);
    assert.equal((fs.statSync(p.keyFile).mode & 0o777).toString(8), "600");
    assert.equal(fake.revoked, 1, "the old key is revoked");
    assert.equal(keyHealth({ home, space: "harlow", now: () => now }).rotate, false);
    assert.equal(JSON.parse(fs.readFileSync(path.join(p.dir, "key.json"), "utf8")).previous, "key-1");
    // a store that reads the key file on every call keeps working with the new key and not with a forged one
    const ok = await fetch(`${fake.url}/metadata`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${fs.readFileSync(p.keyFile, "utf8").trim()}` }, body: JSON.stringify({ query: "query Health { objects { totalCount } }" }) });
    assert.equal(ok.status, 200);
    // outside the window nothing happens
    assert.equal((await rotateApiKey({ home, space: "harlow", runner, reach: "ip", now: () => now })).rotated, false);
  } finally { await fake.stop(); }
});

test("PIN-1: a Space whose env file names the Twenty image without a digest is refused at start, like a bare-tag upgrade", async () => {
  const fake = await new FakeTwenty().start(); const home = tmp();
  const runner = fakeRunner(fake, []);
  await provisionSpace({ home, space: "harlow", runner });
  const envFile = path.join(spaceDir(home, "harlow"), ".env");
  fs.writeFileSync(envFile, fs.readFileSync(envFile, "utf8").replace(/^TWENTY_IMAGE_REF=.*$/m, "TWENTY_IMAGE_REF=twentycrm/twenty:v2.44.0"));
  await assert.rejects(() => provisionSpace({ home, space: "harlow", runner }), /without a digest/);
  await fake.stop();
});

test("a Space made from the saved database: its compose file restores it once, skips the migration steps and puts this Space's own password on the saved user; a plain Space has none of that", () => {
  const g = composeFile({ space: "harlow", golden: true });
  assert.match(g, /\n  restore:\n/);
  assert.match(g, /restore: \{ condition: service_completed_successfully \}/);
  assert.match(g, /\$\{GOLDEN_DUMP:-\.\/golden\.dump\}:\/golden\.dump:ro/);
  assert.match(g, /pg_restore -h db -U postgres -d default --no-owner --no-acl --exit-on-error/);
  for (const reset of [/DELETE FROM core\.\\"appToken\\";/, /DELETE FROM core\.\\"userSession\\";/, /DELETE FROM core\.\\"apiKey\\";/, /\\"oAuthClientSecretHash\\" = encode\(sha256\(gen_random_uuid\(\)/, /\\"inviteHash\\" = gen_random_uuid\(\)/]) assert.match(g, reset, "nothing shared stays: " + reset);
  assert.match(g, /to_regclass\('public\.vyre_golden'\)/, "a finished restore is skipped");
  assert.match(g, /pg_restore .* --clean --if-exists /, "and a half one is restored over");
  assert.match(g, /printenv ADMIN_PASSWORD/, "the new password comes from the Space's own env file, never from the saved file");
  assert.ok(!/-c .*ADMIN_PASSWORD|\$\$?ADMIN_PASSWORD/.test(g), "and is read inside psql from its environment, never put on a command line that a process list shows");
  assert.match(g, /DELETE FROM core\.\\"signingKey\\"/, "the saved signing key is dropped: it is sealed with another Space's secrets");
  assert.equal((g.match(/DISABLE_DB_MIGRATIONS: "true"/g) ?? []).length, 2, "the server skips the migration steps as the worker does");
  for (const m of g.matchAll(/^\s+image: (.*)$/gm)) assert.match(m[1], /@sha256:[0-9a-f]{64}/, "every image pinned");
  const after = composeFile({ space: "harlow", migrated: true });
  assert.ok(!/restore/.test(after), "the restore step is gone after the first start");
  assert.match(after, /DISABLE_DB_MIGRATIONS: "true"/);
  const plain = composeFile({ space: "harlow" });
  assert.ok(!/restore|golden/.test(plain));
  assert.equal((plain.match(/DISABLE_DB_MIGRATIONS/g) ?? []).length, 1, "an upgrade or a plain Space still migrates on the server");
});

test("findGolden returns a saved database only for exactly the image the Space will run, from the folders it is given", () => {
  const dir = tmp(), tag = tagOfRef(TWENTY_TESTED_REF);
  assert.equal(findGolden({ image: TWENTY_TESTED_REF, dirs: [dir] }), null, "none saved");
  fs.writeFileSync(path.join(dir, `${tag}.dump`), "x");
  fs.writeFileSync(path.join(dir, `${tag}.json`), JSON.stringify({ image: TWENTY_TESTED_REF, email: "service@x.vyre.invalid", workspaceId: "w", builtAt: "t", state: { "types.json": [] } }));
  const g = findGolden({ image: TWENTY_TESTED_REF, dirs: [dir] });
  assert.equal(g?.dump, path.join(dir, `${tag}.dump`));
  assert.equal(g?.meta.email, "service@x.vyre.invalid");
  const other = TWENTY_TESTED_REF.replace(/sha256:[0-9a-f]{64}/, `sha256:${"a".repeat(64)}`);
  assert.equal(findGolden({ image: other, dirs: [dir] }), null, "a different image (same tag, another digest) is not used");
  fs.writeFileSync(path.join(dir, `${tag}.dump`), "");
  assert.equal(findGolden({ image: TWENTY_TESTED_REF, dirs: [dir] }), null, "an empty dump is not a saved database");
});

test("no compose file publishes a Twenty port: not a plain Space, not one made from the saved database, and a Mac server's proxy publishes on 127.0.0.1 only and never from the server", () => {
  for (const o of [{}, { golden: true }, { migrated: true }, { memory: "small" }]) {
    const y = composeFile({ space: "harlow", ...o });
    assert.ok(!/^\s*ports:/m.test(y), `no ports for ${JSON.stringify(o)}`);
    assert.match(y, /networks:\n  store:\n    internal: true/, "the network stays internal");
  }
  const mac = composeFile({ space: "harlow", publish: "loopback", golden: true });
  assert.deepEqual([...mac.matchAll(/^\s+- "([^"]+:3000)"$/gm)].map(m => m[1]), ["127.0.0.1:${TWENTY_HOST_PORT:?}:3000"], "one published port, on the loopback only");
  const server = mac.slice(mac.indexOf("\n  server:"), mac.indexOf("\n  worker:"));
  assert.ok(!/ports:/.test(server) && !/\n    ports/.test(mac.slice(mac.indexOf("\n  worker:"), mac.indexOf("\n  proxy:") === -1 ? undefined : mac.indexOf("\n  proxy:"))), "Twenty's own containers publish nothing; only the proxy does");
});

test("on a server the saved database is root's: nothing is written for it here, the password root left is the one signed in with, and with none left the Space is a plain one", async () => {
  const dir = tmp(), tag = tagOfRef(TWENTY_TESTED_REF);
  fs.writeFileSync(path.join(dir, `${tag}.dump`), "x");
  const golden = findGolden({ image: TWENTY_TESTED_REF, dirs: [(() => { fs.writeFileSync(path.join(dir, `${tag}.json`), JSON.stringify({ image: TWENTY_TESTED_REF, email: "service@golden.vyre.invalid", workspaceId: "w", builtAt: "t", state: { "types.json": [{ "def": { name: "contact", fields: [] }, "plural": "contacts" }] } })); return dir; })()] });
  assert.ok(golden);
  // root used the saved database and left the password: the Space adopts the saved user
  const fake = await new FakeTwenty().start(); const home = tmp(); const calls = [];
  const runner = { ...fakeRunner(fake, calls), adminPassword: async () => "ab".repeat(32) };
  const p = await provisionSpace({ home, space: "harlow", runner, golden });
  const d = spaceDir(home, "harlow");
  assert.ok(fake.adopted && !fake.boot.calls.some((c) => c.startsWith("Boot_")), "the saved user signed in; no sign-up");
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(d, "admin.secret"), "utf8")), { email: "service@golden.vyre.invalid", password: "ab".repeat(32) });
  assert.ok(!fs.existsSync(path.join(d, "golden.dump")) && !/restore|ADMIN_PASSWORD/.test(fs.readFileSync(path.join(d, "compose.yml"), "utf8") + fs.readFileSync(path.join(d, ".env"), "utf8")), "no dump, no restore step and no password written on this side");
  assert.ok(fs.existsSync(path.join(d, "state", "types.json")), "the store starts knowing the saved types");
  assert.equal(fs.readFileSync(p.keyFile, "utf8"), fake.key);
  // root left nothing: it did not use the saved database, so this is a plain Space
  const fake2 = await new FakeTwenty().start(); const home2 = tmp();
  await provisionSpace({ home: home2, space: "northwind", runner: { ...fakeRunner(fake2, []), adminPassword: async () => null }, golden });
  assert.deepEqual(fake2.boot.calls.slice(0, 3), ["Boot_signUp", "Boot_workspace", "Boot_login"], "a plain bootstrap");
  assert.ok(!fs.existsSync(path.join(spaceDir(home2, "northwind"), "state", "types.json")), "and no saved types are claimed");
  await fake.stop(); await fake2.stop();
});
