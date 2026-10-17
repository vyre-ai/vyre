// @ts-check
// DockerDriver.execIn against a fake Engine: the exec it creates is exactly the one policy.js allows, the request goes on standard input and the answer comes back framed on standard output.
import "../../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { DockerDriver } from "./docker.js";
import { allowAgentdExec } from "./policy.js";
import { SCRATCH } from "../../../test/scratch.mjs";

async function engine(t, { exit = 0, labels = { "run.vyre": "1", "vyre.managed": "true", "vyre.computer": "browser-shared" }, answer = '{"ok":true}' } = {}) {
  const dir = fs.mkdtempSync(path.join(SCRATCH, "vyre-exec-"));
  const socket = path.join(dir, "d.sock");
  /** @type {{ created: any[], stdin: string }} */ const seen = { created: [], stdin: "" };
  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks).toString("utf8");
    const send = (status, b) => { res.writeHead(status, { "content-type": "application/json" }); res.end(b === undefined ? "" : JSON.stringify(b)); };
    if (req.method === "GET" && req.url === "/v1.43/containers/c1/json") return send(200, { Id: "c1", Name: "/box", Config: { Labels: labels }, State: { Status: "running" }, NetworkSettings: { Networks: {} } });
    if (req.method === "POST" && req.url === "/v1.43/containers/c1/exec") { seen.created.push(JSON.parse(raw)); return send(201, { Id: "e".repeat(16) }); }
    if (req.method === "GET" && req.url === `/v1.43/exec/${"e".repeat(16)}/json`) return send(200, { ExitCode: exit });
    return send(404, { message: "no" });
  });
  server.on("upgrade", (req, socket2) => {
    assert.equal(req.url, `/v1.43/exec/${"e".repeat(16)}/start`);
    socket2.write("HTTP/1.1 101 UPGRADED\r\nContent-Type: application/vnd.docker.raw-stream\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n");
    socket2.on("data", c => { seen.stdin += c; });
    socket2.on("end", () => {
      const body = Buffer.from(answer);
      const head = Buffer.alloc(8); head[0] = 1; head.writeUInt32BE(body.length, 4);
      socket2.end(Buffer.concat([head, body]));
    });
  });
  await new Promise(r => server.listen(socket, () => r(null)));
  t.after(() => { server.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { driver: new DockerDriver({ url: `unix://${socket}`, bearer: "b" }), seen };
}

test("execIn makes exactly the exec policy allows, sends the request on standard input and returns the framed answer and the exit code", async t => {
  const { driver, seen } = await engine(t);
  const r = await driver.execIn("c1", '{"action":"stop","body":{}}');
  assert.deepEqual(r, { code: 0, stdout: '{"ok":true}' });
  assert.equal(seen.stdin, '{"action":"stop","body":{}}');
  assert.equal(seen.created.length, 1);
  assert.deepEqual(allowAgentdExec({ "run.vyre": "1", "vyre.managed": "true", "vyre.computer": "browser-shared" }, seen.created[0]), { ok: true });
  assert.deepEqual(Object.keys(seen.created[0]).sort(), ["AttachStderr", "AttachStdin", "AttachStdout", "Cmd", "Tty", "User"], "no environment, working directory or privilege");
});

test("a non-zero exit comes back as the code; a container that is not ours, or a request that is too large, never reaches the Engine's exec", async t => {
  const bad = await engine(t, { exit: 1, answer: '{"error":{"code":"bad_input","message":"no"}}' });
  assert.equal((await bad.driver.execIn("c1", "{}")).code, 1);
  const other = await engine(t, { labels: { "com.example.app": "postgres" } });
  await assert.rejects(() => other.driver.execIn("c1", "{}"));
  assert.equal(other.seen.created.length, 0);
  const big = await engine(t);
  await assert.rejects(() => big.driver.execIn("c1", "x".repeat(17 * 1024)), /too large/);
  assert.equal(big.seen.created.length, 0);
});
