// @ts-check
// Contract test for team/contracts/runner.md (v1): the real tools and events on a real daemon with the real placement book, against the fixtures a consumer builds with.
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { start } from "../../core/daemon/index.js";
import { createPlacementBook } from "../../core/runner/placement-book.js";
import { lentPlacements } from "../../core/daemon/lent-service.js";
import { tempHome, present, asOwner } from "../helpers.js";
import { runnerFixtures as F, shapeDiff, CHAT, SESSION, REASONS, STATES } from "./runner.fixtures.js";

process.env.VYRE_SEAL_DEV = "1";
process.env.VYRE_KERNEL_PATH_RULE = "1";

test("runner v1: placement, move, why-not, settings, here and pause keep the shapes the fixtures promise", { timeout: 120_000 }, async t => {
  const root = tempHome(t);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ name: "test-box", role: "box", modules: { disable: ["agents", "computers"] } }));
  const d = await start({ root, presence: present, log: () => {}, kernel: true });
  asOwner(d, root);
  t.after(() => d.stop());
  const call = (/** @type {string} */ tool, /** @type {any} */ input, /** @type {string} */ caller = "cli") => d.registry.call(tool, input, caller);
  const owner = d.kernel.id.owner, space = d.kernel.id.space;

  // The server's book, wired where the daemon wires the lent home's: the place tools reach it through the runner host.
  /** @type {any[]} */ const said = [];
  const book = createPlacementBook({ emit: (type, p) => said.push([type, p]) });
  /** @type {any} */ (d.registry.deps).lentHome = (/** @type {string} */ s) => (s === space ? { book } : null);
  /** @type {any} */ (d.registry.deps).lentSpaces = () => [space];
  assert.equal(typeof lentPlacements, "function");

  // ---- a session the server runs itself has no row: it is the server's
  const chat = await call("work.chat.create", { people: [] });
  const mine = chat.data && (chat.data.chat || chat.data.id);
  assert.ok(mine, JSON.stringify(chat));
  const plain = await call("runner.placement", { thread: mine });
  assert.equal(shapeDiff(plain.data, F.placements.theServersOwn), "", JSON.stringify(plain));
  assert.equal((await call("runner.placement", { thread: "chat_00000000-0000-4000-8000-000000000000" })).error.code, "not_found", "a chat that is not yours is not found");

  // ---- on a computer
  const row = book.lend({ session: SESSION, chat: CHAT, person: owner, device: "dev_office_mac", key: "KEY" });
  const on = await call("runner.placement", { thread: CHAT });
  assert.equal(shapeDiff(on.data, { ...F.placements.onTheComputer, computer: null }), "", JSON.stringify(on));
  assert.deepEqual([on.data.where, on.data.state, on.data.epoch], ["mac", "here", row.epoch], "the computer's name is null when the relay does not list the device");
  assert.equal((await call("runner.placement", { thread: SESSION })).data.where, "mac", "a session id answers as its chat does");
  assert.ok((await call("runner.placement", { thread: CHAT }, "mcp")).error, "a model is not told where a person's chat runs");

  // ---- the person's move to the server: the lender is asked, the chip reads "moving"
  const mv = await call("runner.move", F.calls.move.input);
  assert.equal(shapeDiff(mv.data, { ...F.calls.move.output, computer: null }), "", JSON.stringify(mv));
  assert.equal(mv.data.state, "moving");
  assert.deepEqual(book.directives("dev_office_mac"), [{ do: "release", session: SESSION, chat: CHAT, reason: "you" }], "the lender hears it at its next heartbeat");
  assert.equal((await call("runner.move", { thread: CHAT, to: "elsewhere" })).error.code, "bad_input");
  assert.equal((await call("runner.move", { to: "server" })).error.code, "bad_input", "no thread and no space+session");

  // ---- the lender hands it over; the move is a thread.moved event and a reason
  book.toServer(SESSION, "lid-closed", { auto: true });
  assert.equal(shapeDiff(said[said.length - 1][1], F.events["thread.moved"]), "", JSON.stringify(said[said.length - 1]));
  assert.equal(said[said.length - 1][0], "thread.moved");
  const off = await call("runner.placement", { thread: CHAT });
  assert.equal(shapeDiff(off.data, F.placements.movedByCondition), "", JSON.stringify(off));
  assert.deepEqual((await call("runner.why-not", F.calls.whyNot.input)).data, F.calls.whyNot.output);
  // the condition clears: offered back, not moved
  book.clear("dev_office_mac");
  const offered = await call("runner.placement", { thread: CHAT });
  assert.equal(shapeDiff(offered.data, F.placements.offeredBack), "", JSON.stringify(offered));
  assert.equal(offered.data.where, "server");
  // the person brings it back: the lender is told to start it
  const back = await call("runner.move", { thread: CHAT, to: "mac" });
  assert.equal(back.data.offer, "mac");
  assert.deepEqual(book.directives("dev_office_mac").map(x => x.do), ["start"]);
  // a session that began on the server cannot go to a computer yet
  assert.equal((await call("runner.move", { thread: mine, to: "mac" })).error.code, "unavailable");

  // ---- every reason and state the fixtures list is one the book knows
  const { REASONS: bookReasons, STATES: bookStates } = await import("../../core/runner/placement-book.js");
  assert.deepEqual([...bookReasons], REASONS);
  assert.deepEqual([...bookStates], STATES);

  // ---- this computer: limits, what runs here, pause
  const st = await call("runner.settings", F.calls.settings.input);
  assert.equal(shapeDiff(st.data, F.calls.settings.output), "", JSON.stringify(st));
  assert.deepEqual(st.data, F.defaults);
  const set = await call("runner.settings.set", F.calls.settingsSet.input);
  assert.equal(shapeDiff(set.data, F.calls.settingsSet.output), "", JSON.stringify(set));
  assert.deepEqual(set.data, F.calls.settingsSet.output, "the limits are the module's settings, read back through settings.get");
  assert.equal((await call("settings.get", { key: "runner.cpu_percent" })).data.value, 40);
  for (const bad of [{ cpuPercent: 5 }, { cpuPercent: 101 }, { cpuPercent: 12.5 }, { memoryMb: 100 }, { memoryMb: 70000 }, { enabled: "yes" }]) {
    assert.equal((await call("runner.settings.set", bad)).error.code, "bad_input", JSON.stringify(bad));
  }
  assert.ok((await call("runner.settings.set", { enabled: false }, "mcp")).error, "a model does not change a person's limits here; the assistant uses settings.request");
  const here = await call("runner.here", F.calls.here.input);
  assert.deepEqual(here.data, { sessions: [] }, "nothing runs on a server");
  assert.equal(shapeDiff({ sessions: [F.calls.here.output.sessions[0]] }, F.calls.here.output), "");
  assert.deepEqual((await call("runner.pause-all", {})).data, { paused: 0 });
  assert.deepEqual((await call("runner.resume-all", {})).data, { resumed: 0 });
});
