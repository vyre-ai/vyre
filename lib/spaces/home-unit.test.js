// @ts-check
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { homeUnit, verifyUnit, sharedBetween, hostPortFor, VOLUME_ROLES, IMAGES, PINNED } from "./home-unit.js";

/** Deterministic counter-based randomness: every call differs, every run is the same. */
const makeRandom = (/** @type {number} */ seed = 1) => { let c = seed; return (/** @type {number} */ n) => Uint8Array.from({ length: n }, () => (c = (c * 1103515245 + 12345) & 0xff)); };
const A = { id: "spc_harlow00001", name: "harlow" };
const B = { id: "spc_northwind002", name: "northwind" };

test("a unit is a compose project named per space, with vyred and the PDF converter", () => {
  const u = homeUnit(A, { random: makeRandom() });
  assert.equal(u.project, "vyre-spc_harlow00001");
  assert.equal(u.compose.name, u.project);
  assert.deepEqual(Object.keys(u.compose.services).sort(), ["gotenberg", "vyred"]);
  const g = u.compose.services.gotenberg;
  assert.match(g.image, /^gotenberg\/gotenberg:[0-9.]+@sha256:[0-9a-f]{64}$/, "the PDF converter is pinned by tag and digest");
  assert.equal(g.ports, undefined, "and publishes no port");
  assert.deepEqual(g.networks.length, 1, "on the internal network only, which has no way out");
  assert.equal(u.compose.networks[g.networks[0]].internal, true);
  assert.equal(u.compose.services.vyred.environment.VYRE_DOCUMENTS_PDF, "http://gotenberg:3000", "vyred is told where it is: PDF works with no config");
  assert.equal(u.compose.services.vyred.depends_on, undefined);
});

test("a space's unit carries no Headscale: the Wink network is the computer's own (core/wink/netd.js)", () => {
  const u = homeUnit(A, { random: makeRandom() });
  assert.equal(u.compose.services.headscale, undefined);
  assert.ok(!u.manifest.volumes.some((/** @type {string} */ v) => /headscale/.test(v)));
  assert.equal(u.manifest.hostPorts.length, 1);
});

test("the manifest lists exactly the volumes and the keys directory", () => {
  const u = homeUnit(A, { random: makeRandom() });
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

test("an image named in the env file needs a digest", () => {
  const u = homeUnit(A, { random: makeRandom() });
  const ok = verifyUnit(u.compose, { envText: u.envText });
  assert.deepEqual(ok.problems, []);
  const ref = `example.test/pdf:v9@sha256:${"c".repeat(64)}`;
  const good = verifyUnit(u.compose, { envText: `${u.envText}PDF_IMAGE=${ref}\n` });
  assert.deepEqual(good.problems, []);
  const bad = verifyUnit(u.compose, { envText: `${u.envText}PDF_IMAGE=example.test/pdf:v9\n` });
  assert.ok(bad.problems.some((x) => /PDF_IMAGE without a digest/.test(x)), bad.problems.join("; "));
  const naked = JSON.parse(JSON.stringify(u.compose)); naked.services.gotenberg.image = "gotenberg/gotenberg:8.37.0";
  assert.ok(verifyUnit(naked).problems.some((x) => /no digest/.test(x)));
});

test("two units on one host share no volume, network, port, container or secret", () => {
  const random = makeRandom();
  const a = homeUnit(A, { random }), b = homeUnit(B, { random });
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
    ["privileged", c => { c.services.gotenberg.privileged = true; }, /privileged/],
    ["host network", c => { c.services.gotenberg.network_mode = "host"; }, /network mode/],
    ["host path", c => c.services.vyred.volumes.push("/srv/data:/data"), /host path/],
    ["wide port", c => { c.services.vyred.ports = ["0.0.0.0:7443:7443"]; }, /beyond loopback/],
    ["cap_add", c => { c.services.gotenberg.cap_add = ["NET_ADMIN"]; }, /capabilities/],
    ["writable root", c => { c.services.gotenberg.read_only = false; }, /read-only/],
    ["no limits", c => { delete c.services.gotenberg.mem_limit; }, /resource limits/],
    ["inline secret", c => { c.services.vyred.environment.VYRE_UNIT_TOKEN = "hunter2"; }, /secret/],
    ["foreign volume", c => c.services.vyred.volumes.push("vyre-other-log:/x"), /not part of this unit/],
    ["external network", c => { c.networks["vyre-spc_harlow00001-edge"].external = true; }, /external/],
    ["manifest drift", c => { c["x-vyre"].manifest.volumes.pop(); }, /manifest/],
    ["unpinned converter", c => { c.services.gotenberg.image = "gotenberg/gotenberg:latest"; }, /unpinned/],
    ["unprefixed volume", c => { c.volumes.shared = { name: "shared" }; c.services.vyred.volumes.push("shared:/x"); }, /not named for this space/],
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

test("every image of a home unit but vyred's own is pinned by digest", () => {
  for (const [name, ref] of Object.entries(IMAGES)) if (name !== "vyre") assert.ok(PINNED.test(String(ref)), `${name} is not pinned by digest: ${ref}`);
  assert.match(IMAGES.gotenberg, /@sha256:[0-9a-f]{64}/);
});
