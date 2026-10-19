// @ts-check
// A person who is not the owner never runs on the owner's login or the machine's own credential (review F3, 11 Oct): the rule of askerOver and memberAccount, against the Switchboard's own shape, with the
// accounts the sessions module would answer. The owner's turns are unchanged; an alias of the owner counts as the owner only through the Switchboard's canonical form, and anything it cannot read as the owner is refused.
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { agentLaunchGuard, checkLaunch, trustedLaunch, askerOver, memberAccount, movesAccount } from "./asker-account.js";

const OWNER = "per_owner", ANA = "per_ana", BEN = "per_ben";
/** A Switchboard-shaped stand-in: accounts by id with their person (null: the home's own, the owner's), the thread record, and whether the machine holds a login of its own. */
function sb({ accounts = [], rec = { provider: "claude", account: null }, login = false, canon = (/** @type {string} */ p) => p } = {}) {
  const deleted = [];
  return {
    deleted,
    canon,
    deps: { owner: () => OWNER, ...(login ? { auth: async () => ({ auth: "subscription", env: { CLAUDE_CODE_OAUTH_TOKEN: "x" } }) } : { auth: async () => ({ auth: "ambient" }) }) },
    db: { prepare: () => ({ run: (/** @type {string} */ id) => deleted.push(id) }) },
    record: () => rec,
    // sessions.accounts.resolve: an account serves its person, or (person null) the owner; a named one that does not serve is "no account"
    accountFor: async (/** @type {any} */ q) => {
      const who = q.person ?? null;
      const serves = (/** @type {any} */ a) => (a.person ? a.person === who : who === null || who === OWNER);
      if (q.account) { const a = accounts.find(x => x.id === q.account); if (!a || !serves(a)) throw new Error(`no account ${q.account}`); return a; }
      return accounts.find(a => a.provider === q.provider && serves(a)) || null;
    },
  };
}
const refused = (/** @type {Promise<any>} */ p) => assert.rejects(p, (/** @type {any} */ e) => e.code === "account_required" && /sign-in of your own/.test(e.message) && /Add your own sign-in/.test(e.message));

test("a member with no sign-in of their own is refused where the owner's login would run their turn: a thread on the machine's login, a thread on the owner's account, another member's account", async () => {
  await refused(askerOver(sb({ login: true }), "t", { asker: ANA }));
  await refused(askerOver(sb({ accounts: [{ id: "own", provider: "claude", person: null }], rec: { provider: "claude", account: "own" } }), "t", { asker: ANA }));
  await refused(askerOver(sb({ accounts: [{ id: "bens", provider: "claude", person: BEN }], rec: { provider: "claude", account: "bens" } }), "t", { asker: ANA }));
});

test("the owner is unchanged, a member with an account of their own moves to it, and a Mac-server thread (no credential visible) is refused all the same", async () => {
  assert.equal(await askerOver(sb({ login: true }), "t", { asker: OWNER }), null);
  assert.deepEqual(await askerOver(sb({ accounts: [{ id: "anas", provider: "claude", person: ANA }], login: true }), "t", { asker: ANA }), { provider: "claude", account: "anas", person: ANA });
  await refused(askerOver(sb({ login: false }), "t", { asker: ANA }));   // a Mac mini server: no credential visible, the owner's Claude Code login is ambient in that HOME
});

