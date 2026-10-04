// @ts-check
// The box's reads take in the paired Mac's rows (docs/work/federation.md, design 4 and the first
// half of 5): projects.catalog, projects.list, recall.search, recall.sessions, recall.thread and
// threads.list answer with both machines' rows, labelled, for the person only; agents, MCP,
// guests and modules that do not ask get the box's own. A Mac that is away costs the box nothing
// but its rows, and nothing the Mac answers is stored on the box.

import "../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SESSIONS } from "./fixtures/corpus.js";
import { OWNER, PHONE, until, pair } from "./link-harness.js";

const T0 = Date.parse("2026-09-01T09:00:00Z");
/** The box's own session: newer than every one on the Mac, and about the same intake form. */
const BOX_SESSIONS = [{
  id: "22222222-bbbb-4000-8000-000000000001",
  cwd: "/home/alex/Work/harlow-box",
  name: "Harlow intake on the box",
  start: T0 + 600 * 60_000,
  turns: [
    { role: /** @type {const} */ ("user"), text: "Check the Harlow intake form on the box and give the email field a label." },
    { role: /** @type {const} */ ("assistant"), text: "The intake form's email field has a label now, and the box serves the new form." },
  ],
}];
const BOX_ID = BOX_SESSIONS[0].id;
const MAC_ID = SESSIONS[0].id;

/** Both machines paired and indexed, with the Mac holding its request. */
async function world(t, opts = {}) {
  const s = await pair(t, { macTranscripts: true, boxTranscripts: BOX_SESSIONS, ...opts });
  for (const call of [s.macCall, s.boxCall]) { const r = await call("recall.index"); assert.ok(!r.error, JSON.stringify(r.error)); }
  await online(s);
  return s;
}
const online = s => until(async () => { const m = (await s.boxCall("link.macs")).data; return m.length === 1 && m[0].online && m; });
const offline = s => until(async () => { const m = (await s.boxCall("link.macs")).data; return m.length === 1 && !m[0].online && m; });
/** A tool on the box as a caller, answering its data or failing the test. */
async function asBox(s, tool, input, caller = "deck") {
  const r = await s.boxCall(tool, input, caller, caller.startsWith("tailnet:") ? { peer: PHONE } : {});
  assert.ok(!r.error, `${tool} as ${caller}: ${JSON.stringify(r.error)}`);
  return r.data;
}
const sorted = (rows, key) => rows.every((r, i) => i === 0 || (rows[i - 1][key] || 0) >= (r[key] || 0));
/** A headless thread's row, as the switchboard keeps it. */
const seedThread = (d, id, last) => d.registry.deps.db.prepare("INSERT INTO threads_runs (id, name, cwd, status, started_at, last_at) VALUES (?,?,?,?,?,?)")
  .run(id, `thread ${id}`, "/home/alex/Work", "stopped", last - 1000, last);

