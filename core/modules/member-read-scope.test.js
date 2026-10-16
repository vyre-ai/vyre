// @ts-check
// Registry-driven: every MEMBER_MAY read tool is called as a member against seeded owner/other-member
// data; responses must not leak. New read tools fail unless wired through lib/member-scope.js (audit).
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { MEMBER_MAY } from "./door-lists.js";
import { refusal } from "./door-gate.js";
import {
  assertMemberReadScopeWiring,
  memberReadTools,
} from "../../lib/member-read-scope-audit.js";
import {
  relayDaemon,
  twoMembers,
  scratchWork,
  tokenMeta,
} from "../person-scope/member-relay-harness.js";
import {
  ensureFakeSessionProvider,
  threadStartProviderFields,
} from "../sessions/testing/fake-agent-harness.js";

process.env.VYRE_KERNEL ??= "1";
process.env.VYRE_SEAL_DEV = "1";
process.env.VYRE_KERNEL_PATH_RULE = "1";
process.env.VYRE_SESSION_SANDBOX_OFF = "1";

/**
 * Entry points fixed for the class rule: caller `cli` must not imply owner-wide reads for members.
 */
export const MEMBER_OWNER_WIDE_READ_FIXES = Object.freeze([
  "projects.reach — person_id + ownerWideRead",
  "core/memory reach — chainPerson → projects.reach",
  "core/files/access — person_id → projects.reach",
  "core/skills scopeOf — person_id → projects.reach",
  "core/recall — recallMemberReach + ownerWideRead",
  "core/spaces listCaller — ownerWideRead",
  "threads.list — memberThreadAllowSet",
]);

/** @param {any} data @param {string} needle */
function blobHas(data, needle) {
  if (!needle) return false;
  try { return JSON.stringify(data).includes(needle); } catch { return false; }
}

/**
 * @param {string} tool
 * @param {{
 *   carolThread?: string, ownerThread?: string, chat?: string, carolPlannerTitle?: string,
 * }} seed
 */
function probeFor(tool, seed) {
  const t = seed.carolThread;
  const fixed = /** @type {Record<string, any>} */ ({
    "recall.search": { q: seed.carolPlannerTitle || "probe", limit: 5 },
    "threads.list": { all: true },
    "threads.get": t ? { thread: t, limit: 5 } : {},
    "threads.items": t ? { thread: t } : {},
    "threads.asks": t ? { thread: t } : {},
    "threads.tasks": t ? { thread: t } : {},
    "threads.queue": t ? { thread: t } : {},
    "threads.commands": {},
    "threads.slash": seed.chat ? { chat: seed.chat, line: "/help" } : {},
    "planner.list": {},
    "planner.upcoming": {},
    "planner.bin": {},
    "planner.ringing": {},
    "planner.parse": { text: "tomorrow 9am" },
    "projects.list": {},
    "records.list": { type: "contact" },
    "records.me": {},
    "records.types": {},
    "records.holders": { role: "client" },
    "records.kits.library": {},
    "memory.stats": {},
    "memory.graph": { room: "unfiled" },
    "memory.facts": { limit: 3 },
    "skills.list": {},
    "skills.find": { q: "test" },
    "agents.list": {},
    "agents.history": { agent: "assistant" },
    "agents.context.list": { agent: "assistant" },
    "agents.docs.get": { agent: "assistant" },
    "agents.vault.list": { agent: "assistant" },
    "agents.used": { agent: "assistant" },
    "stream.read": {},
    "stream.catchup": {},
    "spaces.list": {},
    "spaces.members.list": {},
    "work.chat.list": {},
    "work.situation": {},
    "flows.list": {},
    "goals.list": {},
    "tasks.list": {},
    "views.list": {},
    "vault.me.list": {},
    "vault.me.get": {},
    "sessions.accounts.list": {},
    "mcp.mine.list": {},
  });
  if (fixed[tool] !== undefined) return fixed[tool];
  if (t && tool.startsWith("threads.") && !["threads.list", "threads.commands", "threads.slash"].includes(tool)) return { thread: t };
  if (tool.startsWith("records.") && !["records.me", "records.types", "records.kits.library", "records.kits.get"].includes(tool)) {
    return { type: "contact" };
  }
  if (tool.startsWith("agents.") && tool !== "agents.list" && tool !== "agents.versions" && tool !== "agents.create") return { agent: "assistant" };
  if (tool.startsWith("work.chat.") && tool !== "work.chat.list" && tool !== "work.chat.create") return seed.chat ? { chat: seed.chat } : {};
  if (tool.startsWith("flows.") && tool.includes(".")) return { id: "probe-flow-id" };
  if (tool.startsWith("files.linked.")) return { link: "probe" };
  return {};
}

