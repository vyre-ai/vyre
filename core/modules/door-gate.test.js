// @ts-check
// The door gate on a REAL daemon (kernel on, a team: the owner and one member): the same calls made with a member's session token and with the owner's. A member's session is refused what is
// the owner's, in words that name whom to ask; the owner is served; the harness hooks and the member's own tools still run; a server with nobody but the owner gates nothing.
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { start } from "../daemon/index.js";
import { tempHome, pairDevice } from "../../test/helpers.js";
import { MEMBER_MAY, MEMBER_OUTWARD, OWNER_ONLY, PLUMBING, SELF_GATED } from "./door-lists.js";
import { refusal } from "./door-gate.js";
import { request } from "../daemon/client.js";
import { WEB_REACH } from "./agent-reach.js";

process.env.VYRE_KERNEL ??= "1"; process.env.VYRE_KERNEL_PATH_RULE ??= "1"; process.env.VYRE_SEAL_DEV ??= "1";
const MEMBER = "per_" + "bcdefghijklmnopqrstuvwxyza";
const ADMIN = "per_" + "cdefghijklmnopqrstuvwxyzab";
const proof = () => ({ op: "stand-in", fields: {}, n: Math.random() });

/** A team server: the owner, a member and an admin, each with a model session token. @param {any} t @param {boolean} team */
async function rig(t, team = true, extra = {}) {
  const root = tempHome(t);
  // a team server is a box on every platform: its tools (computers, publish) exist only for that role, and a Mac's default role is not it
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ role: "box" }));
  const d = await start({ root, log: () => {}, kernel: true, kernelPresence: { check: async () => null }, ...extra });
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
    ["files.drive.upload", { path: "x.txt", base64: "aGk=" }], ["files.deliver", {}], ["files.drive.share", {}],
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
  const lonely = held.filter(n => !MEMBER_MAY.has(n) && !OWNER_ONLY.has(n) && !PLUMBING.has(n) && !SELF_GATED.has(n));
  assert.deepEqual(lonely, [], `place these tools in core/modules/door-lists.js (MEMBER_MAY only with a test that calls it as a member; otherwise OWNER_ONLY): ${lonely.join(", ")}`);
  const twice = held.filter(n => [MEMBER_MAY.has(n), OWNER_ONLY.has(n), PLUMBING.has(n), SELF_GATED.has(n)].filter(Boolean).length > 1);
  assert.deepEqual(twice, [], `on more than one list: ${twice.join(", ")}`);
  const all = new Set(d.registry.tools.keys());
  const stale = [...MEMBER_MAY, ...OWNER_ONLY, ...PLUMBING, ...SELF_GATED].filter(n => !all.has(n));
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

test("a device or node with no proof on a team server is a member's; the moment a second person joins the gate is on, with no restart; a web page keeps its own short list", { timeout: 200_000 }, async t => {
  const { d, tokens } = await rig(t, false);
  const OWNER = d.kernel.id.owner;
  const chain = (/** @type {string} */ p) => d.kernel.chains.fromFacts({ kind: "device", device_key_id: "d-" + p.slice(4, 8), person: p, path: "direct", session: "s" });
  const alone = await d.registry.call("mail.accounts", {}, "device:abc", { person: { id: "x", kind: "person" } });
  assert.ok(!(alone.error && alone.error.message === refusal("mail.accounts")), "one person on the server: nothing is gated");
  const before = await d.registry.call("mail.accounts", {}, "mcp:agent:assistant", { thread: "t1", agent: "assistant", agentKind: "assistant", token: tokens.owner });
  assert.ok(!(before.error && before.error.message === refusal("mail.accounts")));
  await d.kernel.gateway.grants.setRole(chain(OWNER), { person: MEMBER, role: "member" }, { presence: proof() });
  const dev = await d.registry.call("mail.accounts", {}, "device:abc", { person: { id: "x", kind: "person" } });
  assert.equal(dev.error && dev.error.message, refusal("mail.accounts"), "a device with no proof is a member's once there is someone to keep out");
  const tail = await d.registry.call("mail.accounts", {}, "tailnet-guest:n1", {});
  assert.equal(tail.error && tail.error.message, refusal("mail.accounts"));
  const web = await d.registry.call("mail.accounts", {}, "web:b1", {});
  assert.equal(web.error && web.error.message, refusal("mail.accounts"), "a web page with no proof is a member's too: an owner tool is refused in words");
  const own = await d.registry.call("wink.phone.wait", {}, "web:bcdefghijklmnopq", {});
  assert.ok(!(own.error && own.error.message === refusal("wink.phone.wait")), "a web page still reaches its own short list (the pairing it is finishing)");
  const after = await d.registry.call("mail.accounts", {}, "mcp:agent:assistant", { thread: "t1", agent: "assistant", agentKind: "assistant", token: tokens.owner });
  assert.ok(!(after.error && after.error.message === refusal("mail.accounts")), "the owner is served after the second person joins");
});

