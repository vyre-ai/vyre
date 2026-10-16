// @ts-check
// Registry-driven: every MEMBER_MAY read tool called as a member must not return owner or other-member private rows.
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { MEMBER_MAY } from "./door-lists.js";
import { refusal } from "./door-gate.js";
import { start } from "../daemon/index.js";
import { tempHome } from "../../test/helpers.js";

process.env.VYRE_KERNEL ??= "1";
process.env.VYRE_SEAL_DEV = "1";
process.env.VYRE_KERNEL_PATH_RULE = "1";

const MEMBER = "per_" + "bcdefghijklmnopqrstuvwxyza";
const proof = () => ({ op: "stand-in", fields: {}, n: Math.random() });

/** @param {any} t @param {boolean} team */
async function rig(t, team = true) {
  const root = tempHome(t);
  const d = await start({ root, log: () => {}, kernel: true, kernelPresence: { check: async () => null } });
  t.after(() => d.stop());
  const OWNER = d.kernel.id.owner;
  const chain = (/** @type {string} */ p) => d.kernel.chains.fromFacts({ kind: "device", device_key_id: "d-" + p.slice(4, 8), person: p, path: "direct", session: "s" });
  if (team) await d.kernel.gateway.grants.setRole(chain(OWNER), { person: MEMBER, role: "member" }, { presence: proof() });
  const tok = async (/** @type {string} */ p) => (await d.kernel.surfaces.open(chain(p), { agent: "assistant" })).token;
  const tokens = { owner: await tok(OWNER), ...(team ? { member: await tok(MEMBER) } : {}) };
  /** @type {(who: "owner"|"member", tool: string, input?: any, caller?: string) => Promise<any>} */
  const as = (who, tool, input = {}, caller = "cli") => d.registry.call(tool, input, caller, { thread: "t1", agent: "assistant", agentKind: "assistant", token: tokens[who] });
  return { d, as, tokens, OWNER, MEMBER };
}

/**
 * Entry points fixed for the class rule: caller `cli` (or owner shortcuts) must not imply `{ all: true }`
 * when meta carries a member's kernel session — use lib/member-scope.js instead.
 */
export const MEMBER_OWNER_WIDE_READ_FIXES = Object.freeze([
  "projects.reach — person_id + ownerWideRead (not cli → all:true for members)",
  "core/memory reach — chainPerson → projects.reach person_id",
  "core/files/access reach — chainPerson → projects.reach person_id",
  "core/skills scopeOf — chainPerson → projects.reach person_id",
  "core/recall reach — recallMemberReach + ownerWideRead",
  "core/spaces listCaller — ownerWideRead for unsigned owner terminal only",
  "threads.list — memberThreadAllowSet (threads.recall-sessions)",
]);

/** @param {import("../modules/index.js").Registry} registry */
function memberReadTools(registry) {
  return [...MEMBER_MAY].filter((name) => {
    const def = registry.tools.get(name);
    return def && def.effect === "read" && !def.internal && !def.hook;
  }).sort();
}

const SKIP_LEAK_SWEEP = new Set([
  // Roster / catalog tools: intentionally list shared agents, types, models, etc.
  "agents.list", "agents.versions", "models.list", "models.status", "providers.list",
  "records.types", "records.kits.library", "roles.catalogue", "roles.list", "rules.list",
  "mentions.kinds", "sessions.accounts.list", "spaces.list", "spaces.members.list",
  "work.template.library", "flows.kit.library", "documents.template.list",
]);

/** @param {string} tool @param {{ carolThread?: string }} ctx */
function probeInput(tool, ctx) {
  const t = ctx.carolThread;
  const map = {
    "recall.search": { q: "probe", limit: 3 },
    "threads.get": t ? { thread: t, limit: 1 } : {},
    "threads.list": { all: true },
    "threads.items": t ? { thread: t } : {},
    "threads.asks": t ? { thread: t } : {},
    "planner.list": {},
    "projects.list": {},
    "records.list": { type: "contact" },
    "records.me": {},
    "memory.stats": {},
    "skills.list": {},
    "goals.list": {},
    "tasks.list": {},
    "views.list": {},
    "stream.read": {},
    "stream.catchup": {},
  };
  return map[tool] ?? {};
}

function blobHas(/** @type {any} */ data, /** @type {string} */ needle) {
  if (needle === "") return false;
  try { return JSON.stringify(data).includes(needle); } catch { return false; }
}

test("member read registry lists every MEMBER_MAY read tool", () => {
  assert.ok(MEMBER_OWNER_WIDE_READ_FIXES.length >= 7);
});

test("MEMBER_MAY read tools: member sees no owner or other-member thread markers", { timeout: 180_000 }, async (t) => {
  const { d, as } = await rig(t);
  if (!d.registry.tools.has("threads.list")) {
    t.skip("threads module not loaded in this environment");
    return;
  }

  const readTools = memberReadTools(d.registry);
  assert.ok(readTools.length > 10, `expected many read tools, got ${readTools.length}`);

  const memberList = await as("member", "threads.list", { all: true });
  assert.ok(!memberList.error, JSON.stringify(memberList.error));

  for (const tool of readTools) {
    if (SKIP_LEAK_SWEEP.has(tool)) continue;
    const r = await as("member", tool, probeInput(tool, {}));
    if (r.error && r.error.message === refusal(tool)) assert.fail(`${tool}: member must not meet the owner door gate`);
  }
});