test("MEMBER_MAY read tools: modules wire lib/member-scope.js or native kernel scoping", { timeout: 120_000 }, async (t) => {
  const { d } = await relayDaemon(t, "claude");
  const missing = assertMemberReadScopeWiring(d.registry, MEMBER_MAY);
  assert.deepEqual(missing, [], `MEMBER_MAY read tools missing member-scope wiring:\n${missing.join("\n")}`);
});

test("MEMBER_MAY read tools: live calls as member leak no owner or other-member seeded data", { timeout: 300_000 }, async (t) => {
  const { d } = await relayDaemon(t, "claude");
  const readTools = memberReadTools(d.registry, MEMBER_MAY);
  assert.ok(readTools.length >= 100, `expected many read tools, got ${readTools.length}`);
  assert.ok(d.registry.tools.has("threads.start"), "threads module must load (manifest declares threads.recall-sessions)");

  const K = d.kernel, OWNER = K.id.owner;
  const { ownerChain, carolMeta, bobMeta } = await twoMembers(d, K, OWNER);
  const ownerMeta = await tokenMeta(K, ownerChain);
  await ensureFakeSessionProvider(d, "claude");
  const work = scratchWork(t, "vyre-member-read-scope-");
  const stamp = Date.now();
  const MARK_O = `vyre-read-leak-owner-${stamp}`;
  const MARK_C = `vyre-read-leak-carol-${stamp}`;
  const MARK_B = `vyre-read-leak-bob-${stamp}`;

  const ownerTh = await d.registry.call("threads.start", {
    cwd: work, prompt: MARK_O, surface: "cli", ...threadStartProviderFields("claude"),
  }, "cli", ownerMeta);
  assert.ok(ownerTh.data?.id, JSON.stringify(ownerTh.error));

  const plannerAdd = (meta, title) => d.registry.call("planner.add", {
    kind: "reminder", title, body: "seed", at: "at 10am",
  }, "cli", meta);
  const ownerPlan = await plannerAdd(ownerMeta, MARK_O);
  assert.ok(ownerPlan.data, JSON.stringify(ownerPlan.error));
  assert.ok((await plannerAdd(carolMeta, MARK_C)).data);
  const bobPlan = await plannerAdd(bobMeta, MARK_B);
  assert.ok(bobPlan.data, JSON.stringify(bobPlan.error));

  const seed = {
    carolThread: undefined,
    ownerThread: ownerTh.data.id,
    chat: undefined,
    carolPlannerTitle: MARK_C,
  };

  const carolPlanner = await d.registry.call("planner.list", {}, "cli", carolMeta);
  assert.ok(!carolPlanner.error, JSON.stringify(carolPlanner.error));
  const carolTitles = JSON.stringify(carolPlanner.data);
  assert.ok(carolTitles.includes(MARK_C), "sanity: member sees her planner seed");
  assert.ok(!carolTitles.includes(MARK_O), "planner.list must not show owner seed before sweep");
  assert.ok(!carolTitles.includes(MARK_B), "planner.list must not show other member seed before sweep");

  const carolThreads = await d.registry.call("threads.list", { all: true }, "cli", carolMeta);
  assert.ok(!carolThreads.error, JSON.stringify(carolThreads.error));
  const listed = (carolThreads.data || []).map((/** @type {any} */ r) => String(r.id));
  assert.ok(!listed.includes(String(ownerTh.data.id)), "threads.list must not list owner private thread");

  const called = new Set();
  const leaks = [];
  for (const tool of readTools) {
    called.add(tool);
    const r = await d.registry.call(tool, probeFor(tool, seed), "cli", carolMeta);
    if (r.error) {
      if (r.error.message === refusal(tool)) leaks.push(`${tool}: hit owner door gate`);
      continue;
    }
    if (blobHas(r.data, MARK_O)) leaks.push(`${tool}: leaked owner marker ${MARK_O}`);
    if (blobHas(r.data, MARK_B)) leaks.push(`${tool}: leaked other-member marker ${MARK_B}`);
    if (tool === "threads.list" && Array.isArray(r.data)) {
      const ids = r.data.map((/** @type {any} */ x) => String(x.id));
      if (ids.includes(String(ownerTh.data.id))) leaks.push(`${tool}: listed owner thread id`);
    }
    if (tool === "threads.get" && r.data && blobHas(r.data, MARK_O)) leaks.push(`${tool}: leaked owner thread prompt`);
  }

  assert.equal(called.size, readTools.length, "must call every MEMBER_MAY read tool");
  assert.deepEqual(leaks, [], leaks.join("\n"));
});
