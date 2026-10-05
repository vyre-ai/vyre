import "../../scripts/mac-test-guard.mjs";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { SCRATCH } from "../../test/scratch.mjs";
import { macStoreOptions, dockerHostOf, countTwentySpaces } from "./mac.js";
import { spaceDir, TWENTY_TESTED_REF, POSTGRES_IMAGE, REDIS_IMAGE, PROXY_IMAGE, composeFile, readLoopbackPort, pickLoopbackPort } from "./provision.js";
import { FakeTwenty } from "./testing/fake-twenty.js";

const dirs = [];
const tmp = () => { const d = fs.mkdtempSync(path.join(SCRATCH, "mac-")); dirs.push(d); return d; };
after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

/** A fake docker: records every call, answers `inspect` with an address, and a fake Twenty behind the fetch. */
function fakeRunner(fake, calls) {
  return {
    exec: async (cmd, args) => { calls.push([cmd, ...args].join(" ")); if (args.includes("inspect")) return { stdout: "10.0.0.2\n", stderr: "" }; return { stdout: "", stderr: "" }; },
    fetch: (u, init) => fetch(String(u).replace(/^http:\/\/[^/]+/, fake.url), init),
    sleep: async () => {},
  };
}
const ok = (n = 2) => ({ ok: true, spaces: n, cpus: 2, memory_gib: 7, max_spaces: 4, message: `This Mac has room for ${n} spaces.` });
const full = { ok: false, spaces: 3, cpus: 2, memory_gib: 8, max_spaces: 2, message: "This Mac has room for 2 spaces. Another would need more memory than half of this Mac's RAM, so put it on your server instead." };
const mark = (home, ...spaces) => { for (const s of spaces) { const d = s === "personal" ? path.join(home, "kernel") : path.join(home, "kernel", "spaces", s); fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, "store.json"), JSON.stringify({ kind: "twenty" })); } };

test("docker is Colima's: DOCKER_HOST from the environment, else vyre.env, else Colima's own socket", () => {
  const home = tmp();
  assert.equal(dockerHostOf({ env: { DOCKER_HOST: "unix:///x.sock", HOME: home } }), "unix:///x.sock");
  fs.mkdirSync(path.join(home, ".vyre"));
  fs.writeFileSync(path.join(home, ".vyre", "vyre.env"), "VYRE_SETUP_CODE=x\nDOCKER_HOST=unix:///from-env-file.sock\n");
  assert.equal(dockerHostOf({ env: { HOME: home } }), "unix:///from-env-file.sock");
  assert.equal(dockerHostOf({ env: { HOME: tmp() } }), `unix://${path.join(path.join(dirs.at(-1)), ".colima/default/docker.sock")}`);
});

test("the docker runner runs with Colima's DOCKER_HOST and touches no other Docker context", async () => {
  const bin = tmp(); const out = path.join(bin, "seen");
  fs.writeFileSync(path.join(bin, "docker"), `#!/bin/sh\necho "DOCKER_HOST=$DOCKER_HOST ctx=\${DOCKER_CONTEXT:-none} args=$*" >"${out}"\n`, { mode: 0o755 });
  const o = macStoreOptions({ home: tmp(), env: { PATH: `${bin}:/usr/bin:/bin`, HOME: tmp(), DOCKER_HOST: "unix:///colima.sock" } });
  await o.runner.exec("docker", ["compose", "ps"]);
  const seen = fs.readFileSync(out, "utf8");
  assert.match(seen, /DOCKER_HOST=unix:\/\/\/colima\.sock ctx=none args=compose ps/);
  assert.ok(!/context use/.test(seen));
});

test("the Mac preflight needs Colima's socket and room, and says the room message plainly when the VM is full", async () => {
  const home = tmp(), sock = path.join(home, "docker.sock"); fs.writeFileSync(sock, "");
  const dir = path.join(home, "kernel", "spaces", "spc_aaaaaaaaaaaa");
  const asked = [];
  const mk = (room, host = `unix://${sock}`) => macStoreOptions({ home, env: { HOME: home, DOCKER_HOST: host }, room: async n => { asked.push(n); return room; }, statfs: () => ({ bavail: 50000, bsize: 1048576 }) });
  mark(home, "personal");
  let p = await mk(ok(2)).preflight({ dir });
  assert.equal(p.ok, true, p.reasons.join("; "));
  assert.deepEqual(asked, [2], "the personal Space already runs on Twenty, so this is the second");
  p = await mk(full).preflight({ dir });
  assert.equal(p.ok, false);
  assert.ok(p.reasons.some(r => /your server/.test(r)), "offers the person's server");
  p = await mk(ok(2), "unix:///nowhere.sock").preflight({ dir });
  assert.ok(p.reasons.some(r => /Colima is not running/.test(r)));
  p = await macStoreOptions({ home, env: { HOME: home, DOCKER_HOST: `unix://${sock}` }, room: async () => ok(2), statfs: () => ({ bavail: 10, bsize: 1048576 }) }).preflight({ dir });
  assert.ok(p.reasons.some(r => /not enough disk/.test(r)));
  // a Space already on Twenty is not counted twice
  asked.length = 0; fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, "store.json"), JSON.stringify({ kind: "twenty" }));
  await mk(ok(1)).preflight({ dir });
  assert.deepEqual(asked, [2]);
  assert.equal(countTwentySpaces(home), 2);
});

