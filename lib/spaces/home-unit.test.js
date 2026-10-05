// @ts-check
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { homeUnit, verifyUnit, sharedBetween, hostPortFor, VOLUME_ROLES, IMAGES } from "./home-unit.js";
import { TWENTY_TESTED_TAG } from "../../stores/twenty/provision.js";

/** Deterministic counter-based randomness: every call differs, every run is the same. */
const makeRandom = (/** @type {number} */ seed = 1) => { let c = seed; return (/** @type {number} */ n) => Uint8Array.from({ length: n }, () => (c = (c * 1103515245 + 12345) & 0xff)); };
const A = { id: "spc_harlow00001", name: "harlow" };
const B = { id: "spc_northwind002", name: "northwind" };

test("a unit is a compose project named per space, with the whole stack", () => {
  const u = homeUnit(A, { random: makeRandom() });
  assert.equal(u.project, "vyre-spc_harlow00001");
  assert.equal(u.compose.name, u.project);
  assert.deepEqual(Object.keys(u.compose.services).sort(), ["db", "redis", "twenty-server", "twenty-worker", "vyred"]);
  assert.match(u.compose.services["twenty-server"].image, /TWENTY_IMAGE/);
  assert.match(u.compose.services["twenty-server"].image, /twentycrm\/twenty:v[0-9.]+@sha256:[0-9a-f]{64}/);
});

test("headscale is optional and loopback only", () => {
  const u = homeUnit(A, { random: makeRandom(), headscale: true });
  assert.ok(u.compose.services.headscale);
  assert.ok(u.manifest.volumes.includes("vyre-spc_harlow00001-headscale"));
  assert.equal(verifyUnit(u.compose).ok, true);
  assert.equal(u.manifest.hostPorts.length, 2);
});

test("the manifest lists exactly the volumes and the keys directory", () => {
  const u = homeUnit(A, { random: makeRandom(), headscale: true });
  assert.deepEqual([...u.manifest.volumes].sort(), Object.keys(u.compose.volumes).sort());
  assert.equal(u.manifest.volumes.length, VOLUME_ROLES.length);
  assert.equal(u.manifest.keysVolume, "vyre-spc_harlow00001-keys");
  assert.equal(u.manifest.keysDir, "/keys");
  assert.ok(u.compose.services.vyred.volumes.some((/** @type {string} */ v) => v.endsWith(":/keys")));
});

test("a sound unit passes verifyUnit", () => {
  assert.deepEqual(verifyUnit(homeUnit(A, { random: makeRandom() }).compose), { ok: true, problems: [] });
});

test("secrets are generated into a 0600 env file and never inlined in the compose file", () => {
  const u = homeUnit(A, { random: makeRandom() });
  const envFile = u.files.find(f => f.path === ".env");
  assert.equal(envFile?.mode, 0o600);
  const compose = u.files.find(f => f.path === "compose.yml");
  for (const v of Object.values(u.env)) {
    assert.ok(envFile?.content.includes(v));
    assert.ok(!compose?.content.includes(v), "a secret is in the compose file");
    assert.match(v, /^[0-9a-f]{48}$/);
  }
  assert.equal(new Set(Object.values(u.env)).size, Object.keys(u.env).length);
});

test("TWENTY_IMAGE can be set through the env file, only as a full reference with a digest (PIN-1)", () => {
  const ref = `example.test/twenty:v9@sha256:${"c".repeat(64)}`;
  const u = homeUnit(A, { random: makeRandom(), twentyImage: ref });
  assert.ok(u.envText.includes(`TWENTY_IMAGE=${ref}`));
  assert.throws(() => homeUnit(A, { random: makeRandom(), twentyImage: "example.test/twenty:v9" }), /full reference with a digest/);
  assert.throws(() => homeUnit(A, { random: makeRandom(), twentyImage: "twentycrm/twenty:latest" }), /full reference with a digest/);
  // an env file written by hand that names an image without a digest is a problem the check reports, whatever the compose file says
  const ok = verifyUnit(u.compose, { envText: u.envText });
  assert.deepEqual(ok.problems, []);
  const bad = verifyUnit(u.compose, { envText: `${u.envText}TWENTY_IMAGE=twentycrm/twenty:v2.44.0\n` });
  assert.ok(bad.problems.some((x) => /TWENTY_IMAGE without a digest/.test(x)), bad.problems.join("; "));
  const naked = JSON.parse(JSON.stringify(u.compose)); naked.services["twenty-server"].image = "twentycrm/twenty:v2.44.0";
  assert.ok(verifyUnit(naked).problems.some((x) => /no digest/.test(x)));
});

