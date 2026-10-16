// @ts-check
// Live daemon: threads.slash /later runs planner.add as each caller; lists stay isolated per person.
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { start } from "../daemon/index.js";
import { asOwner, tempHome, present } from "../../test/helpers.js";
import { SCRATCH } from "../../test/scratch.mjs";
import { FAKE } from "../sessions/testing/boot.js";

process.env.VYRE_SEAL_DEV = "1";
process.env.VYRE_KERNEL_PATH_RULE = "1";
process.env.VYRE_SESSION_SANDBOX_OFF = "1";

const CAROL = "per_carolslashmemberiso01";
const BOB = "per_" + "b".repeat(26);
const titles = (/** @type {any} */ r) => {
  const d = r && r.data;
  const rows = Array.isArray(d) ? d : Array.isArray(d?.items) ? d.items : [];
  return rows.map((/** @type {any} */ x) => String(x.title || ""));
};

test("threads.slash /later on a real daemon: each member sees only their own planner items", { timeout: 120_000 }, async (t) => {
  const root = tempHome(t);
  const saved = { VYRE_CLAUDE_BIN: process.env.VYRE_CLAUDE_BIN, VYRE_SESSIONS_DRIVER: process.env.VYRE_SESSIONS_DRIVER, FAKE_CLAUDE_TRANSCRIPTS: process.env.FAKE_CLAUDE_TRANSCRIPTS };
  const transcripts = path.join(root, "transcripts");
  fs.mkdirSync(transcripts, { recursive: true });
  Object.assign(process.env, { VYRE_CLAUDE_BIN: FAKE, VYRE_SESSIONS_DRIVER: "cli", FAKE_CLAUDE_TRANSCRIPTS: transcripts });
  t.after(() => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ name: "test-box", role: "box", transcripts: [transcripts], sessions: { install: false, thread_socket: "on" } }));

  const d = await start({ root, presence: present, log: () => {}, kernel: true, kernelPresence: { check: async () => null } });
  asOwner(d, root);
  t.after(() => d.stop());

  const K = d.kernel, OWNER = K.id.owner;
  const ownerChain = K.chains.fromFacts({ kind: "device", device_key_id: "d-o", person: OWNER, path: "direct", session: "s1" });
  await K.gateway.grants.setRole(ownerChain, { person: CAROL, role: "member" }, { presence: { op: "x", fields: {}, n: Math.random() } });
  await K.gateway.grants.setRole(ownerChain, { person: BOB, role: "member" }, { presence: { op: "x", fields: {}, n: Math.random() } });
  const carolChain = K.chains.fromFacts({ kind: "device", device_key_id: "d-c", person: CAROL, path: "direct", session: "sc" });
  const bobChain = K.chains.fromFacts({ kind: "device", device_key_id: "d-b", person: BOB, path: "direct", session: "sb" });
  const carolMeta = { token: (await K.surfaces.open(carolChain, {})).token };
  const bobMeta = { token: (await K.surfaces.open(bobChain, {})).token };

  const work = fs.realpathSync(fs.mkdtempSync(path.join(SCRATCH, "vyre-slash-iso-")));
  t.after(() => fs.rmSync(work, { recursive: true, force: true }));

  const thO = await d.registry.call("threads.start", { cwd: work, prompt: "owner", surface: "cli" }, "cli");
  assert.ok(thO.data, JSON.stringify(thO.error));
  const chat = (await d.registry.call("threads.get", { thread: thO.data.id, limit: 1 }, "cli")).data.thread.chat;
  await K.gateway.grants.chats.change(ownerChain, chat, { add_people: [CAROL, BOB] });

  const tagC = `carol-${Date.now()}`;
  const tagB = `bob-${Date.now()}`;
  const slashC = await d.registry.call("threads.slash", { thread: thO.data.id, line: `/later "at 10am" ${tagC}` }, "cli", carolMeta);
  const slashB = await d.registry.call("threads.slash", { thread: thO.data.id, line: `/later "at 11am" ${tagB}` }, "cli", bobMeta);
  assert.ok(!slashC.error, JSON.stringify(slashC.error));
  assert.ok(!slashB.error, JSON.stringify(slashB.error));

  const listC = await d.registry.call("planner.list", { state: "open" }, "cli", carolMeta);
  const listB = await d.registry.call("planner.list", { state: "open" }, "cli", bobMeta);
  assert.ok(!listC.error && !listB.error, JSON.stringify({ listC, listB }));

  const carolTitles = titles(listC);
  const bobTitles = titles(listB);
  assert.ok(carolTitles.some((t) => t.includes(tagC)), `carol list: ${carolTitles.join(", ")}`);
  assert.ok(bobTitles.some((t) => t.includes(tagB)), `bob list: ${bobTitles.join(", ")}`);
  assert.ok(!carolTitles.some((t) => t.includes(tagB)), "a member must not see another member's /later");
  assert.ok(!bobTitles.some((t) => t.includes(tagC)), "a member must not see another member's /later");
});