test("a new Space makes room first (and says so), then provisions the same pinned images and compose as a server; coming back up makes no room", async () => {
  const fake = await new FakeTwenty().start(); const home = tmp(); const calls = []; const lines = []; const order = [];
  const runner = fakeRunner(fake, calls);
  mark(home, "personal");
  const o = macStoreOptions({ home, env: { HOME: home, DOCKER_HOST: "unix:///c.sock" }, makeRoom: async (n, { onProgress }) => { order.push(`room ${n}`); onProgress("Making room for a new space"); return { ok: true, message: "" }; } });
  const twentyHome = path.join(home, "kernel", "spaces", "spc_bbbbbbbbbbbb", "twenty-home");
  const first = await o.provision({ home: twentyHome, space: "spc-bbbbbbbbbbbb", runner, memory: "small", pickPort: async () => 50123, log: l => lines.push(l) });
  assert.deepEqual(order, ["room 2"], "room is made for the second Twenty space before anything is pulled");
  assert.ok(lines.includes("Making room for a new space"));
  assert.ok(calls.some(c => /compose .*pull/.test(c)) && calls.some(c => /compose .*up -d --wait/.test(c)), "the same compose steps as a server");
  const compose = fs.readFileSync(path.join(spaceDir(twentyHome, "spc-bbbbbbbbbbbb"), "compose.yml"), "utf8");
  for (const m of compose.matchAll(/^\s+image: (.*)$/gm)) assert.match(m[1], /@sha256:[0-9a-f]{64}/, `an unpinned image: ${m[1]}`);
  assert.ok(compose.includes(POSTGRES_IMAGE) && compose.includes(REDIS_IMAGE));
  assert.ok(fs.readFileSync(path.join(spaceDir(twentyHome, "spc-bbbbbbbbbbbb"), ".env"), "utf8").includes(`TWENTY_IMAGE_REF=${TWENTY_TESTED_REF}`));
  assert.ok(fs.existsSync(first.keyFile));
  assert.equal(first.port, 50123);
  assert.equal(first.url, "http://127.0.0.1:50123", "reached on loopback, not on a container address");
  assert.ok(!calls.some(c => /inspect/.test(c)), "no container address is looked up");
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(spaceDir(twentyHome, "spc-bbbbbbbbbbbb"), "reach.json"), "utf8")).port, 50123);
  assert.match(fs.readFileSync(path.join(spaceDir(twentyHome, "spc-bbbbbbbbbbbb"), ".env"), "utf8"), /^TWENTY_HOST_PORT=50123$/m);
  // the same Space again: already provisioned, so no resize and no second provisioning
  order.length = 0;
  const again = await o.provision({ home: twentyHome, space: "spc-bbbbbbbbbbbb", runner, memory: "small" });
  assert.deepEqual(order, [], "no room is made for a Space that is already there");
  assert.equal(again.port, 50123, "the recorded port is kept across restarts");
  assert.equal(readLoopbackPort(spaceDir(twentyHome, "spc-bbbbbbbbbbbb")), 50123);
  await fake.stop();
});

test("when the VM cannot be given room, nothing is provisioned and the person is told to use their server", async () => {
  const home = tmp(); const calls = [];
  const o = macStoreOptions({ home, env: { HOME: home, DOCKER_HOST: "unix:///c.sock" }, makeRoom: async () => ({ ok: false, message: full.message }) });
  await assert.rejects(() => o.provision({ home: path.join(home, "kernel", "spaces", "spc_c", "twenty-home"), space: "spc-c", runner: { exec: async (...a) => { calls.push(a); return { stdout: "", stderr: "" }; }, fetch, sleep: async () => {} } }),
    e => e.code === "unavailable" && /your server/.test(e.message));
  assert.deepEqual(calls, [], "no docker call was made");
});

test("a Linux compose publishes no port; the Mac one publishes Twenty on 127.0.0.1 only, through a proxy, and Twenty keeps the internal network alone", () => {
  const linux = composeFile({ space: "harlow" });
  assert.ok(!/^\s*ports:/m.test(linux) && !/proxy:/.test(linux) && !/publish/.test(linux), "no published port, no proxy, no second network on a server");
  const mac = composeFile({ space: "harlow", publish: "loopback" });
  const ports = [...mac.matchAll(/^\s*ports:\n((?:\s+- .*\n)+)/gm)].flatMap(m => m[1].trim().split("\n").map(l => l.trim()));
  assert.deepEqual(ports, ['- "127.0.0.1:${TWENTY_HOST_PORT:?}:3000"'], "one published port, bound to loopback");
  assert.ok(!/0\.0\.0\.0/.test(mac) && !/"\$\{TWENTY_HOST_PORT[^}]*\}:3000"/.test(mac), "never an unbound host address");
  const server = mac.slice(mac.indexOf("  server:"), mac.indexOf("  worker:"));
  assert.ok(!/ports:/.test(server) && /networks:\n      store:/.test(server), "Twenty's server itself has no port and sits on the internal network only");
  assert.match(mac, /networks:\n  store:\n    internal: true\n  publish: \{\}/, "the store network stays internal; only the proxy's own network is ordinary");
  const proxy = mac.slice(mac.indexOf("  proxy:"), mac.indexOf("networks:\n  store"));
  assert.match(proxy, /networks: \[store, publish\]/);
  assert.ok(proxy.includes(PROXY_IMAGE));
  for (const m of mac.matchAll(/^\s+image: (.*)$/gm)) assert.match(m[1], /@sha256:[0-9a-f]{64}/, `an unpinned image: ${m[1]}`);
});

test("pickLoopbackPort gives a free dynamic-range port", async () => {
  const p = await pickLoopbackPort();
  assert.ok(p >= 49152 && p < 65152, String(p));
});
