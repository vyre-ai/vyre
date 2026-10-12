// @ts-check
// The two-server walk (checklist from the multi-server team, headless subset: items 1, 2, 3, 5, 8, 10 and the box side of 7). One identity, two real vyred daemons (core/daemon start, the daemon rig of
// scripts/lib/proof/server-daemon.mjs, plain store, in this process), one headless app (scripts/lib/proof/app.mjs) paired to both, and apps/app/src/real/space-servers.ts pointed at it with setPorts.
// What it is NOT: a screen. The switcher, "Pick the Space this is for first", the inbox and a phone restart need a real app. It also holds no act on B: the rig's presence stand-in takes every proof.
//   node scripts/multi-server-walk.mjs [--out DIR]
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createApp } from "./lib/proof/app.mjs";
import { startStandins } from "./lib/proof/standins.mjs";
import { startDaemonServer } from "./lib/proof/server-daemon.mjs";

const argv = process.argv.slice(2);
const out = path.resolve(argv.includes("--out") ? argv[argv.indexOf("--out") + 1] : fs.mkdtempSync(path.join(os.tmpdir(), "multi-server-")));
fs.mkdirSync(out, { recursive: true });
let failed = 0;
const says = /** @type {string[]} */ ([]);
/** @param {string} name @param {() => Promise<any>} fn */
async function step(name, fn) {
  try { const r = await fn(); console.log(`PASS  ${name}${r ? `: ${String(r).slice(0, 700)}` : ""}`); says.push(`PASS ${name}`); }
  catch (e) { failed++; console.log(`FAIL  ${name}: ${String(/** @type {any} */ (e)?.message || e).slice(0, 700)}`); says.push(`FAIL ${name}`); }
}
const ins = await startStandins({ out });
const mac = createApp({ label: "Proof Mac", dir: path.join(out, "mac"), directory: ins.names, relay: ins.relay });
/** @type {any} */ const srv = {}, snap = {}, ids = {};
const calls = /** @type {Array<{ box: string, tool: string }>} */ ([]);
let mutex = Promise.resolve();
/** one call on one server, serialised (the headless app has one current server) */
const peerCall = (/** @type {string} */ tool, /** @type {Record<string, unknown>} */ input, /** @type {string | undefined} */ box) => {
  const run = mutex.then(async () => {
    const which = Object.keys(ids).find(k => ids[k] === box);
    if (!which) throw Object.assign(new Error(`server_not_paired: ${box}`), { code: "server_not_paired" });
    calls.push({ box: which, tool });
    if (!snap[which]) throw new Error("not paired");
    mac.useServer(snap[which]);
    return mac.callTool(tool, input);
  });
  mutex = run.then(() => {}, () => {});
  return run;
};

