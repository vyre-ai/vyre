import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { ACCOUNTS_COPY, NO_SIGNIN, PROVIDERS, copyWords, defaultLabel, keyKindOf, keyShapeOk, labelProblem, pasteOk, signinInput, signinMode } from "./ai-accounts-model.js";

test("the providers are the ones the server can sign in to, from the one list", () => {
  assert.deepEqual([...PROVIDERS], ["claude", "codex", "grok"]);
});

test("an account is named after its provider until that name is taken, then numbered", () => {
  assert.equal(defaultLabel("Claude", []), "Claude");
  assert.equal(defaultLabel("Claude", ["Claude"]), "Claude 2");
  assert.equal(defaultLabel("Claude", ["claude", "Claude 2"]), "Claude 3");
  assert.equal(defaultLabel("Codex", ["Claude"]), "Codex");
});

test("a name must be there, one line, at most 80 characters, and not used twice", () => {
  assert.equal(labelProblem("Work", []), "");
  assert.notEqual(labelProblem("  ", []), "");
  assert.notEqual(labelProblem("a".repeat(81), []), "");
  assert.notEqual(labelProblem("a\nb", []), "");
  assert.notEqual(labelProblem("work", ["Work"]), "");
  assert.equal(labelProblem("Personal", ["Work"]), "");
});

test("a key's prefix says what it is, and anything else says nothing", () => {
  assert.deepEqual(keyKindOf("sk-ant-api03-abc"), { kind: "anthropic-compatible", provider: "claude", label: "Claude key" });
  assert.equal(keyKindOf("sk-or-v1-abc").kind, "openrouter");
  assert.equal(keyKindOf("sk-proj-abc").provider, "codex");
  assert.equal(keyKindOf("sk-abc").kind, "openai-compatible");
  const x = keyKindOf("  XAI-abc ");
  assert.deepEqual([x.provider, x.kind, x.base_url], ["grok", "openai-compatible", "https://api.x.ai/v1"]);
  assert.equal(keyKindOf("hello"), null);
  assert.equal(keyKindOf(""), null);
});

test("a key's shape: 12 to 400 characters without spaces or control characters", () => {
  assert.equal(keyShapeOk("sk-ant-123456789"), true);
  assert.equal(keyShapeOk("short"), false);
  assert.equal(keyShapeOk("sk-ant-with space1234"), false);
  assert.equal(keyShapeOk("a".repeat(401)), false);
});

test("the copy sheet names where from and where to, and counts the confirmations up front: one read per key plus one for the set", () => {
  const w = copyWords({ from: "Juniper Studio", to: "Ivy Labs", count: 3 });
  assert.match(w.lead, /Juniper Studio to Ivy Labs/);
  assert.equal(w.confirm, "You'll confirm 4 times: once to read each of the 3 keys from Juniper Studio, and once to add them to Ivy Labs.");
  assert.match(copyWords({ from: "A", to: "B", count: 1 }).confirm, /confirm 2 times: once to read the key from A, and once to add it to B/);
  assert.equal(copyWords({ from: "A", to: "B", count: 0 }).confirm, "Nothing to confirm.");
  assert.equal(copyWords({ from: "A", to: "B", count: 1 }).button(1), "Copy 1 account");
});

// Fake keys are built from parts so no literal in this file looks like a real key to the secret scan.
test("an Anthropic prefix is never an OpenAI-style key, whatever follows it", () => {
  const a = "sk-" + "ant-", tail = "x".repeat(30);
  const claude = { kind: "anthropic-compatible", provider: "claude", label: "Claude key" };
  assert.deepEqual(keyKindOf(a + "api03-" + tail + "."), claude, "a trailing odd character");
  assert.deepEqual(keyKindOf(a.toUpperCase() + "API03-" + tail), claude, "upper case");
  assert.deepEqual(keyKindOf(a + "oat01-" + tail), claude, "a setup token");
  assert.equal(keyKindOf("sk-" + "proj-" + tail).provider, "codex");
  assert.equal(keyKindOf("sk-" + "or-v1-" + tail).kind, "openrouter");
  const x = keyKindOf("xai-" + tail);
  assert.deepEqual([x.provider, x.base_url], ["grok", "https://api.x.ai/v1"]);
  for (const rest of ["", "a", "-", "_", ".", " x", "é", "0", "oat01-", "api03-" + tail + "\n", tail + "!"]) {
    const k = keyKindOf(a + rest);
    assert.ok(k && k.kind === "anthropic-compatible", JSON.stringify(rest));
  }
});

