// @ts-check
// policy against a real create body: this drives DockerDriver.create() against the same fake
// Engine docker.test.js uses (a real POST is captured, not a hand-built fixture), so the two
// files agree on what a create body actually looks like without one of them drifting.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { DockerDriver } from "./docker.js";
import { allowCreate, allowExec, allowContainerOp, isComputerLabels, computerLabels } from "./policy.js";
import { SCRATCH } from "../../../test/scratch.mjs";
import { chromeEnv } from "../egress.js";

/** A one-request fake Engine: capture the create body it was actually sent, nothing else. */
async function capture(t) {
  const dir = fs.mkdtempSync(path.join(SCRATCH, "vyre-policy-"));
  const socket = path.join(dir, "d.sock");
  /** @type {any} */
  let body = null;
  const server = http.createServer(async (req, res) => {
    let raw = ""; for await (const c of req) raw += c;
    body = raw ? JSON.parse(raw) : undefined;
    res.writeHead(201, { "content-type": "application/json" });
    res.end(JSON.stringify({ Id: "c1" }));
  });
  await new Promise(r => server.listen(socket, () => r(undefined)));
  t.after(() => { server.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { socket, body: () => body };
}

const SPEC = {
  agent: "kit", image: "vyre/computer:0.1", network: "vyre-computers", cpus: 2, memoryMb: 3072, size: { w: 1440, h: 900 },
  env: { VNC_PASSWORD: "abcdefgh", COMPUTERD_TOKEN: "t0ken", SCREEN: "1440x900" },
  // Real deployments derive this from labelPrefix (pool.js's ensure()); docker.js itself just
  // takes whatever spec.volume says, so this fixture must already be the derived name for the
  // "run.vyre.computers" prefix realBody() configures below, the same way pool.js would build it.
  volume: "run.vyre.computers-home-kit",
};
const CONFIG = { network: "vyre-computers", image: "vyre/computer:0.1", labelPrefix: "run.vyre.computers" };

/** The real body docker.js sends for the box's own configured prefix, from a real driver call. */
async function realBody(t, opts = {}) {
  const e = await capture(t);
  const d = new DockerDriver({ bearer: "test-bearer", url: `unix://${e.socket}`, labelPrefix: "run.vyre.computers", network: "vyre-computers", ...opts });
  await d.create(SPEC);
  return e.body();
}

test("policy: allows exactly the body DockerDriver.create() actually sends", async t => {
  const body = await realBody(t);
  assert.deepEqual(allowCreate(body, CONFIG), { ok: true });
  assert.deepEqual(allowExec(body.Labels), { ok: true });
  assert.deepEqual(allowContainerOp(body.Labels), { ok: true });
  // The volume's own labels carry the same pair, and are checked too.
  assert.equal(isComputerLabels(body.HostConfig.Mounts[0].VolumeOptions.Labels), true);
  assert.equal(body.HostConfig.Mounts[0].Source, "run.vyre.computers-home-kit", "the derived name policy.js requires");
});

test("policy: allows the capAdd escape hatch when configured, and nothing beside it", async t => {
  const body = await realBody(t, { capAdd: ["SYS_NICE"] });
  assert.deepEqual(allowCreate(body, { ...CONFIG, capAdd: ["SYS_NICE"] }), { ok: true });
  // The same body, without that capability configured, is refused - config decides, not the body.
  assert.equal(allowCreate(body, CONFIG).ok, false);
});

test("policy: never a forbidden capability, even if a box misconfigures capAdd to ask for one", async t => {
  const body = await realBody(t, { capAdd: ["SYS_ADMIN"] });
  for (const cap of ["SYS_ADMIN", "SYS_PTRACE", "SYS_MODULE", "NET_ADMIN", "DAC_READ_SEARCH", "SYS_RAWIO"]) {
    assert.equal(allowCreate(body, { ...CONFIG, capAdd: [cap] }).ok, false, cap);
  }
});

/** A body that passes, then one field broken. */
async function mutate(t, patch) {
  const body = await realBody(t);
  return patch(structuredClone(body));
}

test("policy: refuses privileged, whatever else about the body is fine", async t => {
  const bad = await mutate(t, b => { b.HostConfig.Privileged = true; return b; });
  assert.equal(allowCreate(bad, CONFIG).ok, false);
});

test("policy: NetworkMode must be exactly the one configured computers network", async t => {
  assert.equal(allowCreate(await mutate(t, b => { b.HostConfig.NetworkMode = "host"; return b; }), CONFIG).ok, false);
  assert.equal(allowCreate(await mutate(t, b => { b.HostConfig.NetworkMode = "bridge"; return b; }), CONFIG).ok, false);
  assert.equal(allowCreate(await mutate(t, b => { b.HostConfig.NetworkMode = "container:vyre"; return b; }), CONFIG).ok, false, "joining another container's namespace");
  assert.equal(allowCreate(await mutate(t, b => { b.HostConfig.PidMode = "host"; return b; }), CONFIG).ok, false);
});

test("policy: refuses any bind mount, the docker socket most of all", async t => {
  const bind = await mutate(t, b => { b.HostConfig.Mounts = [{ Type: "bind", Source: "/", Target: "/host" }]; return b; });
  assert.equal(allowCreate(bind, CONFIG).ok, false);
  const sock = await mutate(t, b => { b.HostConfig.Mounts = [{ ...b.HostConfig.Mounts[0], Type: "bind", Source: "/var/run/docker.sock" }]; return b; });
  assert.equal(allowCreate(sock, CONFIG).ok, false);
  const extra = await mutate(t, b => { b.HostConfig.Mounts.push({ Type: "bind", Source: "/etc", Target: "/etc" }); return b; });
  assert.equal(allowCreate(extra, CONFIG).ok, false, "a second, extra mount is refused even if the first is fine");
});

test("policy: the label prefix is the box's own config, never the caller's choice", async t => {
  // A caller picking its own prefix would also pick the volume Source derived from it.
  const own = await mutate(t, b => {
    b.Labels = { "attacker.managed": "true", "attacker.computer": "kit", "run.vyre": "1" };
    b.HostConfig.Mounts[0].Source = "attacker-home-kit";
    b.HostConfig.Mounts[0].VolumeOptions.Labels = { ...b.Labels };
    return b;
  });
  assert.equal(allowCreate(own, CONFIG).ok, false);
  // A body naming the box's real prefix AND a second, different one is not silently resolved by
  // matching only the first pair .find() would see - it is refused outright.
  const ambiguous = await mutate(t, b => { b.Labels["sneaky.managed"] = "true"; b.Labels["sneaky.computer"] = "pax"; return b; });
  assert.equal(allowCreate(ambiguous, CONFIG).ok, false);
});

test("policy: Source must be the derived name, not any volume the labels happen to also name", async t => {
  // The real hole this closes: an existing volume's own labels are ignored by Docker once it
  // already exists, so naming one directly (vyred's own home, or another agent's) would mount it
  // regardless of what this body's Labels or VolumeOptions.Labels claim.
  const other = await mutate(t, b => { b.HostConfig.Mounts[0].Source = "vyre-home"; return b; });
  assert.equal(allowCreate(other, CONFIG).ok, false, "vyred's own home volume, named directly");
  const pax = await mutate(t, b => { b.HostConfig.Mounts[0].Source = "run.vyre.computers-home-pax"; return b; });
  assert.equal(allowCreate(pax, CONFIG).ok, false, "another agent's home volume, named directly");
});

test("policy: refuses a capability, a device, a non-read-only root, or an unknown field", async t => {
  assert.equal(allowCreate(await mutate(t, b => { b.HostConfig.CapDrop = []; return b; }), CONFIG).ok, false);
  assert.equal(allowCreate(await mutate(t, b => { b.HostConfig.Devices = ["/dev/kvm"]; return b; }), CONFIG).ok, false);
  assert.equal(allowCreate(await mutate(t, b => { b.HostConfig.ReadonlyRootfs = false; return b; }), CONFIG).ok, false);
  assert.equal(allowCreate(await mutate(t, b => { b.HostConfig.Sysctls = { "net.ipv4.ip_forward": "1" }; return b; }), CONFIG).ok, false, "an unknown HostConfig key");
  assert.equal(allowCreate(await mutate(t, b => { b.Cmd = ["sh"]; return b; }), CONFIG).ok, false, "an unknown top-level key");
  assert.equal(allowCreate(await mutate(t, b => { b.HostConfig.Tmpfs["/etc"] = "mode=1777"; return b; }), CONFIG).ok, false, "a tmpfs path outside the allowed three");
});

test("policy: Image must be exactly the box's configured image", async t => {
  const body = await realBody(t);
  assert.equal(allowCreate(body, { ...CONFIG, image: "vyre/computer:9.9" }).ok, false);
  const own = await mutate(t, b => { b.Image = "attacker/whatever:latest"; return b; });
  assert.equal(allowCreate(own, CONFIG).ok, false, "a direct caller's own image");
});

test("policy: refuses a mount that is a volume but not the agent's home, and one missing the label pair", async t => {
  assert.equal(allowCreate(await mutate(t, b => { b.HostConfig.Mounts[0].Target = "/"; return b; }), CONFIG).ok, false);
  assert.equal(allowCreate(await mutate(t, b => { delete b.HostConfig.Mounts[0].VolumeOptions.Labels["run.vyre.computers.managed"]; return b; }), CONFIG).ok, false);
});

test("policy: exec and the other container ops never reach vyred's own container, docker-api's, or a random one", async t => {
  // The fixed run.vyre=1 marker box's own infra carries, without the managed/computer pair.
  assert.equal(allowExec({ "run.vyre": "1" }).ok, false);
  assert.equal(allowExec({ "run.vyre": "1" }, ["sh"]).ok, false);
  assert.equal(allowExec({ "com.example.app": "postgres" }).ok, false);
  assert.equal(allowExec({}).ok, false);
  assert.equal(allowContainerOp({ "run.vyre": "1" }).ok, false);
});

test("policy: exec's cmd must be a list of strings when given at all", async t => {
  const body = await realBody(t);
  assert.equal(allowExec(body.Labels, ["bash", "-c", "id"]).ok, true);
  assert.equal(allowExec(body.Labels, "bash").ok, false);
  assert.equal(allowExec(body.Labels, [1, 2]).ok, false);
});

test("policy: computerLabels ties the managed and computer keys to the same prefix, and names the agent", () => {
  assert.equal(computerLabels({ "run.vyre": "1", "a.managed": "true", "b.computer": "kit" }), null, "mismatched prefixes");
  assert.deepEqual(computerLabels({ "run.vyre": "1", "vyre.managed": "true", "vyre.computer": "kit" }), { prefix: "vyre", agent: "kit" });
  assert.equal(computerLabels({ "vyre.managed": "true", "vyre.computer": "kit" }), null, "missing the fixed run.vyre marker");
  assert.equal(computerLabels(null), null);
  assert.equal(isComputerLabels({ "run.vyre": "1", "vyre.managed": "true", "vyre.computer": "kit" }), true);
});

test("policy: allowCreate needs the box's own network, image and labelPrefix, and never trusts the request for any of them", () => {
  assert.throws(() => allowCreate({}, {}), /computers\.network|computers\.image|computers\.labelPrefix/);
  assert.throws(() => allowCreate({}, { network: "vyre-computers", image: "vyre/computer:0.1" }), /labelPrefix/);
  assert.throws(() => allowCreate({}, undefined));
});

test("policy: a create carrying the egress PAC passes unchanged, with no other field widened", async t => {
  const e = await capture(t);
  const d = new DockerDriver({ bearer: "test-bearer", url: `unix://${e.socket}`, labelPrefix: "run.vyre.computers", network: "vyre-computers" });
  const env = { ...SPEC.env, ...chromeEnv({ enabled: true, sites: ["bank.example.com", "*.harlow.example"] }) };
  await d.create({ ...SPEC, env });
  const body = e.body();
  assert.ok(body.Env.some(x => x.startsWith("VYRE_PROXY_PAC=data:application/x-ns-proxy-autoconfig;base64,")));
  assert.deepEqual(allowCreate(body, CONFIG), { ok: true });
  // The PAC travels in Env alone: the rest of the body is what a create without it sends.
  const plain = await realBody(t);
  assert.deepEqual({ ...body, Env: null }, { ...plain, Env: null });
});
