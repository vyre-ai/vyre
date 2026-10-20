// @ts-check
// AI accounts (the Deck's settings-accounts, ported): the rows as drawn, one line per state, the sign-in flow over a fake box.
import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";

const strip = Boolean(/** @type {any} */ (process.features).typescript);
const ROWS = { accounts: [
  { id: "a1", provider: "claude", label: "Claude", kind: "login", synthetic: true, default: true },
  { id: "a2", provider: "codex", label: "work", kind: "login", signed_in_at: 5, identity: { email: "me@example.com", org: "Acme" } },
  { id: "a3", provider: "codex", label: "home", kind: "login", needs: "sign-in" },
  { id: "a4", provider: "grok", label: "Grok", kind: "api-key", privacy: false, privacy_label: "Privacy mode is off.", privacy_note: "Turn it on at x.ai." },
  { nope: 1 }, null,
] };

/** @param {any} [o] */
function box(o = {}) {
  /** @type {{ tool: string, input: any }[]} */
  const seen = [];
  const call = async (/** @type {string} */ tool, /** @type {any} */ input = {}) => { seen.push({ tool, input }); return o[tool] ? (typeof o[tool] === "function" ? o[tool](input) : o[tool]) : { data: tool === "sessions.accounts.list" ? ROWS : {} }; };
  return { call, seen };
}

test("accounts: the rows keep only what is drawn, the state is said in words", { skip: !strip }, async () => {
  const m = await import("./accounts-model.ts");
  const rows = m.accountsOf(ROWS);
  assert.deepEqual(rows.map((r) => r.id), ["a1", "a2", "a3", "a4"], "a row with no id or provider is dropped");
  assert.deepEqual(rows.map(m.stateWord), ["Signed in on this computer", "Signed in as me@example.com, Acme", "Needs signing in again", "API key"]);
  assert.deepEqual(rows.map(m.canSignIn), [false, false, true, false], "only a login that is not signed in, or says so, offers Sign in");
  assert.deepEqual(rows.map((r) => m.canMakeDefault(r, rows)), [false, true, true, false], "Make default needs a second account of the provider");
  assert.equal(m.providerName("codex"), "Codex");
  assert.equal(m.providerName("acme"), "Acme");
  assert.deepEqual(m.accountsOf(null), []);
});

test("accounts: a sign-in address is opened only when it is plain https", { skip: !strip }, async () => {
  const { safeUrl } = await import("./accounts-model.ts");
  assert.equal(safeUrl("https://auth.example.com/x?y=1"), true);
  for (const bad of ["http://x.example", "javascript:alert(1)", "https://u:p@x.example", "https://x.example/a b", "https://x.example\\y", "", null, 5]) assert.equal(safeUrl(bad), false, String(bad));
});

test("accounts: a sign-in is one start and then status calls until it is done, failed, or waits for a pasted code", { skip: !strip }, async () => {
  const { accountsSource } = await import("./accounts-source.ts");
  const { keepFollowing } = await import("./accounts-model.ts");
  const b = box({ "sessions.accounts.signin": (/** @type {any} */ i) => ({ data: i.provider ? { flow: "f1", step: "url", url: "https://x.example/auth", code: "ABCD" } : i.code ? { step: "waiting" } : { step: "done" } }) });
  const s = accountsSource(b.call);
  const f = await s.start("codex", "work");
  assert.deepEqual(f, { id: "f1", step: "url", provider: "codex", url: "https://x.example/auth", code: "ABCD" });
  assert.equal(keepFollowing(f), false, "a pasted code is the person's move");
  await s.paste("f1", "  123  ");
  const d = await s.follow("f1", "codex");
  assert.deepEqual([d.step, d.id, keepFollowing(d)], ["done", "f1", false]);
  assert.equal(keepFollowing({ id: "f1", step: "waiting", provider: "codex" }), true);
  assert.deepEqual(b.seen.map((x) => x.input), [{ provider: "codex", label: "work" }, { flow: "f1", code: "123" }, { flow: "f1" }]);
});