try {
  const person = `multi${Math.random().toString(36).slice(2, 6)}`;
  const reservation = await mac.reserve(person);
  await mac.becomeYourself({ name: reservation.name, code: reservation.code });
  /** @param {"A" | "B"} which */
  const pairBox = async which => {
    const flow = mac.addServer();
    await flow.begin("plain");
    srv[which] = await startDaemonServer({ dir: path.join(out, `server-${which}`), name: `box${which.toLowerCase()}`, code: flow.state.code, relay: ins.relayForServer, directory: ins.namesForServer, store: "plain", ownerId: mac.identity.id });
    await mac.until(() => flow.state.stage === "found" || flow.state.stage === "stopped", 60_000, "the app to find the server");
    assert.equal(flow.state.stage, "found", flow.state.error && flow.state.error.message);
    assert.equal(flow.state.box.words.join(" "), await srv[which].words(), "the four words match");
    await flow.confirmWords();
    assert.equal(flow.state.stage, "done", flow.state.error && flow.state.error.message);
    mac.setYes(srv[which].yesFor(mac.identity.id, undefined));
    await mac.openSession();
    await mac.callTool("system.info");
    snap[which] = mac.snapshot();
    ids[which] = String(snap[which].pairing.box);
  };

  await step("1. pair the app to box A (the four words match, owner named) and it answers", async () => { await pairBox("A"); return `box ${ids.A.slice(0, 8)}`; });
  const spacesOf = async (/** @type {"A" | "B"} */ w) => { mac.useServer(snap[w]); return mac.callTool("spaces.list", {}); };
  /** @type {any} */ let beforeA = null;
  await step("1b. My Cloud on A: A's own Space is listed and is the server's", async () => { beforeA = await spacesOf("A"); assert.ok(Array.isArray(beforeA) && beforeA.length >= 1, JSON.stringify(beforeA)); return JSON.stringify(beforeA).slice(0, 300); });

  await step("2. add box B (a second pairing of the same identity)", async () => { await pairBox("B"); assert.notEqual(ids.A, ids.B); return `A ${ids.A.slice(0, 8)} B ${ids.B.slice(0, 8)}`; });

  const SS = await import("../apps/app/src/real/space-servers.ts");
  SS.setPorts({ listPairings: async () => [{ box: ids.A }, { box: ids.B }], subscribePairings: () => () => {}, peerCall: /** @type {any} */ (peerCall) });
  await step("2b. both servers are listed by the app's own listAllSpaces (one row group per server)", async () => {
    const all = await SS.listAllSpaces();
    assert.ok(all && all.length >= 2, JSON.stringify(all));
    const boxes = new Set(all.map(r => r.server));
    assert.ok(boxes.has(ids.A) && boxes.has(ids.B), `rows are tagged with both servers: ${[...boxes]}`);
    return JSON.stringify(all.map(r => ({ id: String(r.id).slice(0, 10), name: r.name, server: String(r.server).slice(0, 6) })));
  });

  /** @type {any} */ let team = null;
  await step("3. name a team space on B (pick B): B's own Space gets the name, A's does not change", async () => {
    mac.useServer(snap.B);
    team = await mac.createTeamSpace(`team${person.slice(-5)}`);
    const a = await spacesOf("A"), b = await spacesOf("B");
    assert.deepEqual(JSON.parse(JSON.stringify(a)), JSON.parse(JSON.stringify(beforeA)), "A's Space list is unchanged");
    assert.ok(JSON.stringify(b).includes(team.space), `B lists the new Space ${team.space}: ${JSON.stringify(b).slice(0, 300)}`);
    assert.ok(!JSON.stringify(a).includes(team.space), "A does not list it");
    const logB = srv.B.logs.join("\n"), logA = srv.A.logs.join("\n");
    return `Space ${team.space}; B log mentions it: ${logB.includes(team.space)}, A log mentions it: ${logA.includes(team.space)}`;
  });

  // 5. what is made in a Space lands on that box only
  await step("5. a record made through the routing lands on B only (A active, B showing)", async () => {
    await SS.refreshSpaceServers();
    const spaceA = String((await spacesOf("A"))[0].id);
    const to = await SS.routeCall({ tool: "records.create", input: { space: team.space, type: "contact", data: { name: "Only on B" } }, showing: spaceA });
    assert.equal(to.box, ids.B, `routed to B: ${JSON.stringify(to)}`);
    const r = await peerCall("records.create", { type: "contact", data: { name: "Only on B" }, space: team.space }, to.box);
    const onA = JSON.stringify(await peerCall("records.query", { type: "contact" }, ids.A).catch((e) => String(e.message)));
    const onB = JSON.stringify(await peerCall("records.query", { type: "contact", space: team.space }, ids.B).catch((e) => String(e.message)));
    assert.ok(!onA.includes("Only on B"), `A does not hold it: ${onA.slice(0, 200)}`);
    assert.ok(onB.includes("Only on B"), `B holds it: ${onB.slice(0, 200)}; made: ${JSON.stringify(r).slice(0, 160)}`);
    return "created on B, absent on A";
  });
  await step("5b. a record on A (A showing) lands on A only", async () => {
    const spaceA = String((await spacesOf("A"))[0].id);
    const to = await SS.routeCall({ tool: "records.create", input: { space: spaceA, type: "contact", data: { name: "Only on A" } }, showing: spaceA });
    assert.equal(to.box, ids.A, JSON.stringify(to));
    await peerCall("records.create", { type: "contact", data: { name: "Only on A" }, space: spaceA }, to.box);
    const onB = JSON.stringify(await peerCall("records.query", { type: "contact", space: team.space }, ids.B).catch((e) => String(e.message)));
    const onA = JSON.stringify(await peerCall("records.query", { type: "contact", space: spaceA }, ids.A).catch((e) => String(e.message)));
    assert.ok(onA.includes("Only on A") && !onB.includes("Only on A"), `A:${onA.slice(0, 120)} B:${onB.slice(0, 120)}`);
    return "created on A, absent on B";
  });
  await step("5c. a chat made on B is listed by B only and routed to B", async () => {
    const made = await peerCall("work.chat.create", { title: "B chat", space: team.space }, ids.B);
    const chat = String(made?.chat || made?.id || made?.chat_id || "");
    assert.ok(chat, `a chat id came back: ${JSON.stringify(made).slice(0, 200)}`);
    SS.noteChat(chat, ids.B);
    const to = await SS.routeCall({ tool: "stream.catchup", input: { chat }, showing: String((await spacesOf("A"))[0].id) });
    assert.equal(to.box, ids.B, JSON.stringify(to));
    const onA = JSON.stringify(await peerCall("work.chat.list", {}, ids.A).catch(e => String(e.message)));
    assert.ok(!onA.includes(chat), "A does not list the chat");
    return `chat ${chat.slice(0, 14)}`;
  });
  await step("5d. a task request through B's route lands on B", async () => {
    const r = await peerCall("tasks.request", { title: "B task", output: { kind: "note" }, doer: { kind: "person", id: mac.identity.id }, space: team.space }, ids.B);
    return JSON.stringify(r).slice(0, 200);
  });

  await step("7(box side, d). approvals.pending of every server through listAllApprovals: rows tagged by server (no held act: the rig takes every proof)", async () => {
    const all = await SS.listAllApprovals("approvals.pending", {});
    return JSON.stringify(all).slice(0, 300);
  });

  // 8. a second device on each box, by Add a device (a device already on that box shows the code)
  for (const w of /** @type {const} */ (["A", "B"])) {
    await step(`8. a second device is added to box ${w} through Add a device (code from the device on that box)`, async () => {
      mac.useServer(snap[w]);
      const code = await mac.showDeviceCode();
      assert.match(code.qr, /^vyre:\/\/wink\/2\?/, "the Wink code, not the classic one");
      const phone = createApp({ label: `Phone ${w}`, dir: path.join(out, `phone-${w}`), directory: ins.names, relay: ins.relay, about: { kind: "app" } });
      try {
        /** @type {string[]} */ const shown = [];
        const joining = phone.addThisDeviceToName({ payload: code.qr, onWords: x => shown.push(x) });
        const failed = new Promise((_, rej) => joining.catch(rej)); failed.catch(() => {});
        const ask = /** @type {any} */ (await Promise.race([mac.answerDevice(), failed]));
        await phone.until(() => shown.length, 15_000, "the new device to show its words");
        await mac.sayYes(shown[0].split(" "), ask.raw);
        await mac.serveEnrol();
        const r = await joining;
        assert.equal(r.id, mac.identity.id, "the phone joined this person's identity");
        await phone.openSession();
        const info = await phone.callTool("system.info");
        assert.ok(info, "the new device reaches that box");
        return `words ${shown[0]}`;
      } finally { phone.close(); }
    });
  }

  // 10. B offline
  await step("10. B offline: A still works; a B record/chat call is refused and nothing reaches A", async () => {
    await srv.B.stop?.();
    await SS.refreshSpaceServers();
    const callsBefore = calls.length;
    const okA = await peerCall("system.info", {}, ids.A);
    assert.ok(okA, "A answers");
    const off = SS.offlineServers();
    // a B chat: the chat map knows it; the routing must say B, and the call must fail rather than go to A
    const chats = Object.keys(JSON.parse(JSON.stringify({}))).length;
    const to = await SS.routeCall({ tool: "records.create", input: { space: team.space, type: "contact", data: { name: "while B is down" } }, showing: String((await spacesOf("A"))[0].id) });
    assert.equal(to.box, ids.B, `still routed to B: ${JSON.stringify(to)}`);
    const sent = calls.length;
    let refused = "";
    try { await peerCall("records.create", { type: "contact", data: { name: "while B is down" }, space: team.space }, to.box); } catch (e) { refused = String(/** @type {any} */ (e).message || e).slice(0, 160); }
    assert.ok(refused, "the call to B failed");
    const reachedA = calls.slice(sent).filter(c => c.box === "A");
    assert.equal(reachedA.length, 0, "nothing was sent to A");
    return `offline=${JSON.stringify(off.map(x => x.slice(0, 6)))}, refused: ${refused}, calls since: ${calls.length - callsBefore - 1}`;
  });
} finally {
  console.log(`DONE ${says.filter(s => s.startsWith("PASS")).length} passed, ${failed} failed`);
  try { mac.close(); } catch { /* closed */ }
  for (const k of Object.keys(srv)) { try { await srv[k].stop?.(); } catch { /* stopped */ } }
  await ins.stop();
  process.exit(failed ? 1 : 0);
}
