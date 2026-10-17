// @ts-check
// The streaming run: a harness session started as an agent's own Linux user. The ticket carries what to run and is checked when it is registered; the relay starts the run helper as the agent's
// uid with nothing extra and hands it the command as its first frame; the helper's own text is checked for the rules it keeps (it needs a container and a uid in the agent range to run).

import "../../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Tickets, createRelay, RUN, frame } from "./agentd-relay.js";
import { createAgentd } from "./agentd-server.js";
import { callAgentd } from "./agentd-client.js";
import { homeOf } from "./agentd.js";
import { makeAgentRun } from "../agent-run.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const U = { user: "ag20003", uid: 20003, display: 23 };
const HOME = homeOf("ag20003");
const T1 = "a".repeat(32), T2 = "b".repeat(40);
const SPEC = { argv: ["/usr/local/bin/claude", "-p"], cwd: `${HOME}/work`, env: { ANTHROPIC_BASE_URL: "http://10.0.0.2:9000", ANTHROPIC_AUTH_TOKEN: "session-token" } };

test("a run ticket carries what to run, checked when it is registered; no other kind carries anything", () => {
  const t = new Tickets();
  t.add(T1, U, "run", null, SPEC);
  const got = t.take(T1);
  assert.equal(got?.kind, "run");
  assert.deepEqual(got?.spec, { argv: SPEC.argv, cwd: SPEC.cwd, env: SPEC.env });
  assert.equal(t.take(T1), null, "single use");
  assert.throws(() => t.add(T2, U, "run", null, null), /names what to run/);
  assert.throws(() => t.add(T2, U, "vnc", null, SPEC), /names what to run/);
  assert.throws(() => t.add(T2, U, "run", "work", SPEC), /no terminal/);
  for (const bad of [{ ...SPEC, argv: ["claude"] }, { ...SPEC, cwd: "/etc" }, { ...SPEC, cwd: "/var/lib/vyre/agents/ag20004/home" }, { ...SPEC, env: { LD_PRELOAD: "x" } }, { ...SPEC, env: { PATH: "/x" } }, { ...SPEC, argv: [] }]) {
    assert.throws(() => t.add(T2, U, "run", null, bad), undefined, JSON.stringify(bad).slice(0, 60));
  }
});

test("the relay starts the run helper as the agent's uid with no capability, tells it what to run as its first frame, then joins the connection", async t => {
  const tickets = new Tickets();
  /** @type {string[][]} */ const spawned = [];
  /** @type {Buffer[]} */ const toHelper = [];
  const relay = createRelay({ tickets, peer: () => "127.0.0.1", helloMs: 300, spawn: argv => {
    spawned.push(argv);
    const child = spawn("/bin/cat", [], { stdio: ["pipe", "pipe", "ignore"] });
    const write = child.stdin.write.bind(child.stdin);
    child.stdin.write = (/** @type {any} */ b, ...rest) => { toHelper.push(Buffer.from(b)); return write(b, ...rest); };
    return child;
  } });
  await new Promise(r => relay.listen(0, "127.0.0.1", () => r(undefined)));
  t.after(() => relay.close());
  const port = /** @type {any} */ (relay.address()).port;
  tickets.add(T1, U, "run", null, SPEC);
  const s = net.connect(port, "127.0.0.1");
  s.on("error", () => {});
  t.after(() => s.destroy());
  await new Promise(r => s.on("connect", () => r(null)));
  s.write(`${T1}\n`);
  s.write(frame(0, Buffer.from("hello")));
  const back = await new Promise(r => { let b = Buffer.alloc(0); s.on("data", d => { b = Buffer.concat([b, d]); if (b.length >= 8 + 5 + 5 + 5) r(b); }); });
  for (let n = 0; n < 50 && Buffer.concat(toHelper).length < 1; n++) await new Promise(r => setTimeout(r, 20));
  const want = () => { const b = Buffer.concat(toHelper); return b.length >= 5 && b.length >= 5 + b.readUInt32BE(1) + 5; };
  for (let n = 0; n < 100 && !want(); n++) await new Promise(r => setTimeout(r, 20));
  assert.equal(spawned.length, 1);
  const line = spawned[0].join(" ");
  assert.match(line, /^\/usr\/bin\/setpriv --reuid=20003 --regid=20003 --clear-groups --inh-caps=-all --ambient-caps=-all --bounding-set=-all --no-new-privs /);
  assert.ok(line.endsWith(`/usr/bin/python3 -I ${RUN}`), "one fixed helper and nothing from the ticket on its command line");
  assert.ok(!line.includes("session-token") && !line.includes("claude"), "the command and its variables are not on the command line");
  // cat echoes: the first thing it was written is the spec frame (type 4), then the connection's own frame
  const first = Buffer.concat(toHelper);
  assert.equal(first[0], 4);
  const n = first.readUInt32BE(1);
  assert.deepEqual(JSON.parse(first.subarray(5, 5 + n).toString()), { argv: SPEC.argv, cwd: SPEC.cwd, env: SPEC.env });
  assert.deepEqual([...first.subarray(5 + n, 5 + n + 5)], [0, 0, 0, 0, 5]);
  assert.ok(back.length > 0);
});