test("accounts: default, remove and privacy are one call each; a refusal comes back as an error with the box's words", { skip: !strip }, async () => {
  const { accountsSource } = await import("./accounts-source.ts");
  const b = box({ "sessions.accounts.remove": { error: { code: "denied", message: "Only the owner removes an account." } } });
  const s = accountsSource(b.call);
  await s.makeDefault("a2"); await s.setPrivacy("a4", true);
  await assert.rejects(s.remove("a2"), /Only the owner/);
  assert.deepEqual(b.seen, [
    { tool: "sessions.accounts.bind", input: { id: "a2", is_default: true } },
    { tool: "sessions.accounts.set", input: { account: "a4", privacy: true } },
    { tool: "sessions.accounts.remove", input: { id: "a2" } },
  ]);
});

test("a server that runs Claude on its own login says so in words with a next step", async () => {
  const { serverCannotWords } = await import("./accounts-model.ts");
  assert.match(serverCannotWords("on this machine Claude uses the login already on it (run claude and sign in there)") ?? "", /Ask the owner/);
  assert.equal(serverCannotWords("some other failure"), null);
});

test("one list: every provider is a row of the same shape, in a fixed order, its status read from sessions.accounts.list alone", { skip: !strip }, async () => {
  const m = await import("./accounts-model.ts");
  const { accountsSource } = await import("./accounts-source.ts");
  const b = box();
  const blocks = m.providerBlocks(await accountsSource(b.call).list());
  assert.deepEqual(b.seen.map((x) => x.tool), ["sessions.accounts.list"], "one call drives every row");
  assert.deepEqual(blocks.map((p) => p.id), ["claude", "codex", "grok", "openrouter", "openai-compatible", "opencode"], "the same order connected or not; none is lifted out");
  assert.deepEqual(blocks.map((p) => Object.keys(p).sort().join()), Array(6).fill("accounts,connected,id,key,name,signIn,status,vendor"), "every provider is drawn from the same shape");
  assert.deepEqual(blocks.map((p) => [p.name, p.vendor]), [["Claude", "Anthropic"], ["Codex", "OpenAI"], ["Grok", "xAI"], ["OpenRouter", "OpenRouter"], ["OpenAI-compatible", "Any key"], ["OpenCode", "OpenCode"]]);
  assert.deepEqual(blocks.map((p) => [p.connected, p.status]), [
    [true, "Connected as this computer's sign-in"], [true, "Connected as me@example.com, Acme"], [true, "Connected as Grok"], [false, "Not connected"], [false, "Not connected"], [false, "Not connected"],
  ]);
  assert.deepEqual(blocks.map((p) => [p.signIn, p.key]), [[true, "anthropic-compatible"], [true, null], [true, null], [false, "openrouter"], [false, "openai-compatible"], [false, "opencode"]], "sign-in where the provider has one, a key where keys are supported");
  assert.deepEqual(blocks[1].accounts.map((a) => a.id), ["a2", "a3"], "each account sits under its own provider");
  assert.deepEqual(m.providerBlocks([], true).map((p) => p.key), m.providerBlocks([]).map((p) => p.key), "a member can add a key too, to her own Vault");
});

test("Claude just signed in reads Connected, because every place reads the same rows", { skip: !strip }, async () => {
  const m = await import("./accounts-model.ts");
  const signedIn = m.accountsOf([{ id: "c1", provider: "claude", label: "Work", kind: "login", signed_in_at: 9, identity: { email: "ada@example.com" } }]);
  const claude = m.providerBlocks(signedIn).find((p) => p.id === "claude");
  assert.deepEqual([claude?.connected, claude?.status], [true, "Connected as ada@example.com"]);
  const pending = m.accountsOf([{ id: "c1", provider: "claude", label: "Work", kind: "login", pending: true }]);
  assert.equal(m.providerBlocks(pending).find((p) => p.id === "claude")?.status, "Not connected", "a sign-in not finished is not connected");
  const two = m.accountsOf([{ id: "k1", provider: "openrouter", label: "A", kind: "api-key", vault_item: "ai-key-openrouter-1" }, { id: "k2", provider: "openrouter", label: "B", kind: "api-key", vault_item: "ai-key-openrouter-2" }]);
  assert.equal(m.providerBlocks(two).find((p) => p.id === "openrouter")?.status, "Connected with 2 accounts");
  assert.deepEqual(two.map(m.canReplaceKey), [true, true]);
});

