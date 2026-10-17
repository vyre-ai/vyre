// @ts-check
// The screen relay: a connection with no good ticket gets nothing; a ticket works once, for the agent it names, and the pipe is started as that agent's uid with no capability.

import "../../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { Tickets, createRelay, PIPE, TICKET_MS } from "./agentd-relay.js";
import { createAgentd } from "./agentd-server.js";
import { callAgentd } from "./agentd-client.js";
import { SCRATCH } from "../../../test/scratch.mjs";

const U = { user: "ag20003", uid: 20003, display: 23 };
const T1 = "a".repeat(32), T2 = "b".repeat(40);

async function world(t, o = {}) {
  const tickets = new Tickets();
  /** @type {string[][]} */ const spawned = [];
  // the stand-in for the agent's pipe is cat: it echoes what it is sent, which is all the relay needs from it
  const relay = createRelay({ tickets, peer: () => "127.0.0.1", spawn: argv => { spawned.push(argv); return spawn("/bin/cat", [], { stdio: ["pipe", "pipe", "ignore"] }); }, helloMs: 300, ...o });
  await new Promise(r => relay.listen(0, "127.0.0.1", () => r(undefined)));
  t.after(() => relay.close());
  const port = /** @type {any} */ (relay.address()).port;
  return { tickets, spawned, port };
}
const connect = (port, hello) => new Promise(resolve => { const s = net.connect(port, "127.0.0.1", () => { s.write(hello); resolve(s); }); s.on("error", () => {}); });
const closes = s => new Promise(resolve => { s.on("close", () => resolve(true)); setTimeout(() => resolve(false), 1000).unref(); });

test("a good ticket joins the viewer to the agent's pipe, run as that agent's uid with every capability dropped", async t => {
  const w = await world(t);
  w.tickets.add(T1, U);
  const s = await connect(w.port, `${T1}\nRFB 003.008\n`);
  const echoed = await new Promise(r => s.once("data", d => r(String(d))));
  assert.equal(echoed, "RFB 003.008\n", "bytes after the ticket line went to the pipe, and the pipe's bytes came back");
  assert.equal(w.spawned.length, 1);
  const argv = w.spawned[0].join(" ");
  assert.match(argv, /^\/usr\/bin\/setpriv --reuid=20003 --regid=20003 --clear-groups --inh-caps=-all --ambient-caps=-all --bounding-set=-all --no-new-privs /);
  assert.ok(argv.endsWith(`/usr/bin/python3 -I ${PIPE} vnc`), "one fixed word, never a path: the pipe builds the socket from its own uid");
  s.destroy();
});

test("a ticket is single use, and a wrong, short or expired one gets nothing and no process", async t => {
  const clock = { t: 1000 };
  const tickets = new Tickets(() => clock.t);
  const w = await world(t, { tickets });
  tickets.add(T1, U);
  const first = await connect(w.port, `${T1}\n`);
  await new Promise(r => setTimeout(r, 100));
  first.destroy();
  assert.equal(w.spawned.length, 1);
  for (const bad of [`${T1}\n`, `${T2}\n`, "short\n", `${"c".repeat(70)}\n`, "../../etc/passwd\n"]) {
    const s = await connect(w.port, bad);
    assert.equal(await closes(s), true, bad);
  }
  tickets.add(T2, U);
  clock.t += TICKET_MS + 1;
  assert.equal(await closes(await connect(w.port, `${T2}\n`)), true, "expired");
  assert.equal(w.spawned.length, 1, "none of those started a process");
});

test("a connection that says nothing is closed, and no one agent holds more than its share", async t => {
  const w = await world(t, { maxPerAgent: 1 });
  const quiet = net.connect(w.port, "127.0.0.1"); quiet.on("error", () => {});
  assert.equal(await closes(quiet), true, "silence is cut off after the hello time");
  w.tickets.add(T1, U); w.tickets.add(T2, U);
  const one = await connect(w.port, `${T1}\n`);
  await new Promise(r => setTimeout(r, 100));
  const two = await connect(w.port, `${T2}\n`);
  assert.equal(await closes(two), true, "a second screen for the same agent is refused");
  assert.equal(w.spawned.length, 1);
  one.destroy();
});