test("federation reads: the person on the box reads both machines, every row labelled with its machine", async t => {
  const s = await world(t);
  const mac = (await s.macCall("projects.catalog", { limit: 100 })).data;
  assert.ok(mac.total > 1 && mac.total < 100, `the Mac has its own sessions: ${mac.total}`);

  // with the kernel on, a tailnet node is not a person by its label (the built-in network replaces it); the person's own surfaces carry the listener's facts (test/link-harness.js)
  for (const caller of ["deck", "cli", "capsule", ...(s.box.kernel ? [] : [`tailnet:${OWNER}`])]) {
    const c = await asBox(s, "projects.catalog", { limit: 100 }, caller);
    assert.deepEqual(c.sources, [{ source: "box", machine: "testbox", ok: true, total: 1 }, { source: "mac", machine: "test-mac", ok: true, total: mac.total }], caller);
    assert.equal(c.total, 1 + mac.total);
    assert.equal(c.sessions.length, 1 + mac.sessions.length);
    assert.deepEqual([c.sessions[0].id, c.sessions[0].source, c.sessions[0].machine], [BOX_ID, "box", "testbox"], "the box's session is the newest");
    assert.ok(c.sessions.slice(1).every(r => r.source === "mac" && r.machine === "test-mac"));
    assert.ok(sorted(c.sessions, "last"), "newest activity first across machines");
  }
  // The limit applies to the merged list; total still counts every machine.
  const two = await asBox(s, "projects.catalog", { limit: 2 });
  assert.equal(two.sessions.length, 2);
  assert.equal(two.total, 1 + mac.total);
  // q goes to the Mac as well: both machines have sessions about the intake form.
  const q = await asBox(s, "projects.catalog", { q: "intake", limit: 50 });
  assert.deepEqual([...new Set(q.sessions.map(r => r.source))].sort(), ["box", "mac"], JSON.stringify(q.sessions.map(r => [r.source, r.name])));
  assert.equal(q.sessions[0].titled, true, "title matches first, from either machine");

  const hits = await asBox(s, "recall.search", { q: "intake form", limit: 4 });
  assert.ok(hits.length > 0 && hits.length <= 4, `capped at the limit: ${hits.length}`);
  assert.ok(sorted(hits, "score"), "by score across machines");
  assert.ok(hits.some(h => h.source === "box" && h.session === BOX_ID), "the box's hit");
  assert.ok(hits.some(h => h.source === "mac" && h.machine === "test-mac"), "the Mac's hits");
  assert.equal((await asBox(s, "recall.search", { q: "intake form" })).length <= 10, true, "the tool's default limit when none is given");

  const sessions = await asBox(s, "recall.sessions", { limit: 50 });
  const macSessions = (await s.macCall("recall.sessions", { limit: 50 })).data;
  assert.deepEqual(sessions.map(x => x.id).sort(), [BOX_ID, ...macSessions.map(x => x.id)].sort());
  assert.equal(sessions[0].id, BOX_ID);
  assert.ok(sorted(sessions, "ended"), "newest first across machines");
  assert.ok(sessions.every(x => (x.source === "box") === (x.id === BOX_ID) && x.machine === (x.source === "box" ? "testbox" : "test-mac")));
  assert.equal((await asBox(s, "recall.sessions", { limit: 2 })).length, 2);

  seedThread(s.box, "box-thread", T0);
  seedThread(s.mac, "mac-thread", T0 + 60_000);
  const threads = await asBox(s, "threads.list", { all: true });
  assert.deepEqual(threads.map(x => [x.id, x.source, x.machine]), [["mac-thread", "mac", "test-mac"], ["box-thread", "box", "testbox"]]);

  const home = (dir, name) => path.join(dir, name);
  assert.ok(!(await s.boxCall("projects.create", { name: "Harlow Legal", home: home(s.boxWork, "harlow") })).error);
  assert.ok(!(await s.macCall("projects.create", { name: "Northwind Bakery", home: home(s.macWork, "northwind") })).error);
  const projects = await asBox(s, "projects.list", {});
  assert.deepEqual(projects.projects.map(p => [p.name, p.source, p.machine]), [["Harlow Legal", "box", "testbox"], ["Northwind Bakery", "mac", "test-mac"]]);
  assert.deepEqual(projects.sources, [{ source: "box", machine: "testbox", ok: true }, { source: "mac", machine: "test-mac", ok: true }]);
  assert.deepEqual(projects.problems, []);
});

