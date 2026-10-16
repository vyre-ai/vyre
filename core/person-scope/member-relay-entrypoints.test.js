// @ts-check
// Table-driven: every person-relay entry point derived from routes/registry keeps member isolation on a live daemon.
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { start } from "../daemon/index.js";
import { asOwner, tempHome, present } from "../../test/helpers.js";
import { SCRATCH } from "../../test/scratch.mjs";
import { FAKE } from "../sessions/testing/boot.js";
import { listAllPersonRelayEntryPoints, listPersonRelayEntryPoints } from "../../lib/person-relay-entrypoints.js";

process.env.VYRE_SEAL_DEV = "1";
process.env.VYRE_KERNEL_PATH_RULE = "1";
process.env.VYRE_SESSION_SANDBOX_OFF = "1";

const CAROL = "per_" + "c".repeat(26);
const BOB = "per_" + "b".repeat(26);
const titles = (/** @type {any} */ r) => {
  const d = r && r.data;
  const rows = Array.isArray(d) ? d : Array.isArray(d?.items) ? d.items : [];
  return rows.map((/** @type {any} */ x) => String(x.title || ""));
};

async function tokenMeta(/** @type {any} */ K, /** @type {any} */ chain) {
  return { token: (await K.surfaces.open(chain, {})).token };
}

test("person-relay entry points: derived list matches live registry tools", { timeout: 60_000 }, async (t) => {
  const root = tempHome(t);
  const d = await start({ root, presence: present, log: () => {}, kernel: true, kernelPresence: { check: async () => null } });
  asOwner(d, root);
  t.after(() => d.stop());
  const eps = listPersonRelayEntryPoints(d.registry);
  assert.ok(eps.length >= 4, JSON.stringify(eps.map((e) => e.id)));
  for (const e of eps) assert.ok(d.registry.tools.has(e.tool), `${e.id} tool ${e.tool}`);
  const all = listAllPersonRelayEntryPoints(d.registry);
  assert.ok(all.some((e) => e.id === "agents.ask"), JSON.stringify(all.map((e) => e.id)));
});

test("each derived threads.slash entry point: group-chat /later stays on the caller's planner", { timeout: 150_000 }, async (t) => {
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

  const entryPoints = listPersonRelayEntryPoints(d.registry);

  const K = d.kernel, OWNER = K.id.owner;
  const ownerChain = K.chains.fromFacts({ kind: "device", device_key_id: "d-o", person: OWNER, path: "direct", session: "s1" });
  for (const [p, n] of [[CAROL, 2], [BOB, 3]]) await K.gateway.grants.setRole(ownerChain, { person: p, role: "member" }, { presence: { op: "x", fields: {}, n } });
  const carolMeta = await tokenMeta(K, K.chains.fromFacts({ kind: "device", device_key_id: "d-c", person: CAROL, path: "direct", session: "sc" }));
  const bobMeta = await tokenMeta(K, K.chains.fromFacts({ kind: "device", device_key_id: "d-b", person: BOB, path: "direct", session: "sb" }));

  const work = fs.realpathSync(fs.mkdtempSync(path.join(SCRATCH, "vyre-relay-eps-")));
  t.after(() => fs.rmSync(work, { recursive: true, force: true }));
  const thO = await d.registry.call("threads.start", { cwd: work, prompt: "hi", surface: "cli" }, "cli");
  assert.ok(thO.data, JSON.stringify(thO.error));
  const chat = (await d.registry.call("threads.get", { thread: thO.data.id, limit: 1 }, "cli")).data.thread.chat;
  await K.gateway.grants.chats.change(ownerChain, chat, { add_people: [CAROL, BOB] });

  const tagC = `carol-grp-${Date.now()}`;
  const tagB = `bob-grp-${Date.now()}`;
  const slashEps = entryPoints.filter((e) => e.tool === "threads.slash");
  assert.ok(slashEps.length >= 1, JSON.stringify(entryPoints));

  for (const ep of slashEps) {
    const slashC = await d.registry.call("threads.slash", { chat, line: `/later "at 10am" ${tagC}` }, "cli", carolMeta);
    const slashB = await d.registry.call("threads.slash", { chat, line: `/later "at 11am" ${tagB}` }, "cli", bobMeta);
    assert.ok(!slashC.error, `${ep.id} carol: ${JSON.stringify(slashC.error)}`);
    assert.ok(!slashB.error, `${ep.id} bob: ${JSON.stringify(slashB.error)}`);
  }

  const carolTitles = titles(await d.registry.call("planner.list", {}, "cli", carolMeta));
  const bobTitles = titles(await d.registry.call("planner.list", {}, "cli", bobMeta));
  assert.ok(carolTitles.some((x) => x.includes(tagC)));
  assert.ok(bobTitles.some((x) => x.includes(tagB)));
  assert.ok(!carolTitles.some((x) => x.includes(tagB)));
  assert.ok(!bobTitles.some((x) => x.includes(tagC)));

  const ownerItem = await d.registry.call("planner.add", { kind: "reminder", title: `owner-only-${Date.now()}`, body: "x", at: "at 9am" }, "cli", await tokenMeta(K, ownerChain));
  assert.ok(ownerItem.data?.title, JSON.stringify(ownerItem.error));
  const afterCarol = titles(await d.registry.call("planner.list", {}, "cli", carolMeta));
  assert.ok(!afterCarol.some((x) => x.includes(String(ownerItem.data.title))), "member planner list must not show owner's item");
});
