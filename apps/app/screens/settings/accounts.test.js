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
  assert.deepEqual(rows.map(m.stateWord), ["Signed in on this machine", "Signed in as me@example.com, Acme", "Needs signing in again", "API key"]);
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

test("adding a key: the choices, the help under each, and a refusal that says what to do", { skip: !strip }, async () => {
  const m = await import("./accounts-model.ts");
  assert.deepEqual(m.KEY_CHOICES.map(([k]) => k), ["anthropic-compatible", "openrouter", "setup-token"]);
  assert.match(m.keyHelp("setup-token"), /private to you on this server/);
  assert.match(m.keyHelp("openrouter"), /openrouter\.ai/);
  assert.match(m.keyRefusal("denied", ""), /Sign in, then try again/);
  assert.match(m.keyRefusal("too_many", ""), /Remove one/);
  assert.equal(m.keyRefusal("bad_input", "the service refused that key"), "the service refused that key");
});

test("adding a key sends an API key through the key shortcut, and a setup token through the person's own vault key, then removes the key if the account is refused", { skip: !strip }, async () => {
  const { accountsSource } = await import("./accounts-source.ts");
  const a = box({ "sessions.accounts.key": { data: { id: "k1" } } });
  await accountsSource(a.call).addKey("openrouter", "  sk-or-fixture-0123456789  ", "work");
  assert.deepEqual(a.seen.map((s) => s.tool), ["sessions.accounts.key"]);
  assert.deepEqual(a.seen[0].input, { kind: "openrouter", key: "sk-or-fixture-0123456789", label: "work" });
  const b = box({ "vault.member.put": { data: { id: "mk_1", item: "member:mk_1" } }, "sessions.accounts.add": { data: { id: "a9" } } });
  await accountsSource(b.call).addKey("setup-token", "tok-fixture-0123456789");
  assert.deepEqual(b.seen.map((s) => s.tool), ["vault.member.put", "sessions.accounts.add"]);
  assert.equal(b.seen[1].input.vault_item, "member:mk_1");
  assert.equal(b.seen[1].input.kind, "setup-token");
  const c = box({ "vault.member.put": { data: { id: "mk_2", item: "member:mk_2" } }, "sessions.accounts.add": () => ({ error: { code: "denied", message: "no" } }) });
  await assert.rejects(() => accountsSource(c.call).addKey("setup-token", "tok-fixture-0123456789"));
  assert.deepEqual(c.seen.map((s) => s.tool), ["vault.member.put", "sessions.accounts.add", "vault.member.remove"], "a key whose account was refused is not left behind");
});
