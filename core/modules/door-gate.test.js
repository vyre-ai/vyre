// @ts-check
// The door gate on a REAL daemon (kernel on, a team: the owner and one member): the same calls made with a member's session token and with the owner's. A member's session is refused what is
// the owner's, in words that name whom to ask; the owner is served; the harness hooks and the member's own tools still run; a server with nobody but the owner gates nothing.
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { start } from "../daemon/index.js";
import { tempHome } from "../../test/helpers.js";
import { MEMBER_MAY, OWNER_ONLY, PLUMBING } from "./door-lists.js";
import { refusal } from "./door-gate.js";
import { request } from "../daemon/client.js";

process.env.VYRE_KERNEL ??= "1"; process.env.VYRE_KERNEL_PATH_RULE ??= "1"; process.env.VYRE_SEAL_DEV ??= "1";
const MEMBER = "per_" + "bcdefghijklmnopqrstuvwxyza";
const ADMIN = "per_" + "cdefghijklmnopqrstuvwxyzab";
const proof = () => ({ op: "stand-in", fields: {}, n: Math.random() });

/** A team server: the owner, a member and an admin, each with a model session token. @param {any} t @param {boolean} team */
async function rig(t, team = true) {
  const root = tempHome(t);
  const d = await start({ root, log: () => {}, kernel: true, kernelPresence: { check: async () => null } });
  t.after(() => d.stop());
  const OWNER = d.kernel.id.owner;
  const chain = (/** @type {string} */ p) => d.kernel.chains.fromFacts({ kind: "device", device_key_id: "d-" + p.slice(4, 8), person: p, path: "direct", session: "s" });
  if (team) {
    await d.kernel.gateway.grants.setRole(chain(OWNER), { person: MEMBER, role: "member" }, { presence: proof() });
    await d.kernel.gateway.grants.setRole(chain(OWNER), { person: ADMIN, role: "admin" }, { presence: proof() });
  }
  const tok = async (/** @type {string} */ p) => (await d.kernel.surfaces.open(chain(p), { agent: "assistant" })).token;
  const tokens = { owner: await tok(OWNER), ...(team ? { member: await tok(MEMBER), admin: await tok(ADMIN) } : {}) };
  /** @type {(who: "owner"|"member"|"admin", tool: string, input?: any, caller?: string, token?: string) => Promise<any>} */
  const as = (who, tool, input = {}, caller = "mcp:agent:assistant", token) => d.registry.call(tool, input, caller, { thread: "t1", agent: "assistant", agentKind: "assistant", token: token ?? tokens[who] });
  return { d, as, tokens, root };
}

test("a member's session is refused the owner's mail, services, computers, artifacts, settings and spend; the owner is served", { timeout: 200_000 }, async t => {
  const { as } = await rig(t);
  const calls = /** @type {[string, any][]} */ ([
    ["mail.accounts", {}], ["mail.search", { q: "a" }], ["mail.read", { id: "1" }], ["mail.send", { to: "a@b.co", subject: "x", body: "y" }],
    ["google.accounts", {}], ["github.accounts", {}], ["mcp.servers", {}], ["mcp.tools", {}], ["mcp.call", { server: "x", tool: "y" }],
    ["computers.list", {}], ["computers.pause", { agent: "assistant" }], ["computers.restart", { agent: "assistant" }], ["computers.takeover", { agent: "assistant" }],
    ["artifacts.list", {}], ["artifacts.update", { id: "x" }], ["artifacts.delete", { id: "x" }], ["artifacts.public.set", { on: true }],
    ["flows.run", { id: "x" }], ["flows.attention", {}], ["files.dirs", {}], ["files.search", { q: "a" }], ["sidebar.get", {}], ["projects.context", { project: "x" }], ["team.list", { all: true }], ["skills.versions", {}], ["assistant.glance", {}], ["threads.chat-switch", { chat: "x" }],
    ["settings.get", {}], ["settings.set", { key: "x", value: 1 }], ["spend.summary", {}], ["spend.raise", {}], ["publish.create", {}], ["chrome.open", { url: "https://example.com" }],
  ]);
  for (const [tool, input] of calls) {
    const m = await as("member", tool, input);
    assert.ok(m.error && m.error.code === "denied" && m.error.message === refusal(tool), `${tool}: a member must be refused with the owner's words, got ${JSON.stringify(m).slice(0, 200)}`);
    assert.match(m.error.message, /Ask the owner or an admin/);
    const o = await as("owner", tool, input);
    assert.ok(!(o.error && o.error.message === refusal(tool)), `${tool}: the owner must not meet the gate`);
    const a = await as("admin", tool, input);
    assert.ok(!(a.error && a.error.message === refusal(tool)), `${tool}: an admin must not meet the gate`);
  }
});