test("a viewer who leaves ends the pipe's input, so the pipe ends", async t => {
  const w = await world(t);
  w.tickets.add(T1, U);
  const s = await connect(w.port, `${T1}\n`);
  await new Promise(r => setTimeout(r, 100));
  s.destroy();
  await new Promise(r => setTimeout(r, 200));
  w.tickets.add(T2, U);
  const again = await connect(w.port, `${T2}\n`);
  again.write("x");
  assert.equal(await new Promise(r => again.once("data", d => r(String(d)))), "x", "the slot of the first viewer was given back");
  again.destroy();
});

test("agentd takes a ticket only for a real agent triple, and only with its bearer", async t => {
  const tickets = new Tickets();
  const server = createAgentd({ token: "t".repeat(40), tickets, run: async () => {} });
  const socket = path.join(fs.mkdtempSync(path.join(SCRATCH, "vyre-relay-")), "a.sock");
  await new Promise(r => server.listen(socket, () => r(undefined)));
  t.after(() => server.close());
  const call = (token, body) => callAgentd({ socket, token, action: "ticket", body: JSON.stringify(body) });
  assert.equal((await call("t".repeat(40), { ...U, ticket: T1 })).status, 200);
  assert.deepEqual(tickets.take(T1), { ...U, kind: "vnc", session: null });
  assert.equal((await call("x".repeat(40), { ...U, ticket: T1 })).status, 401);
  assert.equal((await call("t".repeat(40), { user: "root", uid: 0, display: 0, ticket: T1 })).status, 400);
  assert.equal((await call("t".repeat(40), { ...U, uid: 20004, ticket: T1 })).status, 400, "a user that is not the uid's");
  assert.equal((await call("t".repeat(40), { ...U, ticket: "short" })).status, 400);
  assert.equal(tickets.take(T1), null);
});

test("the pipe takes no argument and no environment: it builds the agent's socket from its own uid", () => {
  const py = fs.readFileSync(new URL("./agentd-pipe.py", import.meta.url), "utf8");
  assert.match(py, /os\.geteuid\(\)/);
  assert.match(py, /"\/var\/lib\/vyre\/agents\/ag%d\/vnc\.sock" % uid/);
  assert.doesNotMatch(py, /sys\.argv|os\.environ|getenv/);
  assert.match(py, /uid < 20000 or uid > 20063/);
});

test("a peer that is not vyred's address is closed before it can send a ticket; with no pin yet, nobody is let in", async t => {
  for (const peer of [() => "10.9.9.9", () => null]) {
    const w = await world(t, { peer });
    w.tickets.add(T1, U);
    const s = await connect(w.port, `${T1}\n`);
    assert.equal(await closes(s), true);
    assert.equal(w.spawned.length, 0, "no process");
    assert.deepEqual(w.tickets.take(T1), { ...U, kind: "vnc", session: null }, "the ticket was never read, so it is not spent");
  }
});

test("a terminal ticket starts the terminal helper as that agent with the session name as its one argument; a bad name is never registered", async t => {
  const w = await world(t);
  w.tickets.add(T1, U, "term", "work-1");
  const s = await connect(w.port, `${T1}\n`);
  await new Promise(r => setTimeout(r, 100));
  const argv = w.spawned[0].join(" ");
  assert.match(argv, /^\/usr\/bin\/setpriv --reuid=20003 --regid=20003 --clear-groups --inh-caps=-all --ambient-caps=-all --bounding-set=-all --no-new-privs /);
  assert.ok(argv.endsWith("/usr/bin/python3 -I /opt/agentd/agentd-term.py work-1"));
  s.destroy();
  for (const bad of ["", "a b", "x;rm", "../x", "a".repeat(41)]) assert.throws(() => w.tickets.add(T2, U, "term", bad), /not a terminal name/, bad);
});

