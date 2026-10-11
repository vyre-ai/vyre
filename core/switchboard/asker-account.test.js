// @ts-check
// A person who is not the owner never runs on the owner's login or the machine's own credential (review F3, 11 Oct): the rule of askerOver and memberAccount, against the Switchboard's own shape, with the
// accounts the sessions module would answer. The owner's turns are unchanged; an alias of the owner counts as the owner only through the Switchboard's canonical form, and anything it cannot read as the owner is refused.
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { askerOver, memberAccount } from "./asker-account.js";

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
  const noKernel = sb(world); noKernel.deps.owner = () => "";
  assert.equal((await memberAccount(noKernel, rec, kt(ANA), "t")).account, undefined);
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