test("a session's call relayed into a team Space as module:vyred is judged as the session's, by the chain the daemon built from its token; the member door's own relays are not", { timeout: 200_000 }, async t => {
  const { d } = await rig(t, false);
  const OWNER = d.kernel.id.owner;
  const firm = await d.kernel.spaces.host({ owner: OWNER, name: "Harlow Legal" });
  const ownerIn = firm.kernel.chains.fromFacts({ kind: "device", device_key_id: "d-owner", person: OWNER, path: "direct", session: "s" });
  await firm.gateway.grants.setRole(ownerIn, { person: MEMBER, role: "member" }, { presence: proof() });
  const memberIn = firm.kernel.chains.fromFacts({ kind: "device", device_key_id: "d-m", person: MEMBER, path: "direct", session: "s" });
  const chainOf = async (/** @type {any} */ c) => (await firm.kernel.surfaces.open(c, { agent: "assistant" })).token;
  const mTok = await chainOf(memberIn), oTok = await chainOf(ownerIn);
  const relay = async (/** @type {string} */ tool, /** @type {string} */ token, /** @type {string} */ origin) => d.registry.callInSpace({ name: "vyred" }, firm.space, { gateway: firm.gateway }, tool, {}, await firm.surfaces.chainFor(token), origin);
  const gated = (/** @type {any} */ r, /** @type {string} */ tool) => Boolean(r && r.error && r.error.message === refusal(tool));
  // a crossSpace tool no member may call from a session: refused for her, served (not refused by the gate) for the owner
  const tool = "work.template.define-in-space";
  assert.ok(gated(await relay(tool, mTok, "mcp:thread:t1"), tool), "a member's session, relayed as module:vyred, meets the gate");
  assert.ok(!gated(await relay(tool, oTok, "mcp:thread:t1"), tool), "the owner's session does not");
  // her own tools in a team chat still answer
  for (const own of ["work.chat.list", "memory.space.recall"]) assert.ok(!gated(await relay(own, mTok, "mcp:thread:t1"), own), `${own}: a member's own tool answers`);
  // the member door relays with no session label on the call: not this gate's
  assert.ok(!gated(await relay(tool, mTok, "space:person@team"), tool), "the member door's relay is judged by its own table");
});

