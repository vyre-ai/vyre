// @ts-check
// A person who is not the owner never runs on the owner's login or the machine's own credential (review F3, 11 Oct): the rule of askerOver and memberAccount, against the Switchboard's own shape, with the
// accounts the sessions module would answer. The owner's turns are unchanged; an alias of the owner counts as the owner only through the Switchboard's canonical form, and anything it cannot read as the owner is refused.
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { agentLaunchGuard, checkLaunch, trustedLaunch, askerOver, memberAccount } from "./asker-account.js";

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
  await assert.rejects(checkLaunch(none, tm, null, OWNER), /nobody is recorded as having asked/, "nobody recorded, a picked credential");
  assert.equal(await checkLaunch(none, { agent: "tm", agent_kind: "teammate" }, null, OWNER), null, "nobody recorded, nothing picked: as before");
  // an agentless launch: tool-less passes for anyone; WITH tools it is the machine's own sign-in, the owner's
  assert.equal(await checkLaunch(none, { tools: "none" }, chain(ANA), OWNER), null, "tool-less");
  assert.equal(await checkLaunch(none, { lean: true }, chain(ANA), OWNER), null, "lean");
  await assert.rejects(checkLaunch(none, {}, chain(ANA), OWNER), /runs on the machine's own sign-in, which is the owner's/, "agentless with tools, a member");
  await assert.rejects(checkLaunch(none, { for_person: ANA }, null, OWNER), /runs on the machine's own sign-in/, "agentless with tools, for a member");
  assert.equal(await checkLaunch(none, {}, chain(OWNER), OWNER), OWNER, "agentless with tools, the owner");
  assert.equal(await checkLaunch(none, {}, null, OWNER), null, "agentless with tools, nobody: today's behaviour (the planner refuses a member's job itself)");
});

test("trustedLaunch keeps for_person only from a first-party module's call", () => {
  const i = { agent: "a", for_person: "per_x" };
  assert.equal(trustedLaunch(i, { firstParty: true, caller: "module:team" }).for_person, "per_x");
  for (const meta of [{ caller: "module:team" }, { firstParty: true, caller: "cli" }, { firstParty: true, caller: "mcp" }, { firstParty: false, caller: "module:added" }, undefined]) assert.equal(/** @type {any} */ (trustedLaunch(i, meta)).for_person, undefined, JSON.stringify(meta));
  assert.deepEqual(trustedLaunch({ agent: "a" }, undefined), { agent: "a" });
});
