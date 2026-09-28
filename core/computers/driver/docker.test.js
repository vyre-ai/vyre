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
import { allowBootTar, allowAgentTokensTar } from "./policy.js";
import { SCRATCH } from "../../../test/scratch.mjs";

/** A fake Engine: two containers of ours to be, and one that is someone else's database. */
async function engine(t) {
  const dir = fs.mkdtempSync(path.join(SCRATCH, "vyre-docker-"));
  const socket = path.join(dir, "d.sock");
  /** @type {Array<{ method: string, path: string, body: any }>} */
  const seen = [];
  /** @type {Map<string, any>} */
  const boxes = new Map([
    ["db1", { Id: "db1", Name: "/postgres", Config: { Labels: { "com.example.app": "db" } }, State: { Status: "running" }, NetworkSettings: { Networks: {} } }],
    ["half", { Id: "half", Name: "/half", Config: { Labels: { "vyre.managed": "true" } }, State: { Status: "running" }, NetworkSettings: { Networks: {} } }],
  ]);
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const buf = Buffer.concat(chunks);
    const tar = req.headers["content-type"] === "application/x-tar";
    const body = tar ? buf : buf.length ? JSON.parse(buf.toString("utf8")) : undefined;
    seen.push({ method: String(req.method), path: String(req.url), body, authorization: req.headers.authorization });
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
    if (req.method === "PUT" && (m = /^\/v1\.43\/containers\/([^/]+)\/archive$/.exec(url.pathname))) return send(boxes.has(m[1]) ? 200 : 404);
    send(404, { message: "page not found" });
  });
  await new Promise(r => server.listen(socket, () => r(undefined)));
  t.after(() => { server.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { socket, seen, boxes };
}

const spec = {
  agent: "kit", image: "vyre/computer:0.1", network: "vyre-computers", cpus: 2, memoryMb: 3072, size: { w: 1440, h: 900 },
  env: { SCREEN: "1440x900" },
  labels: { "vyre.computer": "kit", "vyre.managed": "true" }, volume: "vyre-home-kit",
};

test("docker: create sends exactly the container Vyre means, and nothing is published", async t => {
  const e = await engine(t);
  const d = new DockerDriver({ bearer: "test-bearer", url: `unix://${e.socket}`, labelPrefix: "vyre", network: "vyre-computers" });
  const { id } = await d.create(spec);
  assert.equal(id, "c3");
  assert.equal(e.seen.length, 1);
  const r = e.seen[0];
  assert.equal(r.method, "POST");
  assert.equal(r.path, "/v1.43/containers/create?name=vyre-computer-kit");
  assert.equal(r.authorization, "Bearer test-bearer", "every request to the proxy carries the bearer");
  assert.deepEqual(r.body, {
    Image: "vyre/computer:0.1",
    Hostname: "kit",
    Env: ["SCREEN=1440x900"],
    Labels: { "vyre.computer": "kit", "vyre.managed": "true", "run.vyre": "1" },
    ExposedPorts: { "5900/tcp": {}, "7000/tcp": {} },
    HostConfig: {
      NetworkMode: "vyre-computers",
      PidMode: "",
      NanoCpus: 2_000_000_000,
      Memory: 3072 * 1024 * 1024,
      PortBindings: {},
      PublishAllPorts: false,
      Privileged: false,
      CapDrop: ["ALL"],
      CapAdd: ["SETUID", "SETGID"],
      Devices: [],
      SecurityOpt: ["no-new-privileges"],
      ReadonlyRootfs: true,
      Tmpfs: { "/tmp": "mode=1777,exec", "/run": "mode=0755", "/var/run": "mode=0755" },
      ShmSize: 1024 * 1024 * 1024,
      Mounts: [
        { Type: "volume", Source: "vyre-home-kit", Target: "/home/agent", VolumeOptions: { Labels: { "vyre.managed": "true", "vyre.computer": "kit", "run.vyre": "1" } } },
        { Type: "volume", Source: "vyre-browser-kit", Target: "/var/lib/vyre", VolumeOptions: { Labels: { "vyre.managed": "true", "vyre.computer": "kit", "run.vyre": "1" } } },
      ],
      RestartPolicy: { Name: "no" },
    },
  });
});

test("docker: never privileged, never a host mount, never host network or PID, always read-only", async t => {
  const e = await engine(t);
  const d = new DockerDriver({ bearer: "test-bearer", url: `unix://${e.socket}`, labelPrefix: "vyre", network: "vyre-computers" });
  await d.create(spec);
  const body = e.seen[0].body;
  assert.equal(body.HostConfig.Privileged, false);
  assert.equal(body.HostConfig.PidMode, "", "isolated is the default; there is no other container to share with");
  assert.notEqual(body.HostConfig.NetworkMode, "host");
  assert.deepEqual(body.HostConfig.CapDrop, ["ALL"]);
  assert.deepEqual(body.HostConfig.Devices, []);
  assert.equal(body.HostConfig.ReadonlyRootfs, true);
  assert.ok(body.HostConfig.Tmpfs && Object.keys(body.HostConfig.Tmpfs).length > 0, "a read-only root needs somewhere to write");
  // The only mounts are the agent's own two named volumes: never a bind, never the docker socket.
  assert.equal(body.HostConfig.Mounts.length, 2);
  // Every capability dropped but the two the entrypoint switches users with.
  assert.deepEqual(body.HostConfig.CapAdd, ["SETUID", "SETGID"]);
  for (const m of body.HostConfig.Mounts) {
    assert.equal(m.Type, "volume", "no bind mount ever reaches a create body");
    assert.doesNotMatch(String(m.Source), /docker\.sock/);
    assert.doesNotMatch(String(m.Target), /docker\.sock/);
  }
  assert.doesNotMatch(JSON.stringify(body), /\/var\/run\/docker\.sock/, "the docker socket must never appear anywhere in a create body");
});

test("docker: a computer is refused the host network, whatever config or a caller asks for", async t => {
  const e = await engine(t);
  const d = new DockerDriver({ bearer: "test-bearer", url: `unix://${e.socket}`, labelPrefix: "vyre" });
  await assert.rejects(d.create({ ...spec, network: "host" }), /never runs on the host network/);
  const onHost = new DockerDriver({ bearer: "test-bearer", url: `unix://${e.socket}`, labelPrefix: "vyre", network: "host" });
  await assert.rejects(onHost.create({ ...spec, network: undefined }), /never runs on the host network/);
});

test("docker: run.vyre=1 marks every container and its volume, alongside the prefix labels", async t => {
  const e = await engine(t);
  const d = new DockerDriver({ bearer: "test-bearer", url: `unix://${e.socket}`, labelPrefix: "run.vyre.computers", network: "vyre-computers" });
  await d.create({ ...spec, labels: { "run.vyre.computers.computer": "kit", "run.vyre.computers.managed": "true" } });
  const body = e.seen[0].body;
  assert.equal(body.Labels["run.vyre"], "1");
  assert.equal(body.Labels["run.vyre.computers.computer"], "kit");
  assert.equal(body.HostConfig.Mounts[0].VolumeOptions.Labels["run.vyre"], "1");
});

test("docker: every operation reads the labels first, then acts", async t => {
  const e = await engine(t);
  const d = new DockerDriver({ bearer: "test-bearer", url: `unix://${e.socket}`, labelPrefix: "vyre", network: "vyre-computers" });
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
  const d = new DockerDriver({ bearer: "test-bearer", url: `unix://${e.socket}` });
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
  const d = new DockerDriver({ bearer: "test-bearer", url: `unix://${e.socket}` });
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
  const d = new DockerDriver({ bearer: "test-bearer", url: `unix://${e.socket}` });
  await assert.rejects(d.start("nope"), /no such container: nope/);
  await assert.rejects(d.create({ ...spec, agent: "Bad Name" }), /not an agent name/);
  const bad = new DockerDriver({ bearer: "test-bearer", url: `unix://${path.join(os.tmpdir(), "no-such-vyre-docker.sock")}` });
  await assert.rejects(bad.create(spec), err => { assert.doesNotMatch(String(err), /abcdefgh|t0ken/); return true; });
});

test("docker: needs a proxy URL, http or unix, and never assumes the raw socket", () => {
  assert.throws(() => new DockerDriver(/** @type {any} */ ({})), /computers.docker/);
  assert.throws(() => new DockerDriver({ bearer: "test-bearer", url: "https://proxy:2375" }), /http:\/\/host:port or unix/);
  const d = new DockerDriver({ bearer: "test-bearer", url: "http://docker-proxy:2375" });
  assert.deepEqual(d.target, { host: "docker-proxy", port: 2375 });
});

test("docker: needs a bearer -- there is no unauthenticated mode", () => {
  assert.throws(() => new DockerDriver({ url: "http://docker-proxy:2375" }), /needs a bearer/);
  assert.throws(() => new DockerDriver({ url: "http://docker-proxy:2375", bearer: "" }), /needs a bearer/);
});

test("docker: works over TCP to a proxy too", async t => {
  const seen = [];
  const server = http.createServer((req, res) => { seen.push(`${req.method} ${req.url}`); res.writeHead(200, { "content-type": "application/json" }); res.end("[]"); });
  await new Promise(r => server.listen(0, "127.0.0.1", () => r(undefined)));
  t.after(() => server.close());
  const addr = /** @type {import("node:net").AddressInfo} */ (server.address());
  const d = new DockerDriver({ bearer: "test-bearer", url: `http://127.0.0.1:${addr.port}` });
  assert.deepEqual(await d.list(), []);
  assert.match(seen[0], /^GET \/v1\.43\/containers\/json\?all=true/);
});

test("docker: the secrets never go in Env; seed() puts them in the computer's volume as a .boot tar", async t => {
  const e = await engine(t);
  const d = new DockerDriver({ bearer: "test-bearer", url: `unix://${e.socket}`, labelPrefix: "vyre", network: "vyre-computers" });
  await assert.rejects(d.create({ ...spec, env: { SCREEN: "1440x900", COMPUTERD_TOKEN: "x".repeat(43) } }), /must not be in a computer's Env/);
  await assert.rejects(d.create({ ...spec, env: { VNC_PASSWORD: "abcdefgh" } }), /must not be in a computer's Env/);
  const { id } = await d.create(spec);
  await d.seed(id, { computerd_token: "T".repeat(43), vnc_password: "Ab-_1234" });
  const put = e.seen.at(-1);
  assert.equal(put.method, "PUT");
  assert.equal(put.path, `/v1.43/containers/${id}/archive?path=%2Fvar%2Flib%2Fvyre`);
  assert.equal(put.authorization, "Bearer test-bearer", "the secrets themselves travel behind the bearer too");
  assert.deepEqual(allowBootTar(put.body), { ok: true });
  assert.match(put.body.toString("latin1"), /COMPUTERD_TOKEN=T{43}\nVNC_PASSWORD=Ab-_1234\n/);
  // Only our containers: someone else's database is never written to.
  await assert.rejects(d.seed("db1", { computerd_token: "T".repeat(43), vnc_password: "Ab-_1234" }));
  assert.ok(!e.seen.some(s => s.method === "PUT" && s.path.includes("db1")));
});

test("docker: seedAgentTokens() writes .agent-tokens the same way seed() writes .boot, to the same directory, and never to another container", async t => {
  const e = await engine(t);
  const d = new DockerDriver({ bearer: "test-bearer", url: `unix://${e.socket}`, labelPrefix: "vyre", network: "vyre-computers" });
  const { id } = await d.create(spec);
  await d.seedAgentTokens(id, [{ name: "alice", token: "a".repeat(40) }, { name: "bob", token: "b".repeat(40) }]);
  const put = e.seen.at(-1);
  assert.equal(put.method, "PUT");
  assert.equal(put.path, `/v1.43/containers/${id}/archive?path=%2Fvar%2Flib%2Fvyre`);
  assert.equal(put.authorization, "Bearer test-bearer");
  assert.deepEqual(allowAgentTokensTar(put.body), { ok: true });
  assert.match(put.body.toString("latin1"), /alice=a{40}\nbob=b{40}\n/);
  await assert.rejects(d.seedAgentTokens("db1", [{ name: "alice", token: "a".repeat(40) }]));
  assert.ok(!e.seen.some(s => s.method === "PUT" && s.path.includes("db1")));
});
