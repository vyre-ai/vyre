// @ts-check
// The proxy between a fake Engine on a temp unix socket and a plain HTTP client, with a stub
// policy of the same interface as core/computers/driver/policy.js. What is checked is what the
// Engine receives: only the allowed endpoints, only checked bodies, and only ever re-serialised.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { createProxy, duplicateKey, loadPolicy, scrub } from "./proxy.js";
import { SCRATCH } from "../../test/scratch.mjs";
import { BOOT, bootTar, allowBootTar, AGENT_TOKENS, agentTokensTar, allowAgentTokensTar } from "../computers/driver/policy.js";

const PREFIX = "run.vyre.computers";
const CONFIG = { network: "vyre-computers", image: "vyre/computer:0.1", labelPrefix: PREFIX, capAdd: [] };
const mine = agent => ({ "run.vyre": "1", [`${PREFIX}.managed`]: "true", [`${PREFIX}.computer`]: agent });

/** The same interface as policy.js, reduced to what these tests need to tell apart. */
const stub = {
  computerLabels(labels) {
    if (!labels || labels["run.vyre"] !== "1") return null;
    const m = Object.keys(labels).find(k => k.endsWith(".managed") && labels[k] === "true");
    if (!m) return null;
    const prefix = m.slice(0, -".managed".length), agent = labels[`${prefix}.computer`];
    return typeof agent === "string" ? { prefix, agent } : null;
  },
  isComputerLabels: labels => stub.computerLabels(labels) !== null,
  allowCreate(body, config) {
    if (!body || body.Image !== config.image) return { ok: false, why: "wrong image" };
    if (!body.HostConfig || body.HostConfig.NetworkMode !== config.network) return { ok: false, why: "wrong network" };
    if (body.HostConfig.Privileged !== false) return { ok: false, why: "privileged" };
    if (!stub.isComputerLabels(body.Labels)) return { ok: false, why: "labels" };
    return { ok: true };
  },
  allowExec: labels => stub.isComputerLabels(labels) ? { ok: true } : { ok: false, why: "not a computer" },
  allowContainerOp: labels => stub.allowExec(labels),
  // The real ones: the .boot and .agent-tokens checks are byte-exact, and a stub of either would
  // test nothing.
  BOOT, allowBootTar, allowAgentTokensTar,
};

