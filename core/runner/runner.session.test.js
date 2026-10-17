import "../../scripts/mac-test-guard.mjs";
import "./testing/hosted-guard.js";
import "./testing/require-sandbox.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { createEgress } from "./egress.js";
import { fakeSpace } from "./testing/fake-space.js";
import { driverFor, fscryptSupported } from "./workspace.js";
import { rig, waitFor, findOnDisk, diskPlaintextSearch, SKIP, upstream, get, tmp, rm } from "./runner-test-lib.js";
test("runner: a session runs on this computer, sees only its workspace, reaches only the proxy, and the server stays idle", { skip: SKIP || false, timeout: 90_000 }, async t => {
  const r = await rig(t);
  const h = await r.launch(r.runner, "s1");
  const events = [];
  h.child.stdout.on("data", d => { for (const l of String(d).split("\n").filter(Boolean)) events.push(JSON.parse(l)); });
  h.send("turn write the memo");
  await waitFor(() => r.sp.state.checkpoints.get("s1")?.turn === 1);
  h.send("probe");
  const probe = await waitFor(() => events.find(e => e.type === "probe"));
  assert.ok(["EPERM", "ENOENT", "EACCES"].includes(probe.outside), "cannot read a file outside the workspace: " + probe.outside);
  assert.ok(probe.homeList !== "READ", "cannot list the home folder: " + probe.homeList);
  assert.equal(probe.envHasSecret, false, "no real credential in the session's environment");
  assert.equal(probe.envToken, true);
  assert.notEqual(probe.net, "CONNECTED", "no direct network: " + probe.net);
  assert.notEqual(probe.net2, "CONNECTED", "no internet: " + probe.net2);
  assert.equal(probe.provider.status, 200, JSON.stringify(probe.provider));
  assert.equal(probe.noToken.status, 401);
  assert.equal(probe.space.status, 200);
  assert.equal(probe.other.status, 403);
  assert.equal(r.up.seen.find(s => s.url === "/v1/messages").headers["x-api-key"], "tk-REAL-PROVIDER-SECRET-0001");
  assert.ok(!JSON.stringify(events).includes("REAL-PROVIDER-SECRET"), "the secret is not in anything the session saw");
  // Transcript and files reached the space.
  const tr = r.sp.state.transcript.get("s1").map(e => JSON.parse(e.line));
  assert.ok(tr.some(e => e.text === "did write the memo"));
  assert.equal(r.sp.state.files.get("s1|files/notes.txt").length, 1);
  assert.equal(r.server.starts, 0, "the space's server started nothing");
  assert.equal(r.runner.decide().where === "here" || /battery|busy|memory/.test(r.runner.decide().reason), true);
  await h.stop();
});

test("runner: both grants are required to start", { skip: SKIP || false }, async t => {
  const r = await rig(t, { grants: { spaceAllows: true, memberAccepts: false } });
  await assert.rejects(() => r.launch(r.runner, "s1"), /both grants/);
  const r2 = await rig(t, { grants: { spaceAllows: false, memberAccepts: true } });
  await assert.rejects(() => r2.launch(r2.runner, "s1"), /both grants/);
});

test("runner: a disk search finds no credential and no plaintext transcript, running or locked", { skip: SKIP || false, timeout: 90_000 }, async t => {
  const r = await rig(t);
  const fscrypt = !diskPlaintextSearch(r.base);
  const h = await r.launch(r.runner, "s1");
  const key = r.sp.state.key;
  h.send("turn CANARY-TRANSCRIPT-7741");
  await waitFor(() => r.sp.state.checkpoints.get("s1")?.turn === 1);
  h.send("probe");
  await waitFor(() => r.up.seen.some(s => s.headers.authorization));
  const needles = ["CANARY-TRANSCRIPT-7741", "REAL-PROVIDER-SECRET", "REAL-GMAIL-SECRET", key.toString("hex"), key.toString("base64")];
  if (!fscrypt) assert.deepEqual(findOnDisk(r.base, needles), [], "nothing readable on the raw disk while the session runs");
  await h.stop();
  await r.runner.lock();
  await r.runner.whenSecured();
  assert.deepEqual(findOnDisk(r.base, needles), [], fscrypt ? "nothing readable once the workspace is locked (fscrypt key removed)" : "nothing readable once the workspace is locked");
  assert.equal(r.runner.status().open, false);
});