test("Use an API key under a provider: its own kind, a key of another provider is pointed there, and the key is never in a refusal", { skip: !strip }, async () => {
  const { keyInputFor } = await import("./accounts-model.ts");
  const OR = "sk-or-v1-fake0000000000000000", XAI = "xai-fake00000000000000000000", OAI = "sk-proj-fake00000000000000000";
  assert.deepEqual(keyInputFor("openrouter", ` ${OR} `), { input: { kind: "openrouter", key: OR, label: "OpenRouter key", name: "OpenRouter key" } });
  assert.deepEqual(keyInputFor("openai-compatible", XAI, " Work "), { input: { kind: "openai-compatible", key: XAI, label: "Work", name: "Work", base_url: "https://api.x.ai/v1" } });
  assert.deepEqual(keyInputFor("openai-compatible", OAI, "", "https://llm.example.com/v1"), { input: { kind: "openai-compatible", key: OAI, label: "OpenAI-compatible key", name: "OpenAI-compatible key", base_url: "https://llm.example.com/v1" } });
  assert.match(/** @type {any} */ (keyInputFor("openai-compatible", OR)).problem, /Add it under OpenRouter/);
  assert.match(/** @type {any} */ (keyInputFor("claude", OR)).problem, /not look like a Claude key/);
  assert.match(/** @type {any} */ (keyInputFor("codex", OAI)).problem, /connects by signing in/);
  assert.match(/** @type {any} */ (keyInputFor("openrouter", "short")).problem, /does not look like an API key/);
  const OC = "oc-" + "a".repeat(20);
  assert.deepEqual(keyInputFor("opencode", OC), { input: { kind: "opencode", key: OC, label: "OpenCode key", name: "OpenCode key" } });
  assert.match(/** @type {any} */ (keyInputFor("opencode", OR)).problem, /Add it under OpenRouter/);
  assert.match(/** @type {any} */ (keyInputFor("opencode", OC, "", "https://opencode.ai")).problem, /one address/);
  assert.match(/** @type {any} */ (keyInputFor("openai-compatible", OAI, "", "http://x.example")).problem, /https/);
  const { accountsSource } = await import("./accounts-source.ts");
  const ok = box({ "sessions.accounts.key": { data: { account: "ac_9", provider: "openrouter", label: "OpenRouter key" } } });
  assert.deepEqual(await accountsSource(ok.call).addKey("openrouter", OR), { account: "ac_9", provider: "openrouter", label: "OpenRouter key" });
  assert.deepEqual(ok.seen.map((x) => x.tool), ["sessions.accounts.key"]);
  const bad = box({ "sessions.accounts.key": { error: { code: "bad_input", message: `refused ${OR}` } } });
  await assert.rejects(accountsSource(bad.call).addKey("openrouter", OR), (e) => !String(/** @type {Error} */ (e).message).includes(OR) && /refused \[key\]/.test(/** @type {Error} */ (e).message));
  const none = box();
  await assert.rejects(accountsSource(none.call).addKey("openrouter", "nope"), /does not look like an API key/);
  assert.deepEqual(none.seen, [], "a key that is not one is never sent");
});

test("a member's API key goes to her own Vault through the member key path, never the owner's key tool, with her Vault's password only when given", { skip: !strip }, async () => {
  const { accountsSource } = await import("./accounts-source.ts");
  const OR = "sk-or-v1-fake0000000000000000";
  const b = box({ "onboard.agent.key": { data: { account: "ac_m", provider: "openrouter", label: "Mine" } } });
  assert.deepEqual(await accountsSource(b.call).addKey("openrouter", OR, "Mine", "", { password: "a long password" }), { account: "ac_m", provider: "openrouter", label: "Mine" });
  assert.deepEqual(b.seen.map((x) => x.tool), ["onboard.agent.key"], "never sessions.accounts.key, which keeps keys in the owner's Vault");
  assert.deepEqual(b.seen[0].input, { kind: "openrouter", key: OR, label: "Mine", password: "a long password" });
  const locked = box({ "onboard.agent.key": { error: { code: "need_password", message: "Your password, to open your own Vault." } } });
  await assert.rejects(accountsSource(locked.call).addKey("openrouter", OR, "", "", {}), (e) => /** @type {any} */ (e).code === "need_password");
  assert.equal(locked.seen[0].input.password, undefined, "no password is sent until she gives one");
});