test("federation reads: machines local, agents, MCP, guests and modules that do not ask get the box's rows only", async t => {
  const s = await world(t);
  const boxOnly = async (caller, input = {}) => {
    // projects.catalog lists every session with its first message, so a model, a guest and an unknown label are refused it by the callers list (group D, kernel-declare); the person's surfaces and modules get the box's rows.
    const private_ = !/^(deck|cli|module:)/.test(caller);
    let c;
    try { c = await asBox(s, "projects.catalog", { limit: 100, ...input }, caller); } catch (e) { if (private_ && /not available/.test(String(e && e.message))) c = null; else throw e; }
    if (!c) { assert.ok(private_, caller); } else {
    assert.equal(c.total, 1, `${caller}: ${JSON.stringify(c.sources)}`);
    assert.equal(c.sources, undefined, caller);
    assert.deepEqual(c.sessions.map(r => r.id), [BOX_ID], caller);
    assert.ok(c.sessions.every(r => r.source === undefined), `${caller}: rows are as they were, unlabelled`);
    }
    // Recall's own scope (memory-iq 6f898294, core/recall/index.js's own reach(), a 1:1 mirror of
    // core/memory's — it does NOT call projects.reach; that's core/projects/core/files' own door,
    // a separate copy by design so recall never waits on projects being installed at all) may
    // refuse a caller outright, but ONLY one that names an agent this world never created, or one
    // recall's own OWNER/ownSession/ownerDevice never recognises as the owner (a tailnet guest,
    // "unknown"): those cover "deck", "cli" and every "module:" caller (module:x included; a bare "mcp"
    // is an unnamed model session, never the person: MS-1, RC-1 3b98bbd80), so none of those may ever come back denied here, or a real regression
    // that refused the person's own surfaces (or a module) would pass this test silently
    // (reviewer, on the integrator's earlier "denied" is fine for every caller check — verified
    // by temporarily dropping "deck" from recall's own OWNER set: this now fails loudly instead
    // of passing quiet).
    const mayDeny = /agent:/.test(caller) || caller === "mcp" || caller === "unknown" || caller.startsWith("tailnet-guest:");
    const recall = async (tool, args) => {
      const r = await s.boxCall(tool, args, caller, caller.startsWith("tailnet:") ? { peer: PHONE } : {});
      if (r.error) {
        assert.ok(mayDeny, `${tool} as ${caller}: refused, but this caller is one of the person's own surfaces or a module — it must never be: ${JSON.stringify(r.error)}`);
        assert.equal(r.error.code, "denied", `${tool} as ${caller}: ${JSON.stringify(r.error)}`);
        return null;
      }
      return r.data;
    };
    const rows = await recall("recall.sessions", { limit: 50, ...input });
    // A bare `mcp` is an unnamed model session: never the person (MS-1, KW-1, RC-1 3b98bbd80), it reads only its own thread's project, and a bare one has no thread, so it reads no sessions.
    if (rows) assert.deepEqual(rows.map(x => x.id), caller === "mcp" ? [] : [BOX_ID], caller);
    else assert.ok(mayDeny, `${caller}: recall.sessions was refused but must have answered`);
    const hits = await recall("recall.search", { q: "intake form", ...input });
    if (hits) assert.ok(hits.every(h => h.session === BOX_ID), caller);
    else assert.ok(mayDeny, `${caller}: recall.search was refused but must have answered`);
    const th = await s.boxCall("recall.thread", { session: MAC_ID, ...input }, caller);
    if (th.error && th.error.code === "denied") assert.ok(mayDeny, `${caller}: recall.thread was refused but must have answered`);
    else assert.match(th.error ? th.error.message : "answered", /^no session/, `${caller}: the Mac's session is not reached`);
  };
  await boxOnly("deck", { machines: "local" });
  await boxOnly("cli", { machines: "local" });
  for (const caller of ["mcp", "mcp:agent:kit", "harness:agent:juno", "tailnet-guest:sam@harlow.example", "tailnet:agent:kit", "module:x", "unknown"]) {
    await boxOnly(caller);
    // Asking for every machine does not change that; only a module may ask (below).
    if (!caller.startsWith("module:")) await boxOnly(caller, { machines: "all" });
  }
  // A module that asks for every machine gets them.
  const all = await asBox(s, "projects.catalog", { limit: 100, machines: "all" }, "module:x");
  assert.equal(all.sources.length, 2);
  assert.ok(all.total > 1);
});