test("a member's sign-in tools see only her accounts and cannot bind, sign in or remove the owner's, with an owner account present", { timeout: 200_000 }, async t => {
  const { d, as } = await rig(t);
  const OWNER = d.kernel.id.owner;
  const db = d.registry.deps.db;
  const made = await d.registry.call("sessions.accounts.add", { provider: "codex", label: "Owner's Codex", kind: "login" }, "deck", { token: (await d.kernel.surfaces.open(d.kernel.chains.fromFacts({ kind: "device", device_key_id: "d-o", person: OWNER, path: "direct", session: "s" }), {})).token });
  assert.ok(!made.error, JSON.stringify(made.error));
  db.prepare("UPDATE sessions_accounts SET signed_in_at = ?, person = ? WHERE id = ?").run(Date.now(), OWNER, made.data.id);
  const ownerAcct = made.data.id;
  const list = await as("member", "sessions.accounts.list", {}, "deck");
  assert.ok(!list.error && !JSON.stringify(list.data).includes(ownerAcct), "her list does not carry the owner's account: " + JSON.stringify(list).slice(0, 200));
  for (const [tool, input] of /** @type {[string, any][]} */ ([["sessions.accounts.bind", { id: ownerAcct, is_default: true }], ["sessions.accounts.signin", { id: ownerAcct }], ["sessions.accounts.remove", { id: ownerAcct }]])) {
    const r = await as("member", tool, input, "deck");
    assert.ok(r.error, `${tool}: naming the owner's account gets her an error, got ${JSON.stringify(r).slice(0, 160)}`);
  }
  assert.ok(db.prepare("SELECT 1 FROM sessions_accounts WHERE id = ?").get(ownerAcct), "and the owner's account is still there");
});

test("an outward tool is on a member's list only with a reason: whose yes her action waits for", { timeout: 200_000 }, async t => {
  const { d } = await rig(t, false);
  const outward = [...d.registry.tools.entries()].filter(([n, def]) => MEMBER_MAY.has(n) && def.outward).map(([n]) => n);
  const bare = outward.filter(n => !(typeof /** @type {any} */ (MEMBER_OUTWARD)[n] === "string" && /** @type {any} */ (MEMBER_OUTWARD)[n].length > 20));
  assert.deepEqual(bare, [], `these outward tools are on MEMBER_MAY (a member's call lands a held card in the owner's approvals): move them to OWNER_ONLY, or give each a reason in MEMBER_OUTWARD saying whose yes it waits for: ${bare.join(", ")}`);
  const stale = Object.keys(MEMBER_OUTWARD).filter(n => !outward.includes(n));
  assert.deepEqual(stale, [], `named in MEMBER_OUTWARD but not an outward tool on MEMBER_MAY: ${stale.join(", ")}`);
});

const SIGN_IN = ["presence.person.start", "presence.person.start-paired", "presence.person.pair-challenge", "presence.person.status", "wink.server.adopt", "wink.server.pair.answer", "wink.phone.wait", "wink.phone.pair.answer", "wink.phone.pairing"];
const DEVICE = "device:bcdefghijklmnopq";
const HEX64 = "b".repeat(64);