/** A fake Engine: one computer, one database, one volume per case, two execs. */
async function engine(t) {
  const dir = fs.mkdtempSync(path.join(SCRATCH, "vyre-dproxy-"));
  const socket = path.join(dir, "d.sock");
  /** @type {Array<{ method: string, url: string, raw: string }>} */
  const seen = [];
  const boxes = new Map([
    ["kitfull0001", { Id: "kitfull0001", Name: "/run.vyre.computers-computer-kit", Path: "/entry.sh", Args: ["--vnc", "pw"],
      State: { Status: "running" }, NetworkSettings: { Networks: { "vyre-computers": { IPAddress: "172.20.0.5" } } },
      Config: { Labels: mine("kit"), Env: ["COMPUTERD_TOKEN=s3cret", "VNC_PASSWORD=hunter22"], Cmd: ["run"], Entrypoint: ["/entry.sh"] } }],
    ["db1", { Id: "db1", Name: "/postgres", Config: { Labels: { "com.example.app": "db" } } }],
    ["vyred", { Id: "vyred", Name: "/vyre-vyre-1", Config: { Labels: { "run.vyre": "1" } } }],
  ]);
  const volumes = new Map([
    ["run.vyre.computers-home-kit", { Name: "run.vyre.computers-home-kit", Labels: mine("kit") }],
    ["run.vyre.computers-home-ann", { Name: "run.vyre.computers-home-ann", Labels: mine("bob") }],
    ["vyre_vyre-home", { Name: "vyre_vyre-home", Labels: { "run.vyre": "1" } }],
  ]);
  const execs = new Map([["ex1", { ContainerID: "kitfull0001" }], ["ex2", { ContainerID: "db1" }]]);
  const server = http.createServer(async (req, res) => {
    let raw = "";
    for await (const c of req) raw += c;
    seen.push({ method: String(req.method), url: String(req.url), raw });
    const send = (status, b) => { res.writeHead(status, { "content-type": "application/json" }); res.end(b === undefined ? "" : JSON.stringify(b)); };
    const u = new URL(String(req.url), "http://d");
    const p = u.pathname.replace(/^\/v1\.\d+/, "");
    let m;
    if (req.method === "GET" && p === "/containers/json") {
      // A careless Engine that ignores filters: the proxy must filter the rows itself too.
      return send(200, [...boxes.values()].map(b => ({ Id: b.Id, Labels: b.Config.Labels, Command: "/entry.sh --vnc pw" })));
    }
    if (req.method === "POST" && p === "/containers/create") return send(201, { Id: "new1", Warnings: [] });
    if ((m = /^\/containers\/([^/]+)\/json$/.exec(p))) {
      const b = boxes.get(m[1]) || [...boxes.values()].find(x => x.Name === "/" + m[1]);
      return b ? send(200, b) : send(404, { message: `No such container: ${m[1]}` });
    }
    if ((m = /^\/volumes\/([^/]+)$/.exec(p))) {
      const v = volumes.get(m[1]);
      return v ? send(200, v) : send(404, { message: "no such volume" });
    }
    if ((m = /^\/containers\/([^/]+)\/stats$/.exec(p))) {
      assert.equal(u.search, "?stream=false", "stream=false is hard-coded; the caller's query never reaches here");
      const b = boxes.get(m[1]);
      return b ? send(200, { cpu_stats: {}, precpu_stats: {}, memory_stats: {}, networks: {} }) : send(404, { message: "no such container" });
    }
    if ((m = /^\/exec\/([^/]+)\/json$/.exec(p))) {
      const e = execs.get(m[1]);
      return e ? send(200, e) : send(404, { message: "no such exec" });
    }
    if ((m = /^\/exec\/([^/]+)\/start$/.exec(p))) {
      res.writeHead(200, { "content-type": "application/vnd.docker.raw-stream" });
      res.write("hel"); setTimeout(() => res.end("lo"), 5);
      return;
    }
    if (req.method === "GET" && p === "/events") {
      res.writeHead(200, { "content-type": "application/json" });
      res.write(JSON.stringify({ Type: "container", Action: "die", Actor: { ID: "kitfull0001", Attributes: { exitCode: "137" } }, time: 101 }) + "\n");
      setTimeout(() => res.end(JSON.stringify({ Type: "container", Action: "oom", Actor: { ID: "kitfull0001", Attributes: {} }, time: 102 }) + "\n"), 5);
      return;
    }
    if (/^\/containers\/[^/]+\/exec$/.test(p)) return send(201, { Id: "ex9" });
    if (req.method === "PUT" && /^\/containers\/[^/]+\/archive$/.test(p)) return send(200);
    if (/^\/containers\/[^/]+\/(start|stop|pause|unpause)$/.test(p) || (req.method === "DELETE" && /^\/containers\/[^/]+$/.test(p))) return send(204);
    send(404, { message: "page not found" });
  });
  await new Promise(r => server.listen(socket, () => r(undefined)));
  t.after(() => { server.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { socket, seen };
}

const BEARER = "test-bearer-token";

/** The proxy on a loopback port, and a client for it, authorized by default (the bearer's own
 * tests pass a wrong or empty one, everything else needs never think about it). */
async function proxy(t, policy = stub, bearer = BEARER) {
  const e = await engine(t);
  /** @type {any[]} */
  const logs = [];
  const server = createProxy({ socket: e.socket, policy, config: CONFIG, bearer, log: x => logs.push(x) });
  await new Promise(r => server.listen(0, "127.0.0.1", () => r(undefined)));
  t.after(() => server.close());
  const port = /** @type {import("node:net").AddressInfo} */ (server.address()).port;
  /**
   * @param {string} method @param {string} p @param {any} [body] a string is sent as it is
   * @param {Record<string, string>} [headers]
   * @returns {Promise<{ status: number, text: string, json: any }>}
   */
  const call = (method, p, body, headers = {}) => new Promise((resolve, reject) => {
    const data = body === undefined ? null : Buffer.isBuffer(body) ? body : Buffer.from(typeof body === "string" ? body : JSON.stringify(body));
    /** @type {Record<string, any>} an empty value drops the header */
    const h = { authorization: `Bearer ${bearer}`, ...(data ? { "content-type": "application/json", "content-length": data.length } : {}), ...headers };
    for (const k of Object.keys(h)) if (h[k] === "") delete h[k];
    const req = http.request({ host: "127.0.0.1", port, method, path: p, headers: h }, res => {
      let text = "";
      res.on("data", c => text += c);
      res.on("end", () => { let json = null; try { json = JSON.parse(text); } catch {} resolve({ status: res.statusCode || 0, text, json }); });
    });
    req.on("error", reject);
    req.end(data || undefined);
  });
  const sent = () => e.seen.filter(s => !(s.method === "GET" && /\/(json|volumes\/[^/]+)$/.test(new URL(s.url, "http://d").pathname)));
  return { call, seen: e.seen, sent, logs };
}

const CREATE = () => ({
  Image: "vyre/computer:0.1", Hostname: "kit", Env: ["SCREEN=1440x900"], Labels: mine("kit"),
  HostConfig: { NetworkMode: "vyre-computers", Privileged: false, CapDrop: ["ALL"],
    Mounts: [{ Type: "volume", Source: "run.vyre.computers-home-kit", Target: "/home/agent", VolumeOptions: { Labels: mine("kit") } }] },
});
const NAME_KIT = `/v1.43/containers/create?name=${PREFIX}-computer-kit`;

test("dockerproxy: create passes the checked body, re-serialised, never the caller's bytes", async t => {
  const p = await proxy(t);
  // Odd spacing on the wire; what reaches the Engine is JSON.stringify of the parsed object.
  const wire = JSON.stringify(CREATE(), null, 3);
  const r = await p.call("POST", NAME_KIT, wire);
  assert.equal(r.status, 201, r.text);
  assert.deepEqual(r.json, { Id: "new1", Warnings: [] });
  const create = p.seen.find(s => s.method === "POST");
  assert.ok(create);
  assert.equal(create.raw, JSON.stringify(CREATE()));
  assert.equal(create.url, `/v1.43/containers/create?name=${encodeURIComponent(PREFIX + "-computer-kit")}`);
  // The existing volume was inspected first, and names kit, as the body does.
  assert.ok(p.seen.some(s => s.url === "/v1.43/volumes/run.vyre.computers-home-kit"));
});

test("dockerproxy: create refused when the policy refuses, or the name is not the agent's", async t => {
  const p = await proxy(t);
  const priv = CREATE(); priv.HostConfig.Privileged = /** @type {any} */ (true);
  assert.equal((await p.call("POST", NAME_KIT, priv)).status, 403);
  assert.equal((await p.call("POST", "/v1.43/containers/create?name=postgres", CREATE())).status, 403);
  assert.equal((await p.call("POST", "/v1.43/containers/create", CREATE())).status, 403);
  assert.equal(p.sent().length, 0, "nothing that changes anything reached the Engine");
  assert.ok(p.logs.every(l => l.status === 403 && l.why && !JSON.stringify(l).includes("SCREEN")), "refusals are logged without bodies");
});

test("dockerproxy: an existing volume owned by another agent is refused", async t => {
  const p = await proxy(t);
  const b = CREATE();
  b.HostConfig.Mounts[0].Source = "run.vyre.computers-home-ann";
  const r = await p.call("POST", NAME_KIT, b);
  assert.equal(r.status, 403);
  assert.match(r.json.message, /exists and is not kit's/);
  const infra = CREATE();
  infra.HostConfig.Mounts[0].Source = "vyre_vyre-home";
  assert.equal((await p.call("POST", NAME_KIT, infra)).status, 403, "vyred's own home is never an agent's");
  // A volume that does not exist yet is fine: Docker makes it with the body's labels.
  const fresh = CREATE();
  fresh.HostConfig.Mounts[0].Source = "run.vyre.computers-home-new";
  assert.equal((await p.call("POST", NAME_KIT, fresh)).status, 201);
  assert.equal(p.sent().length, 1);
});

test("dockerproxy: oversized bodies are 413, duplicate keys and bad JSON are refused", async t => {
  const p = await proxy(t);
  const big = JSON.stringify({ ...CREATE(), Env: ["X=" + "a".repeat(300 * 1024)] });
  assert.equal((await p.call("POST", NAME_KIT, big)).status, 413);
  // Chunked, with no content-length to refuse early on.
  const chunked = await p.call("POST", NAME_KIT, big, { "content-length": "", "transfer-encoding": "chunked" });
  assert.equal(chunked.status, 413);
  const dup = JSON.stringify(CREATE()).replace('"HostConfig":{', '"HostConfig":{"Privileged":true,');
  const r = await p.call("POST", NAME_KIT, dup);
  assert.equal(r.status, 400);
  assert.match(r.json.message, /repeats the key "Privileged"/);
  assert.equal((await p.call("POST", NAME_KIT, "{nope")).status, 400);
  assert.equal(p.sent().length, 0);
});

test("dockerproxy: duplicateKey finds repeats per object, never across objects or in arrays", () => {
  assert.equal(duplicateKey('{"a":1,"b":{"a":2},"c":["a","a"]}'), null);
  assert.equal(duplicateKey('{"a":1,"b":{"x":2,"x":3}}'), "x");
  assert.equal(duplicateKey('{"a\\"b":1,"a\\u0022b":2}'), 'a"b');
  assert.equal(duplicateKey('{"k":"{\\"k\\":1,","k":2}'), "k");
});

test("dockerproxy: refused endpoints are 403 and never reach the Engine", async t => {
  const p = await proxy(t);
  const refused = [
    ["PUT", "/v1.43/containers/kitfull0001/archive"], ["GET", "/containers/kitfull0001/archive"],
    ["HEAD", "/containers/kitfull0001/archive"], ["POST", "/v1.43/images/create?fromImage=alpine"], ["POST", "/build"],
    ["GET", "/containers/kitfull0001/logs"], ["POST", "/containers/kitfull0001/attach"], ["GET", "/containers/kitfull0001/export"],
    ["POST", "/volumes/create"], ["DELETE", "/volumes/run.vyre.computers-home-kit"], ["GET", "/networks"],
    ["POST", "/networks/create"], ["GET", "/swarm"], ["GET", "/plugins"], ["GET", "/secrets"], ["GET", "/configs"],
    ["GET", "/system/df"], ["GET", "/version"], ["GET", "/_ping"], ["GET", "/info"],
    ["GET", "/exec/ex1/json"], ["POST", "/containers/kitfull0001/kill"], ["POST", "/containers/kitfull0001/update"],
    ["GET", "/v2.0/containers/json"], ["PATCH", "/containers/kitfull0001"],
    ["POST", "/containers/kitfull0001/start?detachKeys=x"], ["DELETE", "/containers/kitfull0001?link=true"],
    ["POST", "/containers/kitfull0001/stop?t=1&t=2"],
  ];
  for (const [method, url] of refused) {
    const r = await p.call(method, url);
    assert.equal(r.status, 403, `${method} ${url}: ${r.text}`);
  }
  assert.equal(p.seen.length, 0, p.seen.map(s => s.method + " " + s.url).join("\n"));
});

test("dockerproxy: per-container ops on a computer pass, by the id the Engine gave", async t => {
  const p = await proxy(t);
  for (const op of ["start", "stop?t=10", "pause", "unpause"]) {
    assert.equal((await p.call("POST", `/v1.43/containers/${PREFIX}-computer-kit/${op}`)).status, 204, op);
  }
  assert.equal((await p.call("DELETE", "/v1.43/containers/kitfull0001?v=false&force=true")).status, 204);
  const i = await p.call("GET", "/containers/kitfull0001/json");
  assert.equal(i.status, 200);
  assert.equal(i.json.Id, "kitfull0001");
  // What docker.js reads survives; the secrets do not.
  assert.deepEqual(i.json.Config, { Labels: mine("kit") });
  assert.equal(i.json.State.Status, "running");
  assert.equal(i.json.NetworkSettings.Networks["vyre-computers"].IPAddress, "172.20.0.5");
  for (const k of ["Path", "Args"]) assert.ok(!(k in i.json), k);
  assert.ok(!/s3cret|hunter22|--vnc/.test(i.text), i.text);
  assert.deepEqual(p.sent().map(s => `${s.method} ${s.url}`), [
    "POST /v1.43/containers/kitfull0001/start", "POST /v1.43/containers/kitfull0001/stop?t=10",
    "POST /v1.43/containers/kitfull0001/pause", "POST /v1.43/containers/kitfull0001/unpause",
    "DELETE /v1.43/containers/kitfull0001?v=false&force=true",
  ]);
  assert.equal((await p.call("GET", "/v1.43/containers/gone/json")).status, 404);
});

test("dockerproxy: stats forwards for a computer, whatever query the caller tried, and is refused for someone else's container", async t => {
  const p = await proxy(t);
  const r = await p.call("GET", "/v1.43/containers/kitfull0001/stats");
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(Object.keys(r.json), ["cpu_stats", "precpu_stats", "memory_stats", "networks"]);
  assert.equal((await p.call("GET", "/containers/kitfull0001/stats?stream=true")).status, 403, "stream is never the caller's to set");
  assert.equal((await p.call("GET", "/containers/db1/stats")).status, 403, "someone else's container");
  assert.equal((await p.call("GET", "/containers/gone/stats")).status, 404);
});

test("dockerproxy: a container without computer labels is refused, whatever the request claims", async t => {
  const p = await proxy(t);
  for (const id of ["db1", "vyred"]) {
    for (const [method, url] of [["POST", `/containers/${id}/stop`], ["DELETE", `/containers/${id}?force=true`],
      ["GET", `/containers/${id}/json`], ["POST", `/containers/${id}/start?labels=${encodeURIComponent(JSON.stringify(mine("kit")))}`]]) {
      assert.equal((await p.call(method, url)).status, 403, `${method} ${url}`);
    }
    // Claiming the labels in a body changes nothing either.
    assert.equal((await p.call("POST", `/containers/${id}/exec`, { Cmd: ["id"], Labels: mine("kit") })).status, 403);
    assert.equal((await p.call("POST", `/containers/${id}/exec`, { Cmd: ["id"] })).status, 403);
  }
  assert.equal(p.sent().length, 0);
});

test("dockerproxy: exec on a computer passes; exec start on a non-computer's exec is refused", async t => {
  const p = await proxy(t);
  const c = await p.call("POST", "/v1.43/containers/kitfull0001/exec", { AttachStdout: true, AttachStderr: true, Cmd: ["id", "-u"], User: "1000:1000" });
  assert.equal(c.status, 201, c.text);
  // A computer starts as root to switch users, so an exec with no User would be root in it; and
  // vyre's uid runs computerd and Chrome. Only the agent's own uid is allowed.
  assert.equal((await p.call("POST", "/v1.43/containers/kitfull0001/exec", { Cmd: ["id"] })).status, 403, "no User");
  assert.equal((await p.call("POST", "/v1.43/containers/kitfull0001/exec", { Cmd: ["id"], User: "1001:1001" })).status, 403, "vyre's uid");
  assert.equal((await p.call("POST", "/v1.43/containers/kitfull0001/exec", { Cmd: ["id"], User: "agent" })).status, 403, "a name, not the uid");
  assert.equal((await p.call("POST", "/v1.43/containers/kitfull0001/exec", { Cmd: ["sh"], Privileged: true })).status, 403);
  assert.equal((await p.call("POST", "/v1.43/containers/kitfull0001/exec", { Cmd: ["sh"], User: "0" })).status, 403);
  const s = await p.call("POST", "/v1.43/exec/ex1/start", { Detach: false, Tty: false });
  assert.equal(s.status, 200);
  assert.equal(s.text, "hello", "the exec's output streams back");
  assert.equal((await p.call("POST", "/v1.43/exec/ex2/start", { Detach: false })).status, 403, "db1's exec");
  assert.equal((await p.call("POST", "/v1.43/exec/nope/start", { Detach: true })).status, 404);
  const up = await p.call("POST", "/v1.43/exec/ex1/start", { Detach: false }, { connection: "Upgrade", upgrade: "tcp" });
  assert.equal(up.status, 403, "no attached stdin");
  assert.deepEqual(p.sent().map(s => `${s.method} ${s.url}`), ["POST /v1.43/containers/kitfull0001/exec", "POST /v1.43/exec/ex1/start"]);
});

test("dockerproxy: list gets the computer filter forced, and its rows filtered again", async t => {
  const p = await proxy(t);
  const r = await p.call("GET", `/v1.43/containers/json?all=true&filters=${encodeURIComponent(JSON.stringify({ status: ["running"], label: ["x=1"] }))}`);
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.map(c => c.Id), ["kitfull0001"]);
  assert.ok(!("Command" in r.json[0]), "list rows carry no command line");
  const u = new URL(p.seen[0].url, "http://d");
  assert.equal(u.searchParams.get("all"), "true");
  assert.deepEqual(JSON.parse(String(u.searchParams.get("filters"))),
    { status: ["running"], label: ["x=1", "run.vyre=1", `${PREFIX}.managed=true`] });
  const bare = await p.call("GET", "/containers/json");
  assert.deepEqual(bare.json.map(c => c.Id), ["kitfull0001"]);
  assert.deepEqual(JSON.parse(String(new URL(p.seen[1].url, "http://d").searchParams.get("filters"))),
    { label: ["run.vyre=1", `${PREFIX}.managed=true`] });
  assert.equal((await p.call("GET", "/containers/json?filters=%5B%5D")).status, 400);
});

test("dockerproxy: volume inspect answers only for a computer's volume", async t => {
  const p = await proxy(t);
  const r = await p.call("GET", "/v1.43/volumes/run.vyre.computers-home-kit");
  assert.equal(r.status, 200);
  assert.equal(r.json.Name, "run.vyre.computers-home-kit");
  assert.equal((await p.call("GET", "/v1.43/volumes/vyre_vyre-home")).status, 403);
  assert.equal((await p.call("GET", "/v1.43/volumes/none")).status, 404);
});

test("dockerproxy: loadPolicy refuses a module without the policy's exports", async t => {
  const dir = fs.mkdtempSync(path.join(SCRATCH, "vyre-dproxy-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "p.mjs");
  fs.writeFileSync(file, "export const allowCreate = () => ({ ok: true });\n");
  await assert.rejects(loadPolicy(new URL(`file://${file}`)), /does not export computerLabels/);
  assert.throws(() => createProxy({ policy: stub, config: { ...CONFIG, labelPrefix: "" } }), /label prefix/);
  assert.ok(!fs.existsSync(new URL("./module.json", import.meta.url)), "not a vyred module");
});

test("dockerproxy: scrub drops an exec's ProcessConfig and a container's Env, Cmd, Entrypoint, Args, Path", () => {
  assert.deepEqual(scrub({ ID: "e", ContainerID: "c", ProcessConfig: { arguments: ["pw"] } }), { ID: "e", ContainerID: "c" });
  assert.deepEqual(scrub({ Id: "c", Path: "p", Args: ["a"], Config: { Env: ["A=1"], Cmd: ["x"], Entrypoint: ["y"], Labels: {} } }),
    { Id: "c", Config: { Labels: {} } });
  assert.equal(scrub(null), null);
});

test("dockerproxy: the only archive upload is a computer's .boot tar, to /var/lib/vyre", async t => {
  const p = await proxy(t);
  const good = bootTar({ computerd_token: "k".repeat(43), vnc_password: "Ab-_1234" });
  const tarH = { "content-type": "application/x-tar" };
  const put = (path, body, h = tarH) => p.call("PUT", path, body, h);
  const ok = await put("/v1.43/containers/kitfull0001/archive?path=%2Fvar%2Flib%2Fvyre", good);
  assert.equal(ok.status, 200, ok.text);
  const fwd = p.sent().filter(s => s.method === "PUT");
  assert.deepEqual(fwd.map(s => s.url), ["/v1.43/containers/kitfull0001/archive?path=%2Fvar%2Flib%2Fvyre"]);
  assert.equal((await put("/v1.43/containers/kitfull0001/archive?path=%2Fhome%2Fagent", good)).status, 403, "another folder");
  assert.equal((await put("/v1.43/containers/kitfull0001/archive?path=%2F", good)).status, 403, "the root");
  assert.equal((await put("/v1.43/containers/kitfull0001/archive", good)).status, 403, "no path");
  assert.equal((await put("/v1.43/containers/db1/archive?path=%2Fvar%2Flib%2Fvyre", good)).status, 403, "not a computer");
  assert.equal((await put("/v1.43/containers/kitfull0001/archive?path=%2Fvar%2Flib%2Fvyre", good, { "content-type": "application/json" })).status, 400);
  const evil = Buffer.from(good); evil.write("x", 0, "ascii");
  assert.equal((await put("/v1.43/containers/kitfull0001/archive?path=%2Fvar%2Flib%2Fvyre", evil)).status, 403, "another file");
  assert.equal((await put("/v1.43/containers/kitfull0001/archive?path=%2Fvar%2Flib%2Fvyre&noOverwriteDirNonDir=1", good)).status, 403, "extra query");
  assert.equal(p.sent().filter(s => s.method === "PUT").length, 1, "only the good upload reached the Engine");
  assert.equal((await p.call("GET", "/v1.43/containers/kitfull0001/archive?path=%2Fvar%2Flib%2Fvyre")).status, 403, "never a read");
  // The archive route is exactly as bound to the bearer as every other route -- this is HIGH 2's
  // new route getting the same fix the rest of the proxy just did, not a separate exemption.
  assert.equal((await put("/v1.43/containers/kitfull0001/archive?path=%2Fvar%2Flib%2Fvyre", good, { ...tarH, authorization: "" })).status, 401);
});

test("dockerproxy: a shared computer's .agent-tokens tar is let through the same archive route -- the tar's own name, not the query, tells it apart from .boot", async t => {
  const p = await proxy(t);
  const goodAgents = agentTokensTar([{ id: "id1", name: "alice", token: "a".repeat(40) }, { id: "id2", name: "bob", token: "b".repeat(40) }]);
  const put = (path, body, h = { "content-type": "application/x-tar" }) => p.call("PUT", path, body, h);
  const ok = await put("/v1.43/containers/kitfull0001/archive?path=%2Fvar%2Flib%2Fvyre", goodAgents);
  assert.equal(ok.status, 200, ok.text);
  assert.deepEqual(p.sent().filter(s => s.method === "PUT").map(s => s.url), ["/v1.43/containers/kitfull0001/archive?path=%2Fvar%2Flib%2Fvyre"]);
  // Still every other rule the .boot route has: another folder, another file, no path query.
  assert.equal((await put("/v1.43/containers/kitfull0001/archive?path=%2Fhome%2Fagent", goodAgents)).status, 403, "another folder");
  const evil = Buffer.from(goodAgents); evil.write("x", 0, "ascii");
  assert.equal((await put("/v1.43/containers/kitfull0001/archive?path=%2Fvar%2Flib%2Fvyre", evil)).status, 403, "tampered contents");
  assert.equal(p.sent().filter(s => s.method === "PUT").length, 1, "only the good upload reached the Engine");
});

test("dockerproxy: a policy that has no allowAgentTokensTar (every policy before this feature existed) refuses .agent-tokens outright, .boot only", async t => {
  const { allowAgentTokensTar: _omit, ...noAgentTokens } = stub;
  const p = await proxy(t, noAgentTokens);
  const goodAgents = agentTokensTar([{ id: "id1", name: "alice", token: "a".repeat(40) }]);
  const r = await p.call("PUT", "/v1.43/containers/kitfull0001/archive?path=%2Fvar%2Flib%2Fvyre", goodAgents, { "content-type": "application/x-tar" });
  assert.equal(r.status, 403);
  // .boot itself still works on that same, older policy.
  const good = bootTar({ computerd_token: "k".repeat(43), vnc_password: "Ab-_1234" });
  const r2 = await p.call("PUT", "/v1.43/containers/kitfull0001/archive?path=%2Fvar%2Flib%2Fvyre", good, { "content-type": "application/x-tar" });
  assert.equal(r2.status, 200);
});

test("dockerproxy: createProxy needs a bearer -- there is no unauthenticated mode", async t => {
  const e = await engine(t);
  assert.throws(() => createProxy({ socket: e.socket, policy: stub, config: CONFIG }), /needs a bearer/);
  assert.throws(() => createProxy({ socket: e.socket, policy: stub, config: CONFIG, bearer: "" }), /needs a bearer/);
  assert.throws(() => createProxy({ socket: e.socket, policy: stub, config: CONFIG, bearer: "short" }), /needs a bearer/, "under 16 chars is refused too");
});

test("dockerproxy: every request needs Authorization: Bearer <token>, checked against the whole endpoint, not the shape", async t => {
  const { call, seen } = await proxy(t);
  // No header at all.
  const none = await call("GET", "/v1.43/containers/json", undefined, { authorization: "" });
  assert.equal(none.status, 401);
  // The right token, wrong scheme, and a right-length-wrong-content token: none of them pass.
  const noScheme = await call("GET", "/v1.43/containers/json", undefined, { authorization: BEARER });
  assert.equal(noScheme.status, 401);
  const wrong = await call("GET", "/v1.43/containers/json", undefined, { authorization: `Bearer ${"x".repeat(BEARER.length)}` });
  assert.equal(wrong.status, 401);
  const shorter = await call("GET", "/v1.43/containers/json", undefined, { authorization: "Bearer short" });
  assert.equal(shorter.status, 401);
  // None of the refused attempts ever reached the Engine.
  assert.equal(seen.length, 0);
  // The right one still works.
  const ok = await call("GET", "/v1.43/containers/json");
  assert.equal(ok.status, 200);
});

test("dockerproxy: /events streams this box's computers' deaths, with the type, the events and the labels forced and only since= the caller's", async t => {
  const px = await proxy(t);
  const r = await px.call("GET", "/v1.43/events?since=100");
  assert.equal(r.status, 200);
  assert.deepEqual(r.text.trim().split("\n").map(l => JSON.parse(l).Action), ["die", "oom"]);
  const ev = px.seen.find(x => new URL(x.url, "http://d").pathname.endsWith("/events"));
  const q = new URL(ev.url, "http://d").searchParams;
  assert.equal(q.get("since"), "100");
  assert.deepEqual(JSON.parse(String(q.get("filters"))), { type: ["container"], event: ["die", "oom", "kill", "stop"], label: [`${PREFIX}.managed=true`, "run.vyre=1"] });
  for (const bad of ["?filters=%7B%7D", "?until=1", "?since=abc", "?since=1&since=2"]) {
    const x = await px.call("GET", "/v1.43/events" + bad);
    assert.ok(x.status === 403 || x.status === 400, `${bad} -> ${x.status}`);
  }
  assert.equal((await px.call("POST", "/v1.43/events")).status, 403);
});