test("a launch for a member names their own account, refuses one with none, and is not given the owner's or another member's account by input", async () => {
  const world = { accounts: [{ id: "own", provider: "claude", person: null }, { id: "anas", provider: "claude", person: ANA }, { id: "bens", provider: "claude", person: BEN }], login: true };
  const rec = { provider: "claude", account: null, project: null, agent: null };
  const kt = (/** @type {string} */ asker) => ({ kernelTurn: { chat: "c", asker } });
  assert.equal((await memberAccount(sb(world), rec, kt(ANA), "t")).account, "anas", "their own account is named for the launch");
  assert.equal((await memberAccount(sb(world), rec, kt(OWNER), "t")).account, undefined, "the owner's launch is unchanged");
  await refused(memberAccount(sb({ ...world, accounts: [{ id: "own", provider: "claude", person: null }] }), rec, kt(ANA), "t"));
  // the Mac-server case: no deps.auth credential at all, a member with no account: refused, the thread row removed, nothing launched
  const mac = sb({ ...world, accounts: [{ id: "own", provider: "claude", person: null }], login: false });
  await refused(memberAccount(mac, rec, kt(ANA), "t"));
  assert.deepEqual(mac.deleted, ["t"]);
  // the open cases: a turn with no asker, a named agent, and a home with no kernel (no owner to compare with)
  assert.deepEqual(await memberAccount(sb(world), rec, {}, "t"), {});
  assert.equal((await memberAccount(sb(world), rec, { ...kt(ANA), agent: "kit" }, "t")).account, undefined);
  const noKernel = sb(world); noKernel.deps.owner = () => null;
  assert.equal((await memberAccount(noKernel, rec, kt(ANA), "t")).account, undefined);
  // a kernel whose owner cannot be read is not "no kernel": nobody can be told to be the owner, so a member with no account is refused
  const blank = sb({ ...world, accounts: [{ id: "own", provider: "claude", person: null }] }); blank.deps.owner = () => "";
  const unknown = (/** @type {Promise<any>} */ p) => assert.rejects(p, (/** @type {any} */ e) => e.code === "unavailable" && /cannot tell just now who owns this Space/.test(e.message) && /Try again in a minute/.test(e.message));
  await unknown(memberAccount(blank, rec, kt(ANA), "t"));   // (the words say the owner is unknown, to the real owner too: nobody can be told to be the owner)
  await unknown(askerOver(blank, "t", { asker: ANA }));
  const hers = sb(world); hers.deps.owner = () => "";
  assert.equal((await memberAccount(hers, rec, kt(ANA), "t")).account, "anas", "a member with an account of their own still runs on it");
  for (const named of ["own", "bens"]) {
    const w = sb(world);
    await assert.rejects(memberAccount(w, rec, { ...kt(ANA), account: named }, "t"), (/** @type {any} */ e) => e.code === "account_unavailable", `naming ${named} gets a member nothing`);
    assert.deepEqual(w.deleted, ["t"], "and the thread is not left half made");
  }
  assert.equal((await memberAccount(sb(world), rec, { ...kt(ANA), account: "anas" }, "t")).account, "anas", "their own, named, passes");
});

test("an alias of the owner counts as the owner only through the canonical form; one the Switchboard cannot read as the owner is refused, never given the owner's login", async () => {
  const canon = (/** @type {string} */ p) => (p === "per_owner_alias" ? OWNER : p);
  assert.equal(await askerOver(sb({ login: true, canon }), "t", { asker: "per_owner_alias" }), null, "the owner under another id");
  await refused(askerOver(sb({ login: true }), "t", { asker: "per_owner_alias" }));
});