test("the sign-in and pairing tools on a member's list are reachable for a device with no proof, and each refuses a wrong or missing proof with its own code and changes nothing", { timeout: 200_000 }, async t => {
  const { d, as } = await rig(t);
  for (const tool of SIGN_IN) assert.ok(MEMBER_MAY.has(tool), `${tool} is on MEMBER_MAY`);
  assert.ok(OWNER_ONLY.has("presence.person.locked") && !MEMBER_MAY.has("presence.person.locked"), "presence.person.locked is the owner's");
  const locked = await as("member", "presence.person.locked", {}, DEVICE, "");
  assert.equal(locked.error && locked.error.message, refusal("presence.person.locked"));
  const OWNER = d.kernel.id.owner;
  const peer = { kind: "device", stableId: DEVICE.slice(7) };
  const db = d.registry.deps.db;
  const count = (/** @type {string} */ table) => db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
  const state = () => ({ sessions: count("presence_people"), grants: count("presence_pair_grants"), devices: count("wink_devices"), relay: count("relay_devices"), meta: count("wink_meta") });
  const before = state();
  // a well-formed input with a wrong or missing proof: the proof's own code, never bad_input, never the gate's words
  const cases = /** @type {[string, any, string, any, string[]][]} */ ([
    ["presence.person.start", {}, DEVICE, { proof: { op: "stand-in", fields: {}, n: 1 } }, ["presence_required"]],
    ["presence.person.start", {}, "deck", {}, ["presence_required"]],
    ["presence.person.start-paired", { sig: "AAAA" }, DEVICE, { peer }, ["denied"]],
    ["wink.server.adopt", { owner: { kind: "identity", id: OWNER } }, DEVICE, { peer }, ["denied_no_proof"]],
    ["wink.server.adopt", { owner: { kind: "identity", id: MEMBER }, pairing: { commit: HEX64 } }, DEVICE, { peer }, ["denied_no_proof"]],
    ["wink.server.pair.answer", { yes: true, pick: 1 }, DEVICE, {}, ["person_session_required"]],
    ["wink.phone.wait", { commit: HEX64, name: "Ben's phone" }, DEVICE, { peer }, ["denied"]],
    ["wink.phone.pair.answer", { yes: true, pick: 1 }, DEVICE, {}, ["person_session_required"]],
    ["wink.phone.pair.answer", { yes: true, pick: 1 }, "deck", {}, ["presence_required"]],
  ]);
  for (const [tool, input, caller, extra, codes] of cases) {
    const r = await d.registry.call(tool, input, caller, { thread: "t1", ...extra });
    assert.ok(r.error && codes.includes(r.error.code), `${tool} as ${caller}: the proof's own code ${codes.join("/")}, got ${JSON.stringify(r).slice(0, 220)}`);
    assert.notEqual(r.error.message, refusal(tool), `${tool}: reachable, not turned away by the gate`);
    assert.ok(!r.data, `${tool}: hands over nothing`);
  }
  // with no pairing waiting, a yes at the server answers nothing and opens nothing
  const idle = await d.registry.call("wink.server.pair.answer", { yes: true, pick: 1 }, "deck", { thread: "t1" });
  assert.deepEqual(idle, { data: { answered: false } });
  for (const tool of ["presence.person.pair-challenge", "presence.person.status", "wink.phone.pairing"]) {
    const r = await as("member", tool, {}, DEVICE, "");
    assert.ok(!(r.error && r.error.message === refusal(tool)), `${tool}: reachable`);
    assert.ok(!(r.data && (r.data.token || r.data.challenge)), `${tool}: no token or challenge to a device with no grant`);
  }
  assert.deepEqual(state(), before, "no person session, grant, device row, relay device or owner was made by any of these calls");
});

test("the proof still works where the gate lets the call through: a right presence proof signs a person in, a wrong one does not, and the owner's own surface passes the pairing tools' person check", { timeout: 200_000 }, async t => {
  // a stand-in presence layer that accepts exactly one proof
  const presence = { required: (/** @type {string} */ _t, /** @type {any} */ def) => Boolean(def && def.presence), verify: async (/** @type {any} */ a) => (a.proof && a.proof.n === 7 ? { ok: true, method: "passkey", keyId: "k" } : { ok: false, code: "presence_required", message: "that proof does not stand", methods: [] }), challenge: async () => ({ error: { code: "bad_input", message: "x" } }), summary: async () => "", covered: () => false, coverage: () => ({ covered: false }), enrolled: [], enroll() { return { id: "kh" }; } };
  const { d } = await rig(t, true, { presence });
  const db = d.registry.deps.db;
  const sessions = () => db.prepare("SELECT COUNT(*) AS n FROM presence_people").get().n;
  const peer = { kind: "tailnet", stableId: "n_browser" };
  const wrong = await d.registry.call("presence.person.start", {}, "deck", { thread: "t1", peer, proof: { op: "stand-in", fields: {}, n: 1 } });
  assert.equal(wrong.error && wrong.error.code, "presence_required");
  assert.equal(sessions(), 0, "a wrong proof makes no session");
  const right = await d.registry.call("presence.person.start", {}, "deck", { thread: "t1", peer, proof: { op: "stand-in", fields: {}, n: 7 } });
  assert.ok(right.data && right.data.kind === "cookie" && typeof right.data.token === "string", `the right proof signs in: ${JSON.stringify(right).slice(0, 200)}`);
  assert.equal(sessions(), 1);
  // the owner's own surface is not turned away by the person check the member's device meets
  const own = await d.registry.call("wink.server.pair.answer", { yes: false }, "cli", {});
  assert.deepEqual(own, { data: { answered: false } });
  const mine = await d.registry.call("wink.server.pair.answer", { yes: false }, DEVICE, {});
  assert.equal(mine.error && mine.error.code, "person_session_required");
});