test("federation reads: an offline Mac leaves the box's rows, says mac_offline, and costs no wait", async t => {
  const s = await world(t);
  await s.stopTailnet();
  await offline(s);
  const c = await asBox(s, "projects.catalog", { limit: 100 });
  assert.deepEqual(c.sources, [{ source: "box", machine: "testbox", ok: true, total: 1 }, { source: "mac", machine: "test-mac", ok: false, error: "mac_offline" }]);
  assert.deepEqual(c.sessions.map(r => [r.id, r.source]), [[BOX_ID, "box"]]);
  assert.equal(c.total, 1);
  const t0 = Date.now();
  const hits = await asBox(s, "recall.search", { q: "intake form" });
  assert.ok(Date.now() - t0 < 2000, `search answered in ${Date.now() - t0} ms`);
  assert.ok(hits.length > 0 && hits.every(h => h.source === "box"));
  const th = await s.boxCall("recall.thread", { session: MAC_ID });
  assert.match(th.error.message, /mac_offline/);
  assert.equal(th.error.code, "not_found");
  assert.deepEqual((await asBox(s, "threads.list", {})), []);
});

test("federation reads: recall.thread opens a Mac session from the box and stores none of it", async t => {
  const s = await world(t);
  const db = s.box.registry.deps.db;
  const before = db.prepare("SELECT COUNT(*) AS n FROM recall_turns").get();
  const th = await asBox(s, "recall.thread", { session: MAC_ID });
  assert.deepEqual([th.source, th.machine, th.session.id, th.turns.length], ["mac", "test-mac", MAC_ID, 4]);
  // The box's own session answers from the box, without asking the Mac.
  const own = await asBox(s, "recall.thread", { session: BOX_ID });
  assert.deepEqual([own.source, own.machine, own.turns.length], ["box", "testbox", 2]);
  // source: "mac" asks the Mac even for an id the box has; the Mac does not have it.
  const forced = await s.boxCall("recall.thread", { session: BOX_ID, source: "mac" }, "deck");
  assert.match(forced.error.message, /no session .*test-mac/);
  // Nothing about the Mac's session is in the box's store.
  assert.deepEqual(db.prepare("SELECT id FROM recall_sessions").all().map(r => r.id), [BOX_ID]);
  assert.equal(Number(/** @type {any} */ (db.prepare("SELECT COUNT(*) AS n FROM recall_turns WHERE session != ?").get(BOX_ID)).n), 0);
  assert.deepEqual(db.prepare("SELECT COUNT(*) AS n FROM recall_turns").get(), before);
  const events = JSON.stringify(db.prepare("SELECT * FROM events").all());
  assert.ok(!events.includes("above the fold") && !events.includes(MAC_ID), "no event carries the Mac's words or its session");
});

test("federation reads: recall.transcript reads a Mac session as blocks from the box, and a miss stays quiet", async t => {
  const s = await world(t);
  const db = s.box.registry.deps.db;
  const before = db.prepare("SELECT COUNT(*) AS n FROM recall_turns").get();
  const mac = (await s.macCall("recall.transcript", { session: MAC_ID })).data;
  const tr = await asBox(s, "recall.transcript", { session: MAC_ID });
  assert.deepEqual([tr.source, tr.machine, tr.session.id], ["mac", "test-mac", MAC_ID]);
  assert.ok(tr.blocks.length > 0);
  assert.deepEqual(tr.blocks, mac.blocks, "the Mac's own blocks, as the Mac reads them");
  // The same from the owner's phone over the tailnet.
  assert.equal((await asBox(s, "recall.transcript", { session: MAC_ID }, s.box.kernel ? "deck" : `tailnet:${OWNER}`)).source, "mac");
  // The box's own session is the box's, labelled.
  const own = await asBox(s, "recall.transcript", { session: BOX_ID });
  assert.deepEqual([own.source, own.session.id], ["box", BOX_ID]);
  // An id no machine has is still not_found, which the Deck takes quietly.
  const miss = await s.boxCall("recall.transcript", { session: "33333333-cccc-4000-8000-000000000009" }, "deck");
  assert.equal(miss.error.code, "not_found", JSON.stringify(miss.error));
  // An agent or MCP never reads a Mac session, and nothing of it is stored on the box.
  assert.ok((await s.boxCall("recall.transcript", { session: MAC_ID }, "mcp")).error);
  assert.deepEqual(db.prepare("SELECT COUNT(*) AS n FROM recall_turns").get(), before);
});

