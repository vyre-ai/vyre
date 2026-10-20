// @ts-check
// The Flow model port picks the door's driver from the account's provider: a member's Claude, Codex or Grok sign-in goes to the sign-in driver with HER credential only (lent from her own vault, or her
// login's own folder), the owner's never; a key keeps the HTTP driver; and a failure is never retried on another account or provider. Tokens here are fakes.
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { flowModel, DOOR_PROVIDERS } from "./flow-model.js";

const BEN = "per_" + "b".repeat(26), OWNER = "per_" + "o".repeat(26);
const BEN_TOKEN = "sk-ant-oat01-" + "b".repeat(60), OWNER_TOKEN = "sk-ant-oat01-" + "a".repeat(60), BEN_KEY = "sk-or-v1-" + "b".repeat(40);

/** A registry whose accounts are `rows`: resolve answers a person's own rows only, as sessions.accounts.resolve does. @param {any[]} rows */
function world(rows, o = {}) {
  /** @type {any[]} */ const lends = [], doors = [], keys = [];
  const registry = {
    call: async (/** @type {string} */ tool, /** @type {any} */ q) => {
      assert.equal(tool, "sessions.accounts.resolve");
      const mine = rows.filter(a => a.provider === q.provider && (a.person ? a.person === q.person : q.person === OWNER));
      if (q.account) { const a = mine.find(x => x.id === q.account); return a ? { data: a } : { error: { code: "not_found", message: "no" } }; }
      const d = mine.find(x => x.is_default) || (mine.length === 1 ? mine[0] : null);
      return d ? { data: d } : { data: null };
    },
    deps: {
      lendKey: async (/** @type {any} */ q) => { lends.push(q); const a = rows.find(x => x.id === q.account); return a && a.person === q.asker ? { data: { value: a.secret } } : { error: { code: "denied" } }; },
      accountKey: async (/** @type {any} */ a) => { keys.push(a.id); return a.secret; },
      accountHome: (/** @type {any} */ a) => `/vyre/accounts/${a.id}`,
    },
  };
  const door = { call: async (/** @type {any} */ i) => { doors.push(i); if (o.fail) throw Object.assign(new Error("Your Claude sign-in has expired. Sign in again in Settings, AI accounts."), { code: "signin_expired" }); return { content: "refund", usage: { input_tokens: 1, output_tokens: 1 } }; } };
  const m = flowModel({ registry });
  const call = (/** @type {any} */ q) => m.call({ purpose: "classify", max_tokens: 64, messages: [{ role: "user", content: "x" }], expect: { kind: "label", labels: ["refund", "other"] }, space: "spc_1", door, chainFor: async (/** @type {string} */ p) => ({ person: p }), ...q });
  return { m, call, lends, doors, keys };
}

const ownerClaude = { id: "acc_owner_claude", provider: "claude", kind: "setup-token", label: "Owner's Claude", person: null, secret: OWNER_TOKEN, is_default: true };
const benClaude = { id: "acc_ben_claude", provider: "claude", kind: "setup-token", label: "Ben's Claude", person: BEN, own_vault: true, secret: BEN_TOKEN };
const benKey = { id: "acc_ben_or", provider: "openrouter", kind: "api-key", label: "Ben's OpenRouter", person: BEN, own_vault: true, secret: BEN_KEY };

test("the door's providers: keys first, then the sign-ins", () => {
  assert.deepEqual([...DOOR_PROVIDERS], ["openrouter", "openai-compatible", "opencode", "claude", "codex", "grok"]);
});

test("a member's Claude sign-in named under Runs on: her token, lent from her own vault, to the Claude driver; never the owner's", async () => {
  const w = world([ownerClaude, benClaude, benKey]);
  const r = await w.call({ person: BEN, account: benClaude.id, provider: "claude" });
  assert.equal(r.content, "refund");
  assert.equal(w.doors.length, 1);
  const d = w.doors[0];
  assert.equal(d.provider, "claude");
  assert.deepEqual(d.chain, { person: BEN }, "called as her chain");
  assert.deepEqual(d.credential.env, { CLAUDE_CODE_OAUTH_TOKEN: BEN_TOKEN });
  assert.deepEqual(d.credential.account, { id: benClaude.id, provider: "claude", kind: "setup-token", label: "Ben's Claude", person: BEN });
  assert.deepEqual(d.expect, { kind: "label", labels: ["refund", "other"] }, "the step's reading rides to the driver");
  assert.ok(!JSON.stringify(w.doors).includes(OWNER_TOKEN), "the owner's token never appears for her");
  assert.deepEqual(w.lends.map(l => [l.asker, l.account]), [[BEN, benClaude.id]]);
  assert.deepEqual(w.keys, [], "the home's own keys were never read");
});

test("her only account a sign-in: it is her default; the owner's own runs as the owner's", async () => {
  const w = world([ownerClaude, benClaude]);
  await w.call({ person: BEN });
  assert.equal(w.doors[0].credential.env.CLAUDE_CODE_OAUTH_TOKEN, BEN_TOKEN);
  await w.call({ person: OWNER });
  assert.equal(w.doors[1].credential.env.CLAUDE_CODE_OAUTH_TOKEN, OWNER_TOKEN);
  assert.deepEqual(w.keys, [ownerClaude.id]);
});

