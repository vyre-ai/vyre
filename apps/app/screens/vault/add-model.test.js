import "../../../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { PROVIDERS } from "../../../../core/vault/providers.js";
import { GROUPS } from "./redesign.js";
import { entriesFor, searchEntries, pickerGroups, formOf, problemsOf, callOf, unplaced, startName, slugOf, NAME_RE, IMPORT_ENTRY } from "./add-model.js";

const SA = JSON.stringify({ type: "service_account", client_email: "bot@proj.iam.gserviceaccount.com", private_key: "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\n" });

test("every provider in the catalog has a row and a group, so a new provider cannot be left out of the picker", () => {
  assert.deepEqual(unplaced(), []);
  const ids = entriesFor("space").map((e) => e.id);
  for (const n of Object.keys(PROVIDERS)) assert.ok(ids.includes(n), n);
});

test("the picker groups are the list's groups, in its order, with Import last", () => {
  const names = pickerGroups(entriesFor("space")).map((g) => g.name);
  assert.deepEqual(names, [...GROUPS, "Import"]);
  assert.deepEqual(pickerGroups(entriesFor("space")).find((g) => g.name === "AI models").items.map((e) => e.id), ["anthropic", "claude-setup-token", "openai", "deepgram", "elevenlabs"]);
});

test("every row says what it can do in one line and has an icon", () => {
  for (const e of entriesFor("space")) { assert.ok(e.blurb.length > 10 && e.blurb.length < 90, e.id); assert.ok(e.icon, e.id); assert.ok(!/[—§]/.test(e.blurb + e.label), e.id); }
});

test("Mine has no sign-in flows, no SSH keys and no import", () => {
  const ids = entriesFor("mine").map((e) => e.id);
  assert.ok(!ids.includes("github-oauth") && !ids.includes("google-oauth") && !ids.includes("ssh") && !ids.includes("import"));
  assert.ok(ids.includes("twilio") && ids.includes("login") && ids.includes("note"));
});

test("search matches the name, the line and the words people use", () => {
  const all = entriesFor("space");
  assert.deepEqual(searchEntries(all, "mailgun").map((e) => e.id), ["sending-service"]);
  assert.ok(searchEntries(all, "text sms").some((e) => e.id === "twilio"));
  assert.ok(searchEntries(all, "password").some((e) => e.id === "login"));
  assert.equal(searchEntries(all, "").length, all.length);
  assert.deepEqual(searchEntries(all, "zzzz"), []);
});

test("a pick starts with a lowercase name the vault accepts", () => {
  for (const e of entriesFor("space")) if (startName(e)) assert.ok(NAME_RE.test(startName(e)) && startName(e) === startName(e).toLowerCase(), e.id);
  assert.equal(startName(entriesFor().find((e) => e.id === "google-dwd")), "google-service-account");
  assert.equal(slugOf("Juniper Drive!"), "Juniper-Drive");
});