test("two units on one host share no volume, network, port, container or secret", () => {
  const random = makeRandom();
  const a = homeUnit(A, { random, headscale: true }), b = homeUnit(B, { random, headscale: true });
  const s = sharedBetween(a, b);
  assert.deepEqual(s, { project: [], volumes: [], networks: [], ports: [], containers: [], secrets: [] });
  assert.notEqual(hostPortFor(A.id), hostPortFor(B.id));
  assert.equal(verifyUnit(a.compose).ok && verifyUnit(b.compose).ok, true);
});

test("the same unit twice shares everything (the check can fail)", () => {
  const a = homeUnit(A, { random: makeRandom(7) }), b = homeUnit(A, { random: makeRandom(7) });
  const s = sharedBetween(a, b);
  assert.ok(s.volumes.length && s.networks.length && s.ports.length && s.secrets.length && s.containers.length);
});

test("verifyUnit refuses the docker socket, privileged, host network, host paths, wide ports", () => {
  const mk = () => JSON.parse(JSON.stringify(homeUnit(A, { random: makeRandom() }).compose));
  const cases = /** @type {[string, (c: any) => void, RegExp][]} */ ([
    ["socket", c => c.services.vyred.volumes.push("/var/run/docker.sock:/var/run/docker.sock"), /docker socket/],
    ["privileged", c => { c.services.db.privileged = true; }, /privileged/],
    ["host network", c => { c.services.db.network_mode = "host"; }, /network mode/],
    ["host path", c => c.services.vyred.volumes.push("/srv/data:/data"), /host path/],
    ["wide port", c => { c.services.vyred.ports = ["0.0.0.0:7443:7443"]; }, /beyond loopback/],
    ["cap_add", c => { c.services.db.cap_add = ["NET_ADMIN"]; }, /capabilities/],
    ["writable root", c => { c.services.redis.read_only = false; }, /read-only/],
    ["no limits", c => { delete c.services.redis.mem_limit; }, /resource limits/],
    ["inline secret", c => { c.services.db.environment.POSTGRES_PASSWORD = "hunter2"; }, /secret/],
    ["foreign volume", c => c.services.vyred.volumes.push("vyre-other-log:/x"), /not part of this unit/],
    ["external network", c => { c.networks["vyre-spc_harlow00001-edge"].external = true; }, /external/],
    ["manifest drift", c => { c["x-vyre"].manifest.volumes.pop(); }, /manifest/],
    ["unpinned twenty", c => { c.services["twenty-server"].image = "twentycrm/twenty:latest"; }, /unpinned/],
    ["unprefixed volume", c => { c.volumes.shared = { name: "shared" }; }, /not named for this space/],
  ]);
  for (const [label, mutate, re] of cases) {
    const c = mk(); mutate(c);
    const r = verifyUnit(c);
    assert.equal(r.ok, false, label);
    assert.ok(r.problems.some(x => re.test(x)), `${label}: ${r.problems.join("|")}`);
  }
});

test("a bad space id is refused in plain words", () => {
  assert.throws(() => homeUnit({ id: "../etc" }, { random: makeRandom() }), /space id looks like/);
  assert.throws(() => homeUnit(A, /** @type {any} */ ({})), /random source/);
});

test("the home unit pins Twenty by tag and digest, to the release the live suite was run against", () => {
  const m = /twentycrm\/twenty:(v[0-9.]+)@sha256:[0-9a-f]{64}\}$/.exec(IMAGES.twenty);
  assert.ok(m, IMAGES.twenty);
  assert.equal(m[1], TWENTY_TESTED_TAG);
  assert.ok(!/placeholder/.test(IMAGES.twenty));
});

test("every image of a home unit but vyred's own is pinned by digest, and they are the images the live Twenty suite ran on", async () => {
  const { TWENTY_TESTED_REF, POSTGRES_IMAGE, REDIS_IMAGE } = await import("../../stores/twenty/provision.js");
  for (const [name, ref] of Object.entries(IMAGES)) if (name !== "vyre") assert.match(String(ref), /@sha256:[0-9a-f]{64}/, `${name} is not pinned by digest`);
  assert.ok(IMAGES.twenty.includes(TWENTY_TESTED_REF));
  assert.equal(IMAGES.postgres, POSTGRES_IMAGE);
  assert.equal(IMAGES.redis, REDIS_IMAGE);
});