test("the terminal helper takes one checked name and builds the agent's tmux socket from its own uid", () => {
  const py = fs.readFileSync(new URL("./agentd-term.py", import.meta.url), "utf8");
  assert.match(py, /os\.geteuid\(\)/);
  assert.match(py, /"\/var\/lib\/vyre\/agents\/ag%d\/tmux\.sock" % uid/);
  assert.match(py, /\[A-Za-z0-9_\.-\]\{1,40\}/);
  assert.doesNotMatch(py, /os\.environ\[(?!"TERM")|getenv|shell=True|os\.system/);
  assert.match(py, /uid < 20000 or uid > 20063/);
});

test("agentd lists an agent's terminals through tmux run as that agent, only for a real triple, and registers a terminal ticket with its session", async t => {
  const tickets = new Tickets();
  /** @type {string[][]} */ const asked = [];
  const server = createAgentd({ token: "t".repeat(40), tickets, run: async () => {}, out: async argv => { asked.push(argv); return "work 2\nbad name here 1\nlogs 1\n"; } });
  const socket = path.join(fs.mkdtempSync(path.join(SCRATCH, "vyre-term-")), "a.sock");
  await new Promise(r => server.listen(socket, () => r(undefined)));
  t.after(() => server.close());
  const call = (action, body, token = "t".repeat(40)) => callAgentd({ socket, token, action, body: JSON.stringify(body) });
  const r = await call("terminals", U);
  assert.equal(r.status, 200);
  assert.deepEqual(JSON.parse(r.text), { sessions: [{ name: "work", windows: 2 }, { name: "logs", windows: 1 }] }, "a line that is not a session is dropped");
  assert.match(asked[0].join(" "), /^\/usr\/bin\/setpriv --reuid=20003 .* --no-new-privs -- .* \/usr\/bin\/tmux -S \/var\/lib\/vyre\/agents\/ag20003\/tmux\.sock list-sessions -F /);
  assert.equal((await call("terminals", U, "x".repeat(40))).status, 401);
  assert.equal((await call("terminals", { user: "root", uid: 0, display: 0 })).status, 400);
  assert.equal((await call("ticket", { ...U, ticket: T1, session: "work" })).status, 200);
  assert.deepEqual(tickets.take(T1), { ...U, kind: "term", session: "work" });
  assert.equal((await call("ticket", { ...U, ticket: T2, session: "a b" })).status, 400);
});

test("a debugging ticket starts the pipe with the word cdp and can only be a cdp one; the kinds are a closed list and never mix", async t => {
  const w = await world(t);
  w.tickets.add(T1, U, "cdp");
  const s = await connect(w.port, `${T1}\n`);
  await new Promise(r => setTimeout(r, 100));
  assert.ok(w.spawned[0].join(" ").endsWith(`/usr/bin/python3 -I ${PIPE} cdp`));
  s.destroy();
  assert.throws(() => w.tickets.add(T2, U, "root"), /not a ticket kind/);
  assert.throws(() => w.tickets.add(T2, U, "cdp", "work"), /names its terminal/);
  assert.throws(() => w.tickets.add(T2, U, "term"), /names its terminal/);
  w.tickets.add(T2, U, "vnc");
  assert.equal(w.tickets.take(T2).kind, "vnc", "a screen ticket is a screen ticket and cannot be spent as the other");
});

test("agentd registers a cdp ticket only as exactly that kind, and the holder's limits are pinned", async t => {
  const tickets = new Tickets();
  const server = createAgentd({ token: "t".repeat(40), tickets, run: async () => {} });
  const socket = path.join(fs.mkdtempSync(path.join(SCRATCH, "vyre-cdp-")), "a.sock");
  await new Promise(r => server.listen(socket, () => r(undefined)));
  t.after(() => server.close());
  const call = body => callAgentd({ socket, token: "t".repeat(40), action: "ticket", body: JSON.stringify(body) });
  assert.equal((await call({ ...U, ticket: T1, kind: "cdp" })).status, 200);
  assert.equal(tickets.take(T1).kind, "cdp");
  assert.equal((await call({ ...U, ticket: T1, kind: "pipe" })).status, 400);
  assert.equal((await call({ ...U, ticket: T1, kind: "cdp", session: "work" })).status, 400);
  const py = fs.readFileSync(new URL("./agentd-chrome.py", import.meta.url), "utf8");
  assert.match(py, /uid < 20000 or uid > 20063 or uid != os\.getuid\(\) or len\(sys\.argv\) != 1/);
  assert.match(py, /"--remote-debugging-pipe"/);
  assert.doesNotMatch(py, /remote-debugging-port|os\.environ|getenv|shell=True/);
  assert.match(py, /MAX_MSG = 16 \* 1024 \* 1024/);
  assert.match(py, /MAX_PENDING = /);
  assert.match(py, /IDLE = 600/);
  assert.match(py, /RUN \+ "\/cdp\.sock"/);
  assert.match(py, /os\.chmod\(SOCK, 0o600\)/);
  assert.match(py, /else:\n\s+c\.close\(\)/, "a second client is refused, never allowed to replace the first");
});