test("runner: after revoke the workspace is gone and no key is issued again", { skip: SKIP || false, timeout: 90_000 }, async t => {
  const r = await rig(t);
  const h = await r.launch(r.runner, "s1");
  h.send("turn secret work");
  await waitFor(() => r.sp.state.checkpoints.get("s1")?.turn === 1);
  const dir = r.runner.dir;
  assert.ok(fs.existsSync(dir));
  r.sp.state.revoked = true;
  await r.runner.revoke();
  assert.equal(fs.existsSync(dir), false, "the encrypted workspace was deleted");
  await h.done;
  await assert.rejects(() => r.launch(r.runner, "s2"), /access to this space has ended/);
});

test("runner: a machine that was offline at revoke deletes its workspace on next contact", { skip: SKIP || false, timeout: 90_000 }, async t => {
  const r = await rig(t);
  const h = await r.launch(r.runner, "s1");
  h.send("turn work");
  await waitFor(() => r.sp.state.checkpoints.get("s1")?.turn === 1);
  await r.runner.lock();
  await r.runner.whenSecured();
  const dir = r.runner.dir;
  assert.ok(fs.existsSync(dir), "locked, still on disk");
  assert.deepEqual(findOnDisk(dir, ["work"]), [], "and unreadable");
  r.sp.state.revoked = true;
  const c = await r.runner.contact();
  assert.equal(c.ok, false);
  assert.equal(fs.existsSync(dir), false);
});

test("runner: when the lease ends the workspace locks, the session stops, and the data is unreadable", { skip: SKIP || false, timeout: 90_000 }, async t => {
  const r = await rig(t, { ttlMs: 12000 });
  const h = await r.launch(r.runner, "s1");
  h.send("turn before expiry");
  await waitFor(() => r.sp.state.checkpoints.get("s1")?.turn === 1);
  r.sp.state.offline = true;
  await h.done;
  await r.runner.whenSecured();
  assert.equal(r.runner.lease.key(), null);
  assert.equal(r.runner.status().state, "locked");
  assert.deepEqual(findOnDisk(r.runner.dir, ["before expiry"]), []);
  // Back online and still a member: it opens again with the same data.
  r.sp.state.offline = false;
  const c = await r.runner.contact();
  assert.equal(c.ok, true);
  await waitFor(() => r.runner.status().mounted);
  const nf = path.join(r.runner.mnt, "work", "files", "notes.txt");
  assert.equal(fs.readFileSync(nf, "utf8"), "before expiry\n");
});

test("runner: a stopped machine's session resumes on another machine from the last turn", { skip: SKIP || false, timeout: 90_000 }, async t => {
  const r = await rig(t);
  const h = await r.launch(r.runner, "s1");
  const ev = [];
  h.child.stdout.on("data", d => { for (const l of String(d).split("\n").filter(Boolean)) ev.push(JSON.parse(l)); });
  h.send("turn one");
  await waitFor(() => r.sp.state.checkpoints.get("s1")?.turn === 1);
  h.send("turn two");
  await waitFor(() => r.sp.state.checkpoints.get("s1")?.turn === 2);
  h.send("half three");           // changes a file, then the machine dies before the turn ends
  await h.done;
  assert.equal(r.sp.state.checkpoints.get("s1").turn, 2, "the half turn was never checkpointed");
  // Another computer, its own disk, the same space.
  const base2 = tmp();
  const other = r.mk(base2);
  t.after(async () => { try { await other.stopAll(); await other.lock(); } catch {} rm(base2); });
  const h2 = await r.launch(other, "s1", { resume: true });
  const ev2 = [];
  h2.child.stdout.on("data", d => { for (const l of String(d).split("\n").filter(Boolean)) ev2.push(JSON.parse(l)); });
  const resumed = await waitFor(() => ev2.find(e => e.type === "resumed"));
  assert.equal(resumed.turn, 2);
  assert.equal(h2.resumed.turn, 2);
  assert.deepEqual(h2.resumed.state.session, { v: 1, session: "s1", taint: "external" }, "the session state comes back to the caller");
  assert.equal(resumed.notes, "one\ntwo\n");
  assert.ok(!resumed.files.includes("half.txt"), "the unfinished turn's change did not carry over");
  assert.ok(resumed.files.includes("notes.txt"));
  // The agent's own session files came along too.
  assert.match(fs.readFileSync(path.join(other.mnt, "work", "home", ".claude", "projects", "-work", "s.jsonl"), "utf8"), /"said":"two"/);
  h2.send("turn three");
  await waitFor(() => r.sp.state.checkpoints.get("s1")?.turn === 3);
  await h2.stop();
});