test("a member's own tools and the harness hooks still run; a chain that cannot be read is a member's; a session with no proof on a team server is a member's", { timeout: 200_000 }, async t => {
  const { as, d } = await rig(t);
  for (const tool of ["sessions.accounts.list", "threads.list", "stream.catchup", "records.list"]) {
    const m = await as("member", tool, {});
    assert.ok(!(m.error && m.error.message === refusal(tool)), `${tool}: a member's own tool must not meet the gate`);
  }
  for (const tool of PLUMBING) {
    const m = await as("member", tool, {});
    assert.ok(!(m.error && m.error.message === refusal(tool)), `${tool}: a harness hook must never be gated`);
  }
  const bad = await as("member", "mail.accounts", {}, "mcp:agent:assistant", "not-a-session-token");
  assert.equal(bad.error && bad.error.message, refusal("mail.accounts"));
  const bare = await d.registry.call("mail.accounts", {}, "mcp:thread:t1", { thread: "t1" });
  assert.equal(bare.error && bare.error.message, refusal("mail.accounts"));
  const own = await d.registry.call("mail.accounts", {}, "module:vyred", {});
  assert.ok(!(own.error && own.error.message === refusal("mail.accounts")), "a module's own call is never gated");
});

test("a server with nobody but the owner gates nothing", { timeout: 200_000 }, async t => {
  const { as } = await rig(t, false);
  for (const tool of ["mail.accounts", "mcp.servers", "computers.list", "settings.get"]) {
    const o = await as("owner", tool, {});
    assert.ok(!(o.error && o.error.message === refusal(tool)), `${tool}: a one-person server is not gated`);
  }
  const bare = await as("owner", "mail.accounts", {}, "mcp:thread:t1", "");
  assert.ok(!(bare.error && bare.error.message === refusal("mail.accounts")));
});

test("every tool the registry holds is on exactly one list, and no list names a tool that is not there", { timeout: 200_000 }, async t => {
  const { d } = await rig(t, false);
  const held = [...d.registry.tools.entries()].filter(([, def]) => !def.internal && !def.hook).map(([n]) => n);
  const lonely = held.filter(n => !MEMBER_MAY.has(n) && !OWNER_ONLY.has(n) && !PLUMBING.has(n));
  assert.deepEqual(lonely, [], `place these tools in core/modules/door-lists.js (MEMBER_MAY only with a test that calls it as a member; otherwise OWNER_ONLY): ${lonely.join(", ")}`);
  const twice = held.filter(n => [MEMBER_MAY.has(n), OWNER_ONLY.has(n), PLUMBING.has(n)].filter(Boolean).length > 1);
  assert.deepEqual(twice, [], `on more than one list: ${twice.join(", ")}`);
  const all = new Set(d.registry.tools.keys());
  const stale = [...MEMBER_MAY, ...OWNER_ONLY, ...PLUMBING].filter(n => !all.has(n));
  assert.deepEqual(stale, [], `named on a list but not registered: ${stale.join(", ")}`);
});

test("a member's tool list leaves off the owner's tools; the owner's list is whole", { timeout: 200_000 }, async t => {
  const { d, tokens, root } = await rig(t);
  const names = async (/** @type {string} */ token) => {
    const r = await request("GET", "/v1/tools", undefined, { root, caller: "cli", headers: { "x-vyre-kernel-session": token } });
    return new Set(((r && r.data) || []).map((/** @type {any} */ x) => x.name));
  };
  const mem = await names(tokens.member), own = await names(tokens.owner);
  for (const n of ["mail.accounts", "computers.pause", "settings.set", "mcp.servers"]) { assert.ok(own.has(n) || !d.registry.tools.has(n), `${n} on the owner's list`); assert.ok(!mem.has(n), `${n} must not be on a member's list`); }
  assert.ok(mem.has("threads.list") && mem.has("stream.send"), "a member keeps her own tools on the list");
});