test("federation reads: the Mac itself does not federate and never asks the box", async t => {
  const s = await world(t);
  /** Every tool the Mac asks the box for (over the tailnet) while it answers its own reads. The
   * box's own modules call through the registry too, in the background, so only tailnet callers count. */
  const asked = [];
  const real = s.box.registry.call.bind(s.box.registry);
  s.box.registry.call = (tool, input, caller, ...rest) => { if (String(caller).startsWith("tailnet:")) asked.push(tool); return real(tool, input, caller, ...rest); };
  t.after(() => { s.box.registry.call = real; });
  const own = (await s.macCall("projects.catalog", { limit: 100 })).data;
  const all = (await s.macCall("projects.catalog", { limit: 100, machines: "all" }, "module:x")).data;
  for (const c of [own, all]) {
    assert.equal(c.sources, undefined);
    assert.ok(c.sessions.every(r => r.source === undefined && r.id !== BOX_ID));
  }
  assert.ok(!(await s.macCall("recall.sessions", { limit: 50 }, "deck")).data.some(x => x.id === BOX_ID));
  assert.ok((await s.macCall("recall.thread", { session: BOX_ID }, "deck")).error);
  // The spy sees the Mac's traffic (its next link.serve), and none of it is a read.
  await until(() => asked.includes("link.serve"));
  assert.deepEqual(asked.filter(x => !x.startsWith("link.")), [], "the Mac asked the box for nothing but the link's own tools");
});