test("a provider's form has the catalog's own fields and labels, in its console's order, optional ones last and labelled", () => {
  const f = formOf("twilio");
  assert.equal(f.how, "field");
  assert.deepEqual(f.fields.map((x) => x.name), ["account", "value", "from", "sid", "service"]);
  assert.equal(f.fields[1].secret, true); assert.equal(f.fields[1].label, "Auth token");
  assert.equal(f.fields[0].label, "Account number (starts with AC)");
  assert.match(f.fields[3].label, /^API key id \(optional, only if/);
  assert.match(f.fields[4].label, /^Messaging service id \(optional, instead/);
  assert.equal(f.help, "https://console.twilio.com/");
  const e = formOf("sending-service").fields.map((x) => x.name);
  assert.deepEqual(e.slice(0, 3), ["service", "api_key", "from"]);
  assert.match(formOf("sending-service").fields.find((x) => x.name === "domain").label, /\(optional/);
});

test("a provider with a file shows a drop zone for the JSON, and its other fields", () => {
  const f = formOf("google-dwd");
  assert.equal(f.how, "file"); assert.equal(f.file.name, "json");
  assert.deepEqual(f.fields.map((x) => x.name), ["subject", "scopes"]);
  assert.deepEqual(Object.keys(problemsOf(f, "google-service-account", { subject: "a@b.co" }, "")), ["json"]);
  assert.match(problemsOf(f, "g", { subject: "a@b.co" }, "{not json").json, /not JSON/);
  assert.deepEqual(problemsOf(f, "g", { subject: "a@b.co" }, SA), {});
});

test("a provider with a sign-in has no fields, a Sign in button, and no call to make", () => {
  const f = formOf("github-oauth");
  assert.equal(f.how, "oauth"); assert.deepEqual(f.fields, []); assert.equal(f.signIn, "GitHub");
  assert.equal(callOf(f, "github", {}), null);
  assert.equal(formOf("google-oauth").signIn, "Google");
});

test("Save calls vault.put with the kind and fields the catalog says, and the provider as a detail", () => {
  const f = formOf("twilio");
  const c = callOf(f, "twilio", { value: "a".repeat(32), from: "+14155550140" });
  assert.equal(c.tool, "vault.put");
  assert.deepEqual(c.input, { name: "twilio", kind: "api-key", fields: { value: "a".repeat(32), from: "+14155550140" }, details: { provider: "twilio" } });
  const g = callOf(formOf("google-dwd"), "g", { subject: "a@b.co" }, { file: SA });
  assert.equal(g.input.kind, "cloud"); assert.equal(g.input.fields.json, SA); assert.equal(g.input.fields.subject, "a@b.co");
  assert.equal(callOf(formOf("claude-setup-token"), "claude-setup-token", { token: "sk-ant-oat01-" + "a".repeat(30) }).input.kind, "oauth");
});

test("in Mine it is vault.me.put with no details", () => {
  const c = callOf(formOf("anthropic"), "anthropic", { value: "sk-ant-api03-" + "a".repeat(30) }, { scope: "mine" });
  assert.equal(c.tool, "vault.me.put"); assert.equal(c.input.details, undefined);
});

test("a wrong key says which field and never quotes the value", () => {
  const p = problemsOf(formOf("openai"), "openai", { value: "hunter2-secret-value" });
  assert.match(p.value, /does not look right for OpenAI/);
  assert.ok(!JSON.stringify(p).includes("hunter2"));
  assert.match(callOf(formOf("openai"), "openai", { value: "nope" }).error, /OpenAI/);
});

test("required fields are named, optional ones are not", () => {
  const p = problemsOf(formOf("twilio"), "twilio", {});
  assert.deepEqual(Object.keys(p), ["value"]);
  assert.equal(p.value, "Auth token is needed.");
  assert.equal(problemsOf(formOf("login"), "", {}).name, "Give it a name.");
  assert.match(problemsOf(formOf("api-key"), "bad name", { value: "x" }).name, /letters, digits/);
});

test("a website login: address, username, password and the one-time code secret", () => {
  const f = formOf("login");
  assert.deepEqual(f.fields.map((x) => x.name), ["url", "username", "password", "totp"]);
  const c = callOf(f, "gmail", { url: "https://mail.example.com/inbox", username: "a", password: "p", totp: "JBSWY3DP" });
  assert.deepEqual(c.input, { name: "gmail", kind: "login", fields: { username: "a", password: "p", totp: "JBSWY3DP" }, url: "https://mail.example.com/inbox", hosts: ["mail.example.com"] });
  assert.equal(problemsOf(f, "x", { url: "not a site", username: "a", password: "p" }).url, "That is not a web address.");
  assert.deepEqual(Object.keys(problemsOf(f, "x", { username: "a" })), ["password"]);
});

test("a note and a generic key put their one value", () => {
  assert.deepEqual(callOf(formOf("note"), "wifi", { value: "line one\nline two" }).input, { name: "wifi", kind: "note", fields: { value: "line one\nline two" } });
  assert.deepEqual(callOf(formOf("api-key"), "stripe", { value: "rk_live_x" }).input, { name: "stripe", kind: "api-key", fields: { value: "rk_live_x" } });
});

test("an SSH key is made on the server, or an existing key file on the server is added", () => {
  const f = formOf("ssh");
  assert.deepEqual(callOf(f, "deploy-key", {}, { description: "for CI" }), { tool: "vault.ssh.generate", input: { name: "deploy-key", description: "for CI" } });
  assert.deepEqual(callOf(f, "nas", {}, { sshMode: "existing", sshFile: " /home/me/.ssh/id_ed25519 " }), { tool: "vault.ssh.add", input: { name: "nas", file: "/home/me/.ssh/id_ed25519" } });
  assert.match(callOf(f, "nas", {}, { sshMode: "existing" }).error, /where the key file is/);
});

test("the import row opens the import screen, with no call", () => {
  assert.equal(formOf(IMPORT_ENTRY.id).how, "import");
  assert.equal(callOf(formOf("import"), "x", {}), null);
});