test("an agent's launch for a person who is not the owner is refused with the next step; the owner, no person, no kernel and a named account are unchanged; an unreadable owner fails closed", async () => {
  const i = { agent: "kit" };
  const refusedAgent = (/** @type {Promise<any>} */ p) => assert.rejects(p, (/** @type {any} */ e) => e.code === "no_account" && /Ask the owner to pick one/.test(e.message) && /Nothing was started/.test(e.message));
  await refusedAgent(agentLaunchGuard(sb(), i, ANA, OWNER));
  await agentLaunchGuard(sb(), i, OWNER, OWNER);
  await agentLaunchGuard(sb(), i, null, OWNER);
  await agentLaunchGuard(sb(), i, ANA, undefined);
  await agentLaunchGuard(sb(), { ...i, account: "anas" }, ANA, OWNER);
  await agentLaunchGuard(sb(), { lean: true }, ANA, OWNER);   // a tool-less agentless launch
  // an agent with a credential picked for it runs on that for a member (its vault token or key is in the launch); one with nothing picked is refused
  // a picked credential is the owner's: someone else's turn runs on it only when the launch delivers it unreadable to the turn's tools (delivered "fd"); an env var, a file, or a delivery nobody reports is refused
  const withDelivery = (/** @type {any} */ how) => { const x = sb(); x.deps.credentialDelivery = () => how; return x; };
  const refusedYet = (/** @type {Promise<any>} */ p, /** @type {RegExp} */ words) => assert.rejects(p, (/** @type {any} */ e) => e.code === "no_account" && words.test(e.message) && /Nothing was started/.test(e.message));
  for (const env of [{ CLAUDE_CODE_OAUTH_TOKEN: "x" }, { ANTHROPIC_API_KEY: "x" }]) {
    await agentLaunchGuard(withDelivery("fd"), { ...i, env }, ANA, OWNER);
    await refusedYet(agentLaunchGuard(withDelivery("env"), { ...i, env }, ANA, OWNER), /API key or a setup token/);
    await refusedYet(agentLaunchGuard(withDelivery("file"), { ...i, env }, ANA, OWNER), /API key or a setup token/);
    await refusedYet(agentLaunchGuard(withDelivery("???"), { ...i, env }, ANA, OWNER), /API key or a setup token/);
    await refusedYet(agentLaunchGuard(sb(), { ...i, env }, ANA, OWNER), /The owner can run it for you/);   // before any delivery is reported
    await agentLaunchGuard(withDelivery("env"), { ...i, env }, OWNER, OWNER);   // the owner's own turn is unchanged
    await agentLaunchGuard(withDelivery("env"), { ...i, env }, null, OWNER);    // so is a call with no person
  }
  await agentLaunchGuard(withDelivery("fd"), { ...i, fallback: { env: { ANTHROPIC_API_KEY: "x" } } }, ANA, OWNER);
  await refusedYet(agentLaunchGuard(withDelivery("env"), { ...i, fallback: { env: { ANTHROPIC_API_KEY: "x" } } }, ANA, OWNER), /API key or a setup token/);
  // a teammate's launch (team-credential) is judged the same
  await agentLaunchGuard(withDelivery("fd"), { agent: "tm", agent_kind: "teammate", env: { ANTHROPIC_API_KEY: "x" } }, ANA, OWNER);
  await refusedYet(agentLaunchGuard(withDelivery("env"), { agent: "tm", agent_kind: "teammate", env: { ANTHROPIC_API_KEY: "x" } }, ANA, OWNER), /API key or a setup token/);
  // an admin's turn is the owner's kind of turn
  const adminSb = sb(); adminSb.deps.membershipOf = async (/** @type {string} */ p) => (p === ANA ? { role: "admin" } : { role: "member" });
  await agentLaunchGuard(adminSb, { ...i, env: { ANTHROPIC_API_KEY: "x" } }, ANA, OWNER);
  await refusedYet(agentLaunchGuard(adminSb, { ...i, env: { ANTHROPIC_API_KEY: "x" } }, BEN, OWNER), /The owner can run it for you/);
  await refusedAgent(agentLaunchGuard(sb(), { ...i, env: {} }, ANA, OWNER));   // nothing picked
  await refusedAgent(agentLaunchGuard(sb(), i, ANA, ""));
  await refusedAgent(agentLaunchGuard(sb(), i, OWNER, ""));
  const canon = (/** @type {string} */ p) => (p === "per_owner_alias" ? OWNER : p);
  await agentLaunchGuard(sb({ canon }), i, "per_owner_alias", OWNER);
});

