// @ts-check
// Shared live-daemon setup for person-relay isolation tests (agent-agnostic fake session adapters).
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

export { FAKE_SESSION_PROVIDERS };

export const CAROL = "per_" + "c".repeat(26);
export const BOB = "per_" + "b".repeat(26);

/**
 * @param {import("node:test").TestContext} t
 * @param {"claude"|"grok"|"codex"} [provider]
 */
export function relayEnv(t, provider = "claude") {
  const root = tempHome(t);
  const { transcripts } = applyFakeSessionProvider(t, root, provider);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({
    name: "test-box", role: "box", transcripts: [transcripts], sessions: { install: false, thread_socket: "on" },
  }));
  return { root, transcripts, provider };
}

/**
 * @param {import("node:test").TestContext} t
 * @param {"claude"|"grok"|"codex"} [provider]
 */
export async function relayDaemon(t, provider = "claude") {
  const { root, transcripts } = relayEnv(t, provider);
  const d = await start({ root, presence: present, log: () => {}, kernel: true, kernelPresence: { check: async () => null } });
  asOwner(d, root);
  t.after(() => d.stop());
  await ensureFakeSessionProvider(d, provider);
  return { d, root, provider };
}

/** @param {any} K @param {any} chain */
export async function tokenMeta(K, chain) {
  return { token: (await K.surfaces.open(chain, {})).token };
}

/** @param {any} d @param {any} K @param {string} OWNER */
export async function twoMembers(d, K, OWNER) {
  const ownerChain = K.chains.fromFacts({ kind: "device", device_key_id: "d-o", person: OWNER, path: "direct", session: "s1" });
  for (const [p, n] of [[CAROL, 2], [BOB, 3]]) await K.gateway.grants.setRole(ownerChain, { person: p, role: "member" }, { presence: { op: "x", fields: {}, n } });
  const carolMeta = await tokenMeta(K, K.chains.fromFacts({ kind: "device", device_key_id: "d-c", person: CAROL, path: "direct", session: "sc" }));
  const bobMeta = await tokenMeta(K, K.chains.fromFacts({ kind: "device", device_key_id: "d-b", person: BOB, path: "direct", session: "sb" }));
  return { ownerChain, carolMeta, bobMeta };
}

/** @param {import("node:test").TestContext} t @param {string} [prefix] */
export function scratchWork(t, prefix = "vyre-relay-") {
  const work = fs.realpathSync(fs.mkdtempSync(path.join(SCRATCH, prefix)));
  t.after(() => fs.rmSync(work, { recursive: true, force: true }));
  return work;
}

/**
 * Owner thread in a group chat with Carol and Bob added.
 * @param {"claude"|"grok"|"codex"} [provider] fake session adapter for threads.start
 */
export async function groupChat(d, K, OWNER, work, provider = "claude") {
  const { ownerChain, carolMeta, bobMeta } = await twoMembers(d, K, OWNER);
  await ensureFakeSessionProvider(d, provider);
  const thO = await d.registry.call("threads.start", { cwd: work, prompt: "hi", surface: "cli", ...threadStartProviderFields(provider) }, "cli");
  if (thO.error) throw new Error(JSON.stringify(thO.error));
  const chat = (await d.registry.call("threads.get", { thread: thO.data.id, limit: 1 }, "cli")).data.thread.chat;
  await K.gateway.grants.chats.change(ownerChain, chat, { add_people: [CAROL, BOB] });
  return { ownerChain, carolMeta, bobMeta, thread: thO.data.id, chat, provider };
}