test("runner: move to server takes a stop here and asks the server to resume", { skip: SKIP || false, timeout: 90_000 }, async t => {
  const r = await rig(t);
  const h = await r.launch(r.runner, "s1");
  h.send("turn a");
  await waitFor(() => r.sp.state.checkpoints.get("s1")?.turn === 1);
  await r.runner.moveToServer("s1");
  assert.equal(r.server.starts, 1);
  assert.deepEqual(r.runner.status().sessions, []);
});

test("workspace: a wrong key never opens it and a drive image holds no plaintext", { skip: SKIP || false, timeout: 60_000 }, async t => {
  const d = tmp(); t.after(() => rm(d));
  const drv = driverFor(process.platform, { sizeGb: 1, base: d, prefer: process.platform === "linux" && fscryptSupported(d) ? "fscrypt" : undefined });
  const key = crypto.randomBytes(32), wrong = crypto.randomBytes(32);
  const dir = path.join(d, "w");
  await drv.create(dir, key);
  const m = await drv.mount(dir, key);
  fs.writeFileSync(path.join(m, "x.txt"), "PLAINTEXT-IN-WORKSPACE-9");
  await drv.unmount(dir);
  assert.deepEqual(findOnDisk(dir, ["PLAINTEXT-IN-WORKSPACE-9"]), []);
  await assert.rejects(() => drv.mount(dir, wrong));
  await drv.destroy(dir);
  assert.equal(fs.existsSync(dir), false);
});

test("egress: a route's own static headers go with the credential (a sign-in token as a bearer with its beta flag, added to the program's own beta list), and bad ones are refused at the start", async () => {
  const up = await upstream(); const sp = fakeSpace();
  const route = { prefix: "/provider", upstream: `http://127.0.0.1:${up.port}`, credential: { header: "authorization", prefix: "Bearer " }, headers: { "anthropic-beta": "oauth-2025-04-20" }, allow: [{ method: "POST", path: "/v1/messages" }] };
  const eg = createEgress({ routes: [route], vault: sp.vault, session: "s1", token: "tok-abc", lease: () => "lease-1" });
  const { port } = await eg.listen();
  try {
    await get(port, "/provider/v1/messages", { "x-api-key": "tok-abc", "anthropic-beta": "evil-flag" }, "POST");
    assert.equal(up.seen[0].headers["anthropic-beta"], "evil-flag,oauth-2025-04-20", "the Space's flag is added to the program's own list");
    await get(port, "/provider/v1/messages", { "x-api-key": "tok-abc" }, "POST");
    assert.equal(up.seen[1].headers["anthropic-beta"], "oauth-2025-04-20");
    assert.match(up.seen[0].headers.authorization, /^Bearer tk-REAL/);
    assert.ok(!JSON.stringify(up.seen).includes("tok-abc"));
  } finally { await eg.close(); await up.close(); }
  for (const headers of [{ Authorization: "x" }, { "x-api-key": "x" }, { host: "x" }, { "bad name": "x" }, { "a-b": "line\nbreak" }, "no"]) {
    assert.throws(() => createEgress({ routes: [{ ...route, headers }], vault: sp.vault, session: "s", token: "t" }), /own headers/, JSON.stringify(headers));
  }
});