test("agentd registers a run ticket through its own action, refuses a bad command, and a wrong token gets nothing", async t => {
  const dir = fs.mkdtempSync(path.join((await import("../../../test/scratch.mjs")).SCRATCH, "vyre-run-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const tickets = new Tickets();
  const server = createAgentd({ token: "t".repeat(40), tickets, run: async () => {} });
  const socket = path.join(dir, "s.sock");
  await new Promise(r => server.listen(socket, () => r(null)));
  t.after(() => server.close());
  const call = (/** @type {any} */ body, token = "t".repeat(40)) => callAgentd({ socket, token, action: "ticket", body: JSON.stringify(body) });
  const base = { ...U, ticket: T1, kind: "run" };
  assert.equal((await call({ ...base, ...SPEC })).status, 200);
  assert.equal(tickets.take(T1)?.kind, "run");
  assert.equal((await call({ ...base, ticket: T2, ...SPEC, cwd: "/etc" })).status, 400);
  assert.equal((await call({ ...base, ticket: T2, ...SPEC, argv: ["sh", "-c", "id"] })).status, 400);
  assert.equal((await call({ ...base, ticket: T2, ...SPEC, session: "x" })).status, 400);
  assert.equal((await call({ ...base, ticket: T2, ...SPEC, uid: 1000, user: "ag1000" })).status, 400);
  assert.equal((await call({ ...base, ticket: T2, ...SPEC }, "x".repeat(40))).status, 401);
  assert.equal(tickets.take(T2), null, "nothing bad was registered");
});

test("computers.run.open: the agent's own session needs no further word; anyone else needs edit; a computer that does not answer is unavailable; a refused command is bad input", async () => {
  /** @type {string[]} */ const log = [];
  const make = (/** @type {any} */ o = {}) => makeAgentRun({
    resolve: async (i, caller) => String(i.agent || caller.replace(/^mcp:agent:/, "")), claimOf: c => (c.startsWith("mcp:agent:") ? c.slice("mcp:agent:".length) : null),
    mayUse: async (need, agent) => { log.push(`level ${need} ${agent}`); if (o.deny) throw Object.assign(new Error("no"), { code: "denied" }); },
    place: async a => { log.push(`place ${a}`); }, ticket: async (a, h, s) => { log.push(`ticket ${a}`); if (o.ticketError) throw new Error(o.ticketError); assert.match(h, /^[A-Za-z0-9_-]{32}$/); assert.deepEqual(s.argv, ["/usr/local/bin/claude"]); },
    where: async () => { if (o.down) throw new Error("not running"); return { host: "10.0.0.5", port: 5910 }; } });
  const input = { argv: ["/usr/local/bin/claude"] };
  const own = await make()({ ...input, agent: "ads" }, "mcp:agent:ads");
  assert.deepEqual(log, ["place ads", "ticket ads"], "no level check for its own session");
  assert.equal(own.host, "10.0.0.5"); assert.equal(own.port, 5910); assert.match(own.hello, /\n$/);
  log.length = 0;
  await make()({ ...input, agent: "ads" }, "module:runner");
  assert.deepEqual(log, ["level edit ads", "place ads", "ticket ads"]);
  log.length = 0;
  await assert.rejects(() => make({ deny: true })({ ...input, agent: "ads" }, "module:runner"), e => /** @type {any} */ (e).code === "denied");
  assert.deepEqual(log, ["level edit ads"], "nothing was placed or ticketed");
  await assert.rejects(() => make({ down: true })({ ...input, agent: "ads" }, "mcp:agent:ads"), e => /** @type {any} */ (e).code === "computer_unavailable");
  await assert.rejects(() => make({ ticketError: "the agent computer could not ticket (400: the command must be an absolute path)" })({ ...input, agent: "ads" }, "mcp:agent:ads"), e => /** @type {any} */ (e).code === "bad_input");
  await assert.rejects(() => make({ ticketError: "the agent computer could not ticket (502)" })({ ...input, agent: "ads" }, "mcp:agent:ads"), e => /** @type {any} */ (e).code === "computer_unavailable");
});

test("the run helper keeps its rules: the agent range only, a home it builds from its uid, no shell, a fixed set of signals, the same forbidden names as agentd", () => {
  const py = fs.readFileSync(path.join(HERE, "agentd-run.py"), "utf8");
  assert.match(py, /uid < 20000 or uid > 20063 or uid != os\.getuid\(\) or len\(sys\.argv\) != 1/);
  assert.match(py, /HOME = "\/var\/lib\/vyre\/agents\/%s\/home" % USER/);
  assert.match(py, /os\.path\.realpath\(/, "a link cannot lead out of the home");
  assert.doesNotMatch(py, /shell\s*=\s*True|os\.system|"\/bin\/sh"|sh -c/);
  assert.match(py, /subprocess\.Popen\(argv, cwd=real, env=env,/, "the clean environment, not a copy of the helper's");
  assert.match(py, /SIGNALS = \{signal\.SIGINT, signal\.SIGTERM, signal\.SIGKILL, signal\.SIGHUP\}/);
  const agentd = fs.readFileSync(path.join(HERE, "agentd.js"), "utf8");
  const forbidden = (/** @type {string} */ s, /** @type {RegExp} */ re) => re.exec(s)?.[1];
  assert.equal(forbidden(py, /FORBIDDEN = re\.compile\(r"\^\((.*?)\)\$"\)/), forbidden(agentd, /EXEC_FORBIDDEN = \/\^\((.*?)\)\$\//), "one list of names a caller may not set");
  assert.doesNotMatch(py, /environ/, "nothing is read from its own environment");
});

test("the computer image carries the same pinned harnesses as the box", () => {
  const computer = fs.readFileSync(path.join(HERE, "Dockerfile"), "utf8");
  const box = fs.readFileSync(path.join(HERE, "..", "..", "..", "box", "Dockerfile"), "utf8");
  for (const arg of ["CLAUDE_CODE_VERSION", "CODEX_VERSION", "CODEX_ACP_VERSION", "GROK_VERSION", "GROK_SHA256_AMD64", "GROK_SHA256_ARM64"]) {
    const re = new RegExp(`^ARG ${arg}=(\\S+)$`, "m");
    assert.ok(re.exec(computer), `${arg} is in the computer image`);
    assert.equal(re.exec(computer)?.[1], re.exec(box)?.[1], `${arg} is the box's`);
  }
  assert.match(computer, /sha256sum -c -/, "Grok's binary is checked against its sum");
  assert.match(computer, /apt-get purge -y --auto-remove curl/, "curl does not stay in the image");
  assert.match(computer, /COPY agentd\.js[^\n]*agentd-run\.py/);
});