test("Replace key: checked with the provider first, then put into the Vault item the account already names, keeping its hosts", { skip: !strip }, async () => {
  const m = await import("./accounts-model.ts");
  const { accountsSource } = await import("./accounts-source.ts");
  const OR = "sk-or-v1-fake1111111111111111";
  const [a] = m.accountsOf([{ id: "k1", provider: "openrouter", label: "Router", kind: "api-key", vault_item: "ai-key-openrouter-1" }]);
  const b = box({ "sessions.accounts.key": { data: { checked: true } }, "vault.list": { data: { items: [{ name: "ai-key-openrouter-1", kind: "api-key", description: "OpenRouter API key", hosts: ["https://openrouter.ai"] }] } }, "vault.put": { data: {} } });
  await accountsSource(b.call).replaceKey(a, OR);
  assert.deepEqual(b.seen, [
    { tool: "sessions.accounts.key", input: { kind: "openrouter", key: OR, check_only: true } },
    { tool: "vault.list", input: {} },
    { tool: "vault.put", input: { name: "ai-key-openrouter-1", kind: "api-key", description: "OpenRouter API key", value: OR, hosts: ["https://openrouter.ai"] } },
  ]);
  const refused = box({ "sessions.accounts.key": { error: { code: "bad_input", message: `the service refused ${OR}` } } });
  await assert.rejects(accountsSource(refused.call).replaceKey(a, OR), (e) => !String(/** @type {Error} */ (e).message).includes(OR));
  assert.deepEqual(refused.seen.map((x) => x.tool), ["sessions.accounts.key"], "a refused key never reaches the Vault");
});

test("Your Assistant uses: its own order's first account, and picking another puts it first without two of one provider", { skip: !strip }, async () => {
  const m = await import("./accounts-model.ts");
  const { accountsSource } = await import("./accounts-source.ts");
  const rows = m.accountsOf(ROWS);
  const b = box({ "agents.list": { data: [{ name: "kit", kind: "agent" }, { name: "juno", kind: "assistant" }] }, "sessions.routes.get": { data: { scope: "agent:juno", entries: [{ provider: "codex", account: "a3" }, { provider: "grok", account: "a4" }] } }, "sessions.routes.set": { data: {} } });
  const s = accountsSource(b.call);
  const got = await s.assistant();
  assert.deepEqual(got, { name: "juno", entries: [{ provider: "codex", account: "a3" }, { provider: "grok", account: "a4" }] });
  assert.equal(m.assistantAccount(got?.entries ?? [], rows)?.id, "a3");
  assert.equal(m.assistantAccount([{ provider: "claude" }], rows)?.id, "a1", "a provider with no account named is its default");
  assert.equal(m.assistantAccount([], rows), null);
  const next = m.withFirst(got?.entries ?? [], rows[1]);
  assert.deepEqual(next, [{ provider: "codex", account: "a2" }, { provider: "grok", account: "a4" }]);
  await s.setAssistant("juno", next);
  assert.deepEqual(b.seen.at(-1), { tool: "sessions.routes.set", input: { scope: "agent:juno", entries: next } });
  assert.deepEqual(m.withFirst([], rows[0]), [{ provider: "claude" }], "the computer's own sign-in is named by its provider");
});

test("no Claude-only card, copy or logic is left in AI accounts, first run's AI step or the agent page's account picker", async () => {
  const fs = await import("node:fs");
  const read = (/** @type {string} */ p) => fs.readFileSync(new URL(p, import.meta.url), "utf8");
  assert.equal(fs.existsSync(new URL("./ConnectClaude.tsx", import.meta.url)), false, "the separate Claude card is gone");
  const files = ["./AccountsCard.tsx", "./RealAgents.tsx", "./AiScreen.tsx", "./accounts-model.ts", "./logic.js", "../first-run/ai-accounts-model.js", "../../src/real/ai-connect.js", "../assistants/AgentParts.tsx"];
  const banned = [/Sign in to Claude/, /Connect Claude/, /Other AI accounts/, /skipClaude/, /addableFor/, /ConnectClaude/, /a Claude, Codex or Grok/];
  for (const f of files) for (const bad of banned) assert.doesNotMatch(read(f), bad, `${f}: ${bad}`);
  assert.doesNotMatch(read("./RealAgents.tsx"), /markRef\("agent"|providers\(\)/, "no face for a provider, and no second list of providers");
  assert.match(read("./AccountsCard.tsx"), /ProviderLogo/);
  // the agent page chooses its model with the one model picker, which draws each account's provider mark (the sign-in plan that listed accounts is gone: an agent runs on whoever uses it)
  assert.match(read("../assistants/AgentPage.tsx"), /ModelPicker/);
  assert.match(read("../../ui/components/ModelPicker.tsx"), /ProviderLogo/);
});
