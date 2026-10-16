// @ts-check
// Live daemon: threads.slash /later runs planner.add as each caller; lists stay isolated per person.
// Parametrized over fake session adapters (claude, grok, codex).
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { start } from "../daemon/index.js";
import { asOwner, tempHome, present } from "../../test/helpers.js";
import { SCRATCH } from "../../test/scratch.mjs";
import {
  applyFakeSessionProvider,
  ensureFakeSessionProvider,
  FAKE_SESSION_PROVIDERS,
  threadStartProviderFields,
} from "../sessions/testing/fake-agent-harness.js";

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

for (const provider of FAKE_SESSION_PROVIDERS) {
  test(`threads.slash /later on a real daemon [${provider}]: each member sees only their own planner items`, { timeout: 120_000 }, async (t) => {
    const root = tempHome(t);
    const { transcripts } = applyFakeSessionProvider(t, root, provider);
    fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ name: "test-box", role: "box", transcripts: [transcripts], sessions: { install: false, thread_socket: "on" } }));

    const d = await start({ root, presence: present, log: () => {}, kernel: true, kernelPresence: { check: async () => null } });
    asOwner(d, root);
    t.after(() => d.stop());
    await ensureFakeSessionProvider(d, provider);

    const K = d.kernel, OWNER = K.id.owner;
    const ownerChain = K.chains.fromFacts({ kind: "device", device_key_id: "d-o", person: OWNER, path: "direct", session: "s1" });
    await K.gateway.grants.setRole(ownerChain, { person: CAROL, role: "member" }, { presence: { op: "x", fields: {}, n: Math.random() } });
    await K.gateway.grants.setRole(ownerChain, { person: BOB, role: "member" }, { presence: { op: "x", fields: {}, n: Math.random() } });
    const carolChain = K.chains.fromFacts({ kind: "device", device_key_id: "d-c", person: CAROL, path: "direct", session: "sc" });
    const bobChain = K.chains.fromFacts({ kind: "device", device_key_id: "d-b", person: BOB, path: "direct", session: "sb" });
    const carolMeta = { token: (await K.surfaces.open(carolChain, {})).token };
    const bobMeta = { token: (await K.surfaces.open(bobChain, {})).token };

    const work = fs.realpathSync(fs.mkdtempSync(path.join(SCRATCH, `vyre-slash-iso-${provider}-`)));
    t.after(() => fs.rmSync(work, { recursive: true, force: true }));

    const thO = await d.registry.call("threads.start", { cwd: work, prompt: "owner", surface: "cli", ...threadStartProviderFields(provider) }, "cli");
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
    assert.ok(carolTitles.some((x) => x.includes(tagC)), `carol list: ${carolTitles.join(", ")}`);
    assert.ok(bobTitles.some((x) => x.includes(tagB)), `bob list: ${bobTitles.join(", ")}`);
    assert.ok(!carolTitles.some((x) => x.includes(tagB)), "a member must not see another member's /later");
    assert.ok(!bobTitles.some((x) => x.includes(tagC)), "a member must not see another member's /later");
  });
}