test("a sign-in whose page shows a code asks for it; the code the home shows is never sent back as the person's", () => {
  assert.equal(signinMode("", ""), "start");
  assert.equal(signinMode("f1", "url"), "paste", "the home answered step url: the person pastes the page's code");
  assert.equal(signinMode("f1", "waiting"), "wait");
  assert.equal(signinMode("f1", "waiting", true), "paste", "the home says paste: true (core/sessions/signin.js status), whatever the step word");
  assert.equal(signinMode("f1", "code"), "wait", "a provider that shows its own code to type there needs only the check");
  // starting: no flow, no code
  assert.deepEqual(signinInput({ provider: "claude", label: " Claude ", flow: "", step: "", pasted: "" }), { provider: "claude", label: "Claude" });
  // pasting: the flow and the pasted code, trimmed
  assert.deepEqual(signinInput({ provider: "claude", label: "Claude", flow: "f1", step: "url", pasted: "  abc#def  " }), { provider: "claude", label: "Claude", flow: "f1", code: "abc#def" });
  assert.deepEqual(signinInput({ provider: "claude", label: "Claude", flow: "f1", step: "waiting", paste: true, pasted: "abc#def" }), { provider: "claude", label: "Claude", flow: "f1", code: "abc#def" });
  // waiting (I signed in): the flow only, whatever is in the field
  assert.deepEqual(signinInput({ provider: "codex", label: "Codex", flow: "f2", step: "waiting", pasted: "stale" }), { provider: "codex", label: "Codex", flow: "f2" });
  assert.equal(pasteOk(""), false);
  assert.equal(pasteOk("   "), false);
  assert.equal(pasteOk("abc#def"), true);
  assert.equal(pasteOk("x".repeat(201)), false);
  assert.equal(pasteOk("a\nb"), false);
  assert.equal(ACCOUNTS_COPY.pasteLabel, "The code the page showed");
});

test("Cancel leaves no flow, link, code, step or pasted text, so the tiles are enabled again", () => {
  assert.deepEqual({ ...NO_SIGNIN }, { flow: "", url: "", code: "", step: "", pasted: "", paste: false });
  assert.equal(signinMode(NO_SIGNIN.flow, NO_SIGNIN.step), "start");
  assert.equal(ACCOUNTS_COPY.cancel, "Cancel");
});

test("FirstRun disables the tiles only while a flow is set, shows the paste field in paste mode, and Cancel clears it", async () => {
  const fs = await import("node:fs");
  const src = fs.readFileSync(new URL("./FirstRun.tsx", import.meta.url), "utf8");
  assert.match(src, /signinMode\(agentFlow, agentStep\) === "paste" \? \(\s*<Field label=\{ACCOUNTS_COPY\.pasteLabel\}/);
  assert.match(src, /label=\{ACCOUNTS_COPY\.cancel\}[^\n]*setAgentFlow\(NO_SIGNIN\.flow\)/);
  assert.match(src, /signInAgent\(signinInput\(/);
  assert.ok(!/\.\.\.\(agentCode \? \{ code: agentCode \}/.test(src), "the home's own code is no longer sent as the person's");
});

test("the answer the server gives for Claude shows the paste field: step url with paste true, and the host passes both through", async () => {
  const fs = await import("node:fs");
  const signin = fs.readFileSync(new URL("../../../../core/sessions/signin.js", import.meta.url), "utf8");
  assert.match(signin, /claude: \{ bin: "claude", args: \["auth", "login"\], wantsPaste: true \}/);
  assert.match(signin, /step: f\.wantsPaste && !f\.code \? "url" : "code"[^\n]*\.\.\.\(f\.wantsPaste \? \{ paste: true \} : \{\}\)/);
  const host = fs.readFileSync(new URL("../../src/host/host-core.js", import.meta.url), "utf8");
  assert.match(host, /for \(const key of \["flow", "step", "state", "status", "url", "code", "paste",/);
  // that answer, as the screen reads it
  assert.equal(signinMode("f1", "url", true), "paste");
});