test("checkLaunch: who asks is the first person on the chain, else the person the module says the work is for; automation, nobody-recorded and agentless jobs are told apart", async () => {
  const chain = (/** @type {string[]} */ ...ids) => ({ hops: ids.map(id => ({ actor: id === "assistant" ? { kind: "agent", id } : { kind: "person", id } })) });
  const env = { ANTHROPIC_API_KEY: "x" }, tm = { agent: "tm", agent_kind: "teammate", env };
  const none = sb();
  await assert.rejects(checkLaunch(none, tm, chain(ANA), OWNER), /cannot be used for a teammate's request yet/, "a member's chain");
  await assert.rejects(checkLaunch(none, tm, chain(ANA, "assistant"), OWNER), /cannot be used for a teammate's request yet/, "a member's session chain (she and the assistant)");
  assert.equal(await checkLaunch(none, tm, chain(OWNER), OWNER), OWNER);
  await assert.rejects(checkLaunch(none, { ...tm, for_person: ANA }, null, OWNER), /cannot be used for a teammate's request yet/, "no chain, the module says the work is for a member");
  assert.equal(await checkLaunch(none, { ...tm, for_person: OWNER }, null, OWNER), OWNER, "no chain, the module says it is for the owner");
  assert.equal(await checkLaunch(none, { ...tm, for_person: "automation" }, null, OWNER), null, "automation, named by the module");
  // No person on the call is not judged (the narrow gate): the owner's surfaces, a restart re-running a queued request, a duty and a Flow run as they did before the gate.
  assert.equal(await checkLaunch(none, tm, null, OWNER), null, "nobody recorded, a picked credential: not judged");
  assert.equal(await checkLaunch(none, { agent: "tm", agent_kind: "teammate" }, null, OWNER), null, "nobody recorded, nothing picked (ambient): not judged either");
  await assert.rejects(checkLaunch(none, { agent: "tm", agent_kind: "teammate" }, chain(ANA), OWNER), /has no AI sign-in picked for it/, "a member, nothing picked (ambient)");
  // an agentless launch: tool-less passes for anyone; WITH tools it is the machine's own sign-in, the owner's
  assert.equal(await checkLaunch(none, { tools: "none" }, chain(ANA), OWNER), ANA, "tool-less");
  assert.equal(await checkLaunch(none, { lean: true }, chain(ANA), OWNER), ANA, "lean");
  await assert.rejects(checkLaunch(none, {}, chain(ANA), OWNER), /runs on the machine's own sign-in, which is the owner's/, "agentless with tools, a member");
  await assert.rejects(checkLaunch(none, { for_person: ANA }, null, OWNER), /runs on the machine's own sign-in/, "agentless with tools, for a member");
  assert.equal(await checkLaunch(none, {}, chain(OWNER), OWNER), OWNER, "agentless with tools, the owner");
  assert.equal(await checkLaunch(none, {}, null, OWNER), null, "agentless with tools, nobody: today's behaviour (the planner refuses a member's job itself)");
  // the narrow gate reads no caller label: a call with no person is not judged whatever it says it is
  for (const label of ["cli", "local", "mcp", "device"]) assert.equal(await checkLaunch(none, tm, null, OWNER), null, `${label}: no person, not judged`);
});

test("trustedLaunch keeps for_person only from a first-party module's call", () => {
  const i = { agent: "a", for_person: "per_x" };
  assert.equal(trustedLaunch(i, { firstParty: true, caller: "module:team" }).for_person, "per_x");
  for (const meta of [{ caller: "module:team" }, { firstParty: true, caller: "cli" }, { firstParty: true, caller: "mcp" }, { firstParty: false, caller: "module:added" }, undefined]) assert.equal(/** @type {any} */ (trustedLaunch(i, meta)).for_person, undefined, JSON.stringify(meta));
  assert.deepEqual(trustedLaunch({ agent: "a" }, undefined), { agent: "a" });
});

test("trustedLaunch: run_as and flow_origin come only from the agents module", async () => {
  const mk = caller => ({ firstParty: true, caller });
  const i = { agent: "juno", run_as: "ana", flow_origin: { flow: "f" }, for_person: "ana" };
  assert.deepEqual(trustedLaunch(i, mk("module:agents")), i);
  for (const c of ["module:planner", "module:stream"]) assert.deepEqual(trustedLaunch(i, mk(c)), { agent: "juno", for_person: "ana" });
  assert.deepEqual(trustedLaunch(i, { firstParty: false, caller: "mcp" }), { agent: "juno" });
});

test("a live session started for one member is never reused for another member's turn: the other asker is moved onto their own account (a fresh process), the account's own person goes on as before", async () => {
  const world = { accounts: [{ id: "anas", provider: "claude", person: ANA }, { id: "bens", provider: "claude", person: BEN }], login: true };
  const onBens = { provider: "claude", account: "bens", project: null, agent: null };
  // Ana asks in a thread whose session runs on Ben's account: her turn is a one-turn hop onto HER account, never a send into Ben's process
  assert.deepEqual(await askerOver(sb({ ...world, rec: onBens }), "t", { asker: ANA }), { provider: "claude", account: "anas", person: ANA });
  // Ben asks in his own thread: nothing moves
  assert.equal(await askerOver(sb({ ...world, rec: onBens }), "t", { asker: BEN }), null);
  // the move is to a different account of the same provider, which loads no native session of the first: it starts fresh and is handed the conversation
  assert.equal(movesAccount(onBens, "claude", { id: "anas" }), true);
  assert.equal(movesAccount(onBens, "claude", { id: "bens" }), false);
  // a member with no account of their own is refused (no reuse of Ben's), and a launch for Ana never names Ben's account by input
  await refused(askerOver(sb({ accounts: [{ id: "bens", provider: "claude", person: BEN }], rec: onBens, login: true }), "t", { asker: ANA }));
  await assert.rejects(memberAccount(sb(world), { provider: "claude", account: "bens", project: null, agent: null }, { kernelTurn: { chat: "c", asker: ANA }, account: "bens" }, "t"), (/** @type {any} */ e) => e.code === "account_unavailable");
});

test("trustedLaunch: account and person, like for_person, are kept only from a first-party module; an added module cannot name another person's login", () => {
  const input = { agent: "kit", purpose: "job", account: "bobs-login-id", person: "per_bob", for_person: "per_bob" };
  const added = trustedLaunch(input, { firstParty: false, caller: "module:added-thing" });
  assert.equal(added.account, undefined, "an added module's account is dropped");
  assert.equal(added.person, undefined, "and its person");
  assert.equal(added.for_person, undefined);
  const mine = trustedLaunch(input, { firstParty: true, caller: "module:agents" });
  assert.deepEqual([mine.account, mine.person, mine.for_person], ["bobs-login-id", "per_bob", "per_bob"], "the agents module keeps them");
  assert.equal(trustedLaunch(input, { firstParty: true, caller: "cli" }).account, undefined, "a first-party flag without a module caller is not enough");
});

test("checkLaunch: an account named for a person it is for must be that person's own", async () => {
  const none = sb();
  await assert.rejects(checkLaunch(none, { agent: "kit", account: "a1", for_person: BEN, person: ANA }, null, OWNER), /not that person's own/, "another person's account");
  await assert.rejects(checkLaunch(none, { agent: "kit", account: "a1", for_person: BEN }, null, OWNER), /not that person's own/, "no person named with it");
  assert.equal(await checkLaunch(none, { agent: "kit", account: "a1", for_person: BEN, person: BEN }, null, OWNER), BEN, "the same person: judged as before (a named account is memberAccount's)");
});

// A new thread that names no provider runs on the AI the person actually has, on a box that has no Claude login of its own (the first-run OpenRouter key).
import { accountProviderFor } from "./asker-account.js";
const sbFor = (/** @type {any} */ o) => ({
  deps: { requireAccount: true, providers: { list: () => ["openrouter", "codex"] }, ...(o.deps || {}) },
  accountFor: async (/** @type {any} */ q) => { const hit = (o.accounts || []).find((/** @type {any} */ a) => a.provider === q.provider && (!q.person || !a.person || a.person === q.person)); if (!hit) throw Object.assign(new Error("none"), { code: "not_found" }); return hit; },
});
test("a start with no provider, on a box with no Claude sign-in, runs on the provider of the person's own account", async () => {
  const sb = sbFor({ accounts: [{ id: "acct_or", provider: "openrouter", person: null }] });
  assert.deepEqual(await accountProviderFor(sb, { kernelTurn: { asker: "per_owner" } }), { provider: "openrouter", account: "acct_or" });
});
test("Claude stays the default when it can run, or the start names a provider, an agent or an account", async () => {
  const both = sbFor({ accounts: [{ id: "c1", provider: "claude", person: null }, { id: "o1", provider: "openrouter", person: null }] });
  assert.equal(await accountProviderFor(both, {}), null, "a Claude account of theirs");
  const token = sbFor({ accounts: [{ id: "o1", provider: "openrouter", person: null }], deps: { auth: async () => ({ env: { CLAUDE_CODE_OAUTH_TOKEN: "x" } }) } });
  assert.equal(await accountProviderFor(token, {}), null, "the box holds a Claude credential");
  const ambient = sbFor({ accounts: [{ id: "o1", provider: "openrouter", person: null }], deps: { requireAccount: false } });
  assert.equal(await accountProviderFor(ambient, {}), null, "an ambient login may run it");
  const only = sbFor({ accounts: [{ id: "o1", provider: "openrouter", person: null }] });
  for (const o of [{ provider: "claude" }, { agent: "juno" }, { account: "x" }]) assert.equal(await accountProviderFor(only, o), null, JSON.stringify(o));
});
test("a person with no account of their own gets nothing from another person's: the default stays, and the refusal is the old one", async () => {
  const sb = sbFor({ accounts: [{ id: "bens", provider: "openrouter", person: "per_ben" }] });
  assert.equal(await accountProviderFor(sb, { kernelTurn: { asker: "per_cy" } }), null);
});