test("federation reads: onboarding on the box counts the Mac's sessions and says when the Mac is offline", async t => {
  // No sessions on the box: all of them are on the Mac.
  const s = await pair(t, { macTranscripts: true });
  // Fake tailscale and claude binaries: onboard.status asks names.status and `claude --version`.
  const bins = fs.mkdtempSync(path.join(s.boxRoot, "..", "vyre-fedbin-"));
  const env = { VYRE_TAILSCALE_BIN: process.env.VYRE_TAILSCALE_BIN, VYRE_CLAUDE_BIN: process.env.VYRE_CLAUDE_BIN };
  const fake = (name, out) => { const p = path.join(bins, name); fs.writeFileSync(p, `#!/bin/sh\ncat <<'EOF'\n${out}\nEOF\n`, { mode: 0o755 }); return p; };
  process.env.VYRE_TAILSCALE_BIN = fake("tailscale", JSON.stringify({ BackendState: "NeedsLogin", AuthURL: "https://login.tailscale.com/a/fake", TUN: true, OperatorUser: os.userInfo().username }));
  process.env.VYRE_CLAUDE_BIN = fake("claude", "2.1.0 (Claude Code)");
  t.after(() => {
    for (const [k, v] of Object.entries(env)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
    fs.rmSync(bins, { recursive: true, force: true });
  });

  assert.ok(!(await s.macCall("recall.index")).error);
  await online(s);
  const macTotal = (await s.macCall("projects.catalog", { limit: 1 })).data.total;
  const history = async () => (await asBox(s, "onboard.status", {}, "cli")).detail.history;
  // Once the box's first pass is done and the Mac has answered (a loaded machine can make one read wait).
  const on = await until(async () => { const h = await history(); return !h.running && h.machines && h.machines.every(m => m.ok) && h; });
  assert.equal(on.sessions, macTotal);
  assert.deepEqual(on.machines, [{ machine: "testbox", source: "box", sessions: 0, ok: true }, { machine: "test-mac", source: "mac", sessions: macTotal, ok: true }]);
  assert.notEqual(on.state, "blocked");

  await s.stopTailnet();
  await offline(s);
  const off = await history();
  assert.equal(off.sessions, 0);
  assert.equal(off.state, "done");
  assert.equal(off.why, "Your Mac (test-mac) is offline, so its sessions do not show here yet");
  assert.deepEqual(off.machines.map(m => [m.source, m.ok]), [["box", true], ["mac", false]]);
});

test("federation reads: a Mac session picked into a box project resolves through the Mac, and only for the person", async t => {
  const s = await world(t);
  assert.ok(!(await s.boxCall("projects.create", { name: "Harlow Legal", home: path.join(s.boxWork, "harlow") })).error);
  // juno is granted this project, so the registry lets it read it (an agent with no grant is refused).
  assert.ok(!(await s.boxCall("agents.create", { name: "juno", projects: ["harlow-legal"] })).error);
  // The Mac's session as the Mac answers it by id, and the box's own picked alongside it.
  const [mac] = (await s.macCall("recall.sessions", { ids: [MAC_ID] })).data;
  assert.equal(mac.id, MAC_ID);
  const picked = await asBox(s, "projects.add-threads", { project: "harlow-legal", threads: [MAC_ID, BOX_ID] });
  assert.deepEqual(picked.added, [MAC_ID, BOX_ID]);

  const rows = await asBox(s, "projects.threads", { project: "harlow-legal" });
  assert.deepEqual(rows.map(r => [r.id, r.source, r.machine, r.missing || false]), [[BOX_ID, "box", "testbox", false], [MAC_ID, "mac", "test-mac", false]]);
  const r = /** @type {any} */ (rows[1]);
  assert.deepEqual([r.name, r.title, r.cwd, r.last, r.turns, r.how], [mac.name, mac.title, mac.cwd, mac.ended, mac.turns, ["picked"]]);
  assert.equal(r.label, mac.name || mac.title);
  // Nothing about it is kept on the box, and the brief stays the box's own.
  const db = s.box.registry.deps.db;
  assert.deepEqual(db.prepare("SELECT id FROM recall_sessions").all().map(x => x.id), [BOX_ID]);
  const brief = await asBox(s, "projects.context", { project: "harlow-legal" }, "cli");
  assert.ok(!brief.text.includes(r.label), "the brief lists the box's threads only");
  // A module that asks for every machine gets it resolved too.
  assert.equal((await asBox(s, "projects.threads", { project: "harlow-legal", machines: "all" }, "module:x")).find(x => x.id === MAC_ID).source, "mac");

  // Agents, MCP, guests, modules that do not ask, and machines: "local" see a missing pick, unlabelled.
  const missing = async (caller, input = {}) => {
    const list = await asBox(s, "projects.threads", { project: "harlow-legal", ...input }, caller);
    const m = list.find(x => x.id === MAC_ID);
    assert.deepEqual([m.missing, m.source, m.name], [true, undefined, null], caller);
    assert.ok(list.every(x => x.source === undefined), `${caller}: no row is labelled`);
  };
  // An agent with no grant on the project is refused, not shown a missing pick.
  assert.equal((await s.boxCall("projects.threads", { project: "harlow-legal" }, "harness:agent:nobody")).error?.code, "not_found");
  for (const caller of ["module:x", "mcp", "harness:agent:juno", "tailnet-guest:sam@harlow.example"]) await missing(caller);
  await missing("deck", { machines: "local" });

  // The Mac away: the pick is missing again, at once, and the box's row is still there.
  await s.stopTailnet();
  await offline(s);
  const t0 = Date.now();
  const away = await asBox(s, "projects.threads", { project: "harlow-legal" });
  assert.ok(Date.now() - t0 < 2000, `answered in ${Date.now() - t0} ms`);
  assert.deepEqual(away.map(x => [x.id, x.source, x.missing || false]), [[BOX_ID, "box", false], [MAC_ID, undefined, true]]);
});