test("the tools that still show other people's matter are refused to a member, in words that name a next step, until each is scoped to her", { timeout: 200_000 }, async t => {
  const { d, as } = await rig(t);
  const held = ["team.list", "team.status", "planner.agenda", "planner.get", "planner.update", "planner.delete", "planner.done", "planner.snooze", "planner.dismiss"];
  for (const tool of held) {
    assert.ok(!MEMBER_MAY.has(tool) && OWNER_ONLY.has(tool), `${tool} is the owner's until it is scoped`);
    assert.ok(d.registry.tools.has(tool), `${tool} is a real tool`);
    for (const [caller, token] of /** @type {[string, string | undefined][]} */ ([["mcp:agent:assistant", undefined], ["device:bcdefghijklmnopq", ""]])) {
      const r = await as("member", tool, {}, caller, token);
      assert.ok(r.error && r.error.code === "denied" && r.error.message === refusal(tool), `${tool}: a member is refused in the owner's words, got ${JSON.stringify(r).slice(0, 200)}`);
      assert.match(r.error.message, /Ask the owner or an admin to do it for you, or to give you access\./);
    }
  }
  // her own to-dos, reminders and notes are scoped by the planner already and stay on her list
  for (const tool of ["planner.add", "planner.list", "planner.upcoming", "planner.bin", "planner.ringing", "planner.parse"]) assert.ok(MEMBER_MAY.has(tool), `${tool} stays on a member's list`);
  assert.ok(MEMBER_MAY.has("recall.search") && !OWNER_ONLY.has("recall.search"), "recall.search is person-scoped for members (/find relay)");
});

test("every label the daemon builds for a remote caller is a member's until proof is shown: device, web, setup, space, invitee, tailnet and tailnet-guest", { timeout: 200_000 }, async t => {
  const { d } = await rig(t);
  const id = "bcdefghijklmnopq";
  const labels = [`device:${id}`, `web:${id}`, `setup:${id}`, "space:ben@spc_team", "invitee:ben@example.com", "tailnet:ben@example.com", "tailnet-guest:ben@example.com"];
  for (const label of labels) {
    const r = await d.registry.call("mail.accounts", {}, label, {});
    assert.ok(r.error && r.error.code === "denied" && r.error.message === refusal("mail.accounts"), `${label}: refused by the gate in the owner's words, got ${JSON.stringify(r).slice(0, 200)}`);
  }
  // a label the daemon proved for the owner (facts on the call) is served; the gate does not meet it
  const OWNER = d.kernel.id.owner;
  // the owner's device is a paired one (a real owner device always has its row; an unpaired id is refused since 13 Oct: devices enrol per Space)
  pairDevice(d, id, OWNER);
  const facts = { kind: "device", device_key_id: id, person: OWNER, path: "relay", session: "s" };
  for (const label of [`device:${id}`, "tailnet:owner@example.com"]) {
    const r = await d.registry.call("mail.accounts", {}, label, { kernelFacts: facts });
    assert.ok(!(r.error && r.error.message === refusal("mail.accounts")), `${label}: the owner's proven device or node is served`);
  }
  // a browser's own short list is still reachable: the gate leaves the tools only that class may call to agent-reach
  for (const tool of WEB_REACH.keys()) {
    if (!d.registry.tools.has(tool)) continue;
    const r = await d.registry.call(tool, {}, `web:${id}`, {});
    assert.ok(!(r.error && r.error.message === refusal(tool)), `web: ${tool} is on its own short list and is not the gate's`);
  }
});
