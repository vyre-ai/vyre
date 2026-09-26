// @ts-check
// The Docker driver against a fake Engine API on a unix socket. There is no Docker here, and a
// test that needed one would not run in CI either, so what is checked is exactly what the proxy
// would receive, and that a container without our labels is refused before any request that
// changes it is sent.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { DockerDriver } from "./docker.js";

/** A fake Engine: two containers of ours to be, and one that is someone else's database. */
async function engine(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vyre-docker-"));
  const socket = path.join(dir, "d.sock");
  /** @type {Array<{ method: string, path: string, body: any }>} */
  const seen = [];
  /** @type {Map<string, any>} */
  const boxes = new Map([
    ["db1", { Id: "db1", Name: "/postgres", Config: { Labels: { "com.example.app": "db" } }, State: { Status: "running" }, NetworkSettings: { Networks: {} } }],
    ["half", { Id: "half", Name: "/half", Config: { Labels: { "vyre.managed": "true" } }, State: { Status: "running" }, NetworkSettings: { Networks: {} } }],
  ]);
  const server = http.createServer(async (req, res) => {
    let raw = "";
    for await (const c of req) raw += c;
    const body = raw ? JSON.parse(raw) : undefined;
    seen.push({ method: String(req.method), path: String(req.url), body });
    const send = (status, b) => { res.writeHead(status, { "content-type": "application/json" }); res.end(b === undefined ? "" : JSON.stringify(b)); };
    const url = new URL(String(req.url), "http://d");
    let m;
    if (req.method === "POST" && url.pathname === "/v1.43/containers/create") {
      const id = "c" + (boxes.size + 1);
      boxes.set(id, { Id: id, Name: "/" + url.searchParams.get("name"), Config: { Labels: body.Labels }, State: { Status: "created" },
        NetworkSettings: { Networks: { [body.HostConfig.NetworkMode]: { IPAddress: "172.20.0.5" } } } });
      return send(201, { Id: id, Warnings: [] });
    }
    if (req.method === "GET" && url.pathname === "/v1.43/containers/json") {
      return send(200, [...boxes.values()].map(b => ({ Id: b.Id, Labels: b.Config.Labels, State: b.State.Status })));
    }
    if ((m = /^\/v1\.43\/containers\/([^/]+)\/json$/.exec(url.pathname))) {
      const b = boxes.get(m[1]);
      return b ? send(200, b) : send(404, { message: `No such container: ${m[1]}` });
    }
    if (req.method === "POST" && (m = /^\/v1\.43\/containers\/([^/]+)\/(start|pause|unpause|stop)$/.exec(url.pathname))) {
      const b = boxes.get(m[1]);
      if (!b) return send(404, { message: "no such container" });
      b.State.Status = { start: "running", pause: "paused", unpause: "running", stop: "exited" }[m[2]];
      return send(204);
    }
    if (req.method === "DELETE" && (m = /^\/v1\.43\/containers\/([^/]+)$/.exec(url.pathname))) { boxes.delete(m[1]); return send(204); }
    send(404, { message: "page not found" });
  });
  await new Promise(r => server.listen(socket, () => r(undefined)));
  t.after(() => { server.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { socket, seen, boxes };
}

const spec = {
  agent: "kit", image: "vyre/computer:0.1", network: "vyre-computers", cpus: 2, memoryMb: 3072, size: { w: 1440, h: 900 },
  env: { VNC_PASSWORD: "abcdefgh", COMPUTERD_TOKEN: "t0ken", SCREEN: "1440x900" },
  labels: { "vyre.computer": "kit", "vyre.managed": "true" }, volume: "vyre-home-kit",
};

test("docker: create sends exactly the container Vyre means, and nothing is published", async t => {
  const e = await engine(t);
  const d = new DockerDriver({ url: `unix://${e.socket}`, labelPrefix: "vyre", network: "vyre-computers" });
  const { id } = await d.create(spec);
  assert.equal(id, "c3");
  assert.equal(e.seen.length, 1);
  const r = e.seen[0];
  assert.equal(r.method, "POST");
  assert.equal(r.path, "/v1.43/containers/create?name=vyre-computer-kit");
  assert.deepEqual(r.body, {
    Image: "vyre/computer:0.1",
    Hostname: "kit",
    Env: ["VNC_PASSWORD=abcdefgh", "COMPUTERD_TOKEN=t0ken", "SCREEN=1440x900"],
    Labels: { "vyre.computer": "kit", "vyre.managed": "true", "run.vyre": "1" },
    ExposedPorts: { "5900/tcp": {}, "7000/tcp": {} },
    HostConfig: {
      NetworkMode: "vyre-computers",
      PidMode: "container",
      NanoCpus: 2_000_000_000,
      Memory: 3072 * 1024 * 1024,
      PortBindings: {},
      PublishAllPorts: false,
      Privileged: false,
      CapDrop: ["ALL"],
      Devices: [],
      SecurityOpt: ["no-new-privileges"],
      ReadonlyRootfs: true,
      Tmpfs: { "/tmp": "mode=1777,exec", "/run": "mode=0755", "/var/run": "mode=0755" },
      ShmSize: 1024 * 1024 * 1024,
      Mounts: [{ Type: "volume", Source: "vyre-home-kit", Target: "/home/agent", VolumeOptions: { Labels: { "vyre.managed": "true", "vyre.computer": "kit", "run.vyre": "1" } } }],
      RestartPolicy: { Name: "no" },
    },
  });
});

test("docker: never privileged, never a host mount, never host network or PID, always read-only", async t => {
  const e = await engine(t);
  const d = new DockerDriver({ url: `unix://${e.socket}`, labelPrefix: "vyre", network: "vyre-computers" });
  await d.create(spec);
  const body = e.seen[0].body;
  assert.equal(body.HostConfig.Privileged, false);
  assert.equal(body.HostConfig.PidMode, "container");
  assert.notEqual(body.HostConfig.NetworkMode, "host");
  assert.deepEqual(body.HostConfig.CapDrop, ["ALL"]);
  assert.deepEqual(body.HostConfig.Devices, []);
  assert.equal(body.HostConfig.ReadonlyRootfs, true);
  assert.ok(body.HostConfig.Tmpfs && Object.keys(body.HostConfig.Tmpfs).length > 0, "a read-only root needs somewhere to write");
  // The only mount is the agent's own named volume: never a bind, and never the docker socket.
  assert.equal(body.HostConfig.Mounts.length, 1);
  for (const m of body.HostConfig.Mounts) {
    assert.equal(m.Type, "volume", "no bind mount ever reaches a create body");
    assert.doesNotMatch(String(m.Source), /docker\.sock/);
    assert.doesNotMatch(String(m.Target), /docker\.sock/);
  }
  assert.doesNotMatch(JSON.stringify(body), /\/var\/run\/docker\.sock/, "the docker socket must never appear anywhere in a create body");
});

test("docker: a computer is refused the host network, whatever config or a caller asks for", async t => {
  const e = await engine(t);
  const d = new DockerDriver({ url: `unix://${e.socket}`, labelPrefix: "vyre" });
  await assert.rejects(d.create({ ...spec, network: "host" }), /never runs on the host network/);
  const onHost = new DockerDriver({ url: `unix://${e.socket}`, labelPrefix: "vyre", network: "host" });
  await assert.rejects(onHost.create({ ...spec, network: undefined }), /never runs on the host network/);
});

test("docker: run.vyre=1 marks every container and its volume, alongside the prefix labels", async t => {
  const e = await engine(t);
  const d = new DockerDriver({ url: `unix://${e.socket}`, labelPrefix: "run.vyre.computers", network: "vyre-computers" });
  await d.create({ ...spec, labels: { "run.vyre.computers.computer": "kit", "run.vyre.computers.managed": "true" } });
  const body = e.seen[0].body;
  assert.equal(body.Labels["run.vyre"], "1");
  assert.equal(body.Labels["run.vyre.computers.computer"], "kit");
  assert.equal(body.HostConfig.Mounts[0].VolumeOptions.Labels["run.vyre"], "1");
});

test("docker: every operation reads the labels first, then acts", async t => {
  const e = await engine(t);
  const d = new DockerDriver({ url: `unix://${e.socket}`, labelPrefix: "vyre", network: "vyre-computers" });
  const { id } = await d.create(spec);
  e.seen.length = 0;
  await d.start(id);
  await d.pause(id);
  assert.deepEqual(await d.inspect(id), { state: "paused", host: "172.20.0.5" });
  await d.unpause(id);
  await d.stop(id);
  await d.remove(id);
  assert.deepEqual(await d.inspect(id), { state: "missing", host: null });
  assert.deepEqual(e.seen.map(r => `${r.method} ${r.path}`), [
    `GET /v1.43/containers/${id}/json`, `POST /v1.43/containers/${id}/start`,
    `GET /v1.43/containers/${id}/json`, `POST /v1.43/containers/${id}/pause`,
    `GET /v1.43/containers/${id}/json`,
    `GET /v1.43/containers/${id}/json`, `POST /v1.43/containers/${id}/unpause`,
    `GET /v1.43/containers/${id}/json`, `POST /v1.43/containers/${id}/stop?t=10`,
    `GET /v1.43/containers/${id}/json`, `DELETE /v1.43/containers/${id}?v=false&force=true`,
    `GET /v1.43/containers/${id}/json`,
  ]);
});

test("docker: a container without both labels is refused, whatever the proxy would allow", async t => {
  const e = await engine(t);
  const d = new DockerDriver({ url: `unix://${e.socket}` });
  for (const id of ["db1", "half"]) {
    for (const op of ["start", "pause", "unpause", "stop", "remove", "inspect"]) {
      await assert.rejects(/** @type {any} */ (d)[op](id), /refuses to touch it/, `${op} ${id}`);
    }
  }
  assert.ok(e.seen.every(r => r.method === "GET"), "a refused container still got a request that changes it");
  assert.equal(e.boxes.get("db1").State.Status, "running");
});

test("docker: list returns only managed computers, with the agent from the label", async t => {
  const e = await engine(t);
  const d = new DockerDriver({ url: `unix://${e.socket}` });
  const { id } = await d.create(spec);
  e.seen.length = 0;
  assert.deepEqual(await d.list(), [{ id, agent: "kit", state: "exited" }]);
  const r = e.seen[0];
  assert.equal(r.method, "GET");
  const url = new URL(r.path, "http://d");
  assert.equal(url.pathname, "/v1.43/containers/json");
  assert.equal(url.searchParams.get("all"), "true");
  assert.deepEqual(JSON.parse(String(url.searchParams.get("filters"))), { label: ["vyre.managed=true"] });
});

test("docker: an Engine error names the request, never the body with the passwords", async t => {
  const e = await engine(t);
  const d = new DockerDriver({ url: `unix://${e.socket}` });
  await assert.rejects(d.start("nope"), /no such container: nope/);
  await assert.rejects(d.create({ ...spec, agent: "Bad Name" }), /not an agent name/);
  const bad = new DockerDriver({ url: `unix://${path.join(os.tmpdir(), "no-such-vyre-docker.sock")}` });
  await assert.rejects(bad.create(spec), err => { assert.doesNotMatch(String(err), /abcdefgh|t0ken/); return true; });
});

test("docker: needs a proxy URL, http or unix, and never assumes the raw socket", () => {
  assert.throws(() => new DockerDriver(/** @type {any} */ ({})), /computers.docker/);
  assert.throws(() => new DockerDriver({ url: "https://proxy:2375" }), /http:\/\/host:port or unix/);
  const d = new DockerDriver({ url: "http://docker-proxy:2375" });
  assert.deepEqual(d.target, { host: "docker-proxy", port: 2375 });
});

test("docker: works over TCP to a proxy too", async t => {
  const seen = [];
  const server = http.createServer((req, res) => { seen.push(`${req.method} ${req.url}`); res.writeHead(200, { "content-type": "application/json" }); res.end("[]"); });
  await new Promise(r => server.listen(0, "127.0.0.1", () => r(undefined)));
  t.after(() => server.close());
  const addr = /** @type {import("node:net").AddressInfo} */ (server.address());
  const d = new DockerDriver({ url: `http://127.0.0.1:${addr.port}` });
  assert.deepEqual(await d.list(), []);
  assert.match(seen[0], /^GET \/v1\.43\/containers\/json\?all=true/);
});
