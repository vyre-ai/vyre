// @ts-check
// policy against a real create body: this drives DockerDriver.create() against the same fake
// Engine docker.test.js uses (a real POST is captured, not a hand-built fixture), so the two
// files agree on what a create body actually looks like without one of them drifting.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { DockerDriver } from "./docker.js";
import { allowCreate, allowExec, allowContainerOp, isComputerLabels } from "./policy.js";

/** A one-request fake Engine: capture the create body it was actually sent, nothing else. */
async function capture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vyre-policy-"));
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
  env: { VNC_PASSWORD: "abcdefgh", COMPUTERD_TOKEN: "t0ken", SCREEN: "1440x900" }, volume: "vyre-home-kit",
};

/** The real body docker.js sends for the box's own configured prefix, from a real driver call. */
async function realBody(t, opts = {}) {
  const e = await capture(t);
  const d = new DockerDriver({ url: `unix://${e.socket}`, labelPrefix: "run.vyre.computers", network: "vyre-computers", ...opts });
  await d.create(SPEC);
  return e.body();
}

test("policy: allows exactly the body DockerDriver.create() actually sends", async t => {
  const body = await realBody(t);
  assert.deepEqual(allowCreate(body), { ok: true });
  assert.deepEqual(allowExec(body.Labels), { ok: true });
  assert.deepEqual(allowContainerOp(body.Labels), { ok: true });
  // The volume's own labels carry the same pair, and are checked too.
  assert.equal(isComputerLabels(body.HostConfig.Mounts[0].VolumeOptions.Labels), true);
});

test("policy: allows the capAdd escape hatch, and nothing else added beside it", async t => {
  const body = await realBody(t, { capAdd: ["SYS_NICE"] });
  assert.deepEqual(allowCreate(body), { ok: true });
});

/** A body that passes, then one field broken. */
async function mutate(t, patch) {
  const body = await realBody(t);
  return patch(structuredClone(body));
}

test("policy: refuses privileged, whatever else about the body is fine", async t => {
  const bad = await mutate(t, b => { b.HostConfig.Privileged = true; return b; });
  assert.equal(allowCreate(bad).ok, false);
});

test("policy: refuses host network and much for free host PID", async t => {
  const net = await mutate(t, b => { b.HostConfig.NetworkMode = "host"; return b; });
  assert.equal(allowCreate(net).ok, false);
  const pid = await mutate(t, b => { b.HostConfig.PidMode = "host"; return b; });
  assert.equal(allowCreate(pid).ok, false);
});

test("policy: refuses any bind mount, the docker socket most of all", async t => {
  const bind = await mutate(t, b => { b.HostConfig.Mounts = [{ Type: "bind", Source: "/", Target: "/host" }]; return b; });
  assert.equal(allowCreate(bind).ok, false);
  const sock = await mutate(t, b => { b.HostConfig.Mounts = [{ ...b.HostConfig.Mounts[0], Type: "bind", Source: "/var/run/docker.sock" }]; return b; });
  assert.equal(allowCreate(sock).ok, false);
  const extra = await mutate(t, b => { b.HostConfig.Mounts.push({ Type: "bind", Source: "/etc", Target: "/etc" }); return b; });
  assert.equal(allowCreate(extra).ok, false, "a second, extra mount is refused even if the first is fine");
});

test("policy: refuses a capability, a device, a non-read-only root, or an unknown field", async t => {
  assert.equal(allowCreate(await mutate(t, b => { b.HostConfig.CapDrop = []; return b; })).ok, false);
  assert.equal(allowCreate(await mutate(t, b => { b.HostConfig.Devices = ["/dev/kvm"]; return b; })).ok, false);
  assert.equal(allowCreate(await mutate(t, b => { b.HostConfig.ReadonlyRootfs = false; return b; })).ok, false);
  assert.equal(allowCreate(await mutate(t, b => { b.HostConfig.Sysctls = { "net.ipv4.ip_forward": "1" }; return b; })).ok, false, "an unknown HostConfig key");
  assert.equal(allowCreate(await mutate(t, b => { b.Cmd = ["sh"]; return b; })).ok, false, "an unknown top-level key");
  assert.equal(allowCreate(await mutate(t, b => { b.HostConfig.Tmpfs["/etc"] = "mode=1777"; return b; })).ok, false, "a tmpfs path outside the allowed three");
});

test("policy: refuses a mount that is a volume but not the agent's home, and one missing the label pair", async t => {
  assert.equal(allowCreate(await mutate(t, b => { b.HostConfig.Mounts[0].Target = "/"; return b; })).ok, false);
  assert.equal(allowCreate(await mutate(t, b => { delete b.HostConfig.Mounts[0].VolumeOptions.Labels["run.vyre.computers.managed"]; return b; })).ok, false);
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

test("policy: isComputerLabels ties the managed and computer keys to the same prefix", () => {
  assert.equal(isComputerLabels({ "run.vyre": "1", "a.managed": "true", "b.computer": "kit" }), false, "mismatched prefixes");
  assert.equal(isComputerLabels({ "run.vyre": "1", "vyre.managed": "true", "vyre.computer": "kit" }), true);
  assert.equal(isComputerLabels({ "vyre.managed": "true", "vyre.computer": "kit" }), false, "missing the fixed run.vyre marker");
  assert.equal(isComputerLabels(null), false);
});