test("a failed sign-in is the step's failure: never retried on her key or another provider", async () => {
  const w = world([benClaude, benKey], { fail: true });
  await assert.rejects(w.call({ person: BEN, account: benClaude.id, provider: "claude" }), (e) => /** @type {any} */ (e).code === "signin_expired");
  assert.equal(w.doors.length, 1, "one call");
  assert.deepEqual(w.lends.map(l => l.account), [benClaude.id], "her OpenRouter key was never lent");
});

test("a login goes with its own folder and no key; Codex and Grok keys ride in their own variables; a sign-in to its own address is refused", async () => {
  const codexLogin = { id: "acc_ben_codex", provider: "codex", kind: "login", label: "Ben's Codex", person: BEN, uid: 2003, signed_in_at: 1 };
  const grokKey = { id: "acc_ben_grok", provider: "grok", kind: "api-key", label: "Ben's Grok", person: BEN, own_vault: true, secret: "xai-" + "g".repeat(40) };
  const elsewhere = { id: "acc_ben_else", provider: "claude", kind: "api-key", label: "Elsewhere", person: BEN, own_vault: true, secret: "k", base_url: "https://example.com" };
  const notYet = { id: "acc_ben_grok2", provider: "grok", kind: "login", label: "Grok", person: BEN, needs: "sign-in" };
  const w = world([codexLogin, grokKey, elsewhere, notYet]);
  await w.call({ person: BEN, account: codexLogin.id });
  assert.deepEqual([w.doors[0].provider, w.doors[0].credential.env, w.doors[0].credential.home, w.doors[0].credential.account.uid], ["codex", {}, `/vyre/accounts/${codexLogin.id}`, 2003]);
  assert.deepEqual(w.lends, [], "a login lends nothing");
  await w.call({ person: BEN, account: grokKey.id, provider: "grok" });
  assert.deepEqual(w.doors[1].credential.env, { XAI_API_KEY: grokKey.secret });
  await assert.rejects(w.call({ person: BEN, account: elsewhere.id, provider: "claude" }), /address of its own/);
  await assert.rejects(w.call({ person: BEN, account: notYet.id, provider: "grok" }), (e) => /** @type {any} */ (e).code === "signin_expired");
  assert.equal(w.doors.length, 2, "nothing sent for either");
});

test("Runs on accepts her own sign-in, never someone else's", async () => {
  const w = world([ownerClaude, benClaude]);
  assert.equal(await w.m.accountOk({ person: BEN, account: benClaude.id, provider: "claude" }), true);
  assert.equal(await w.m.accountOk({ person: BEN, account: ownerClaude.id, provider: "claude" }), false);
  assert.equal(await w.m.accountOk({ person: BEN, account: benClaude.id }), true, "found without naming the provider");
});

const OC = "oc-test-key-0123456789abcdef", OWNER_OC = "oc-owner-key-0123456789abcdef";

test("a member's OpenCode Go account sends her key, the run id, and flattened text", async () => {
  const owner = { id: "acc_owner_oc", provider: "opencode", kind: "api-key", label: "Owner OpenCode", person: null, secret: OWNER_OC, model: "glm-5.3", go_only: false };
  const ben = { id: "acc_ben_oc", provider: "opencode", kind: "api-key", label: "Ben OpenCode", person: BEN, own_vault: true, vault_item: "oc", secret: OC, model: "glm-5.3", go_only: true };
  const w = world([owner, ben]);
  await w.call({ person: BEN, account: ben.id, provider: "opencode", run: "run_42", model: "glm-5.3", messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] });
  const d = w.doors[0];
  assert.equal(d.provider, "opencode");
  assert.equal(d.go, true);
  assert.equal(d.session, "run_42");
  assert.equal(d.credential.key, OC);
  assert.equal(d.credential.base, undefined);
  assert.equal(d.messages[0].content, "hi");
  assert.equal(JSON.stringify(w.doors).includes(OWNER_OC), false);
});

test("an OpenCode account that is not on Go sends neither go nor a session", async () => {
  const ben = { id: "acc_ben_oc", provider: "opencode", kind: "api-key", label: "Ben OpenCode", person: BEN, secret: OC, model: "glm-5.3", go_only: false };
  const w = world([ben]);
  await w.call({ person: BEN, account: ben.id, provider: "opencode", run: "run_9", model: "glm-5.3" });
  assert.equal(w.doors[0].go, undefined);
  assert.equal(w.doors[0].session, undefined);
});

test("OpenCode Go with no run passes an empty session so the call is not sent", async () => {
  const ben = { id: "acc_ben_oc", provider: "opencode", kind: "api-key", label: "Ben OpenCode", person: BEN, secret: OC, model: "glm-5.3", go_only: true };
  const w = world([ben]);
  await w.call({ person: BEN, account: ben.id, provider: "opencode", model: "glm-5.3" });
  assert.equal(w.doors[0].go, true);
  assert.equal(w.doors[0].session, "");
});
