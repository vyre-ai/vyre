// @ts-check
// The inference door's sign-in drivers against fake CLIs (testing/fake-signin.js): each runs one turn of the provider's CLI on the ONE account it was handed, with that account's credential in its own
// child only, no tools, no MCP, a fresh folder, a time limit, a per-account cap, one more ask when a step's answer does not read, and plain words when the sign-in is gone. Tokens here are fakes.

import "../../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { signinDoorDrivers, accountGate, plainFailure } from "./signin-door.js";
import { jsonAnswer, labelAnswer, answerReads } from "../../../lib/model-answer.js";

const FAKE = fileURLToPath(new URL("../testing/fake-signin.js", import.meta.url));
const sha = (/** @type {string} */ v) => crypto.createHash("sha256").update(v).digest("hex");
const BEN_TOKEN = "sk-ant-oat01-" + "b".repeat(60), OWNER_TOKEN = "sk-ant-oat01-" + "a".repeat(60);
const EXPIRED_WORDS = "Your Claude sign-in has expired. Sign in again in Settings, AI accounts.";

function world(t, o = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "signin-door-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const logFile = path.join(dir, "log.jsonl");
  const tmp = path.join(dir, "tmp"); fs.mkdirSync(tmp);
  const saved = process.env.FAKE_SIGNIN_LOG; process.env.FAKE_SIGNIN_LOG = logFile;
  t.after(() => { if (saved === undefined) delete process.env.FAKE_SIGNIN_LOG; else process.env.FAKE_SIGNIN_LOG = saved; });
  const d = signinDoorDrivers({ bins: { claude: FAKE, codex: FAKE, grok: FAKE }, spawner: () => false, tmp, ...o });
  const log = () => (fs.existsSync(logFile) ? fs.readFileSync(logFile, "utf8").trim().split("\n").filter(Boolean).map(l => JSON.parse(l)) : []);
  return { d, dir, tmp, log };
}
const acct = (/** @type {string} */ provider, /** @type {string} */ kind, extra = {}) => ({ id: `acc-${provider}-${kind}`, provider, kind, label: `Ben's ${provider}`, person: "per_ben", ...extra });
const classify = (/** @type {string} */ text) => ({ messages: [{ role: "system", content: "Answer with exactly one of: refund, other. Nothing else." }, { role: "user", content: text }], expect: { kind: "label", labels: ["refund", "other"] }, model: "default" });
const extract = (/** @type {string} */ text) => ({ messages: [{ role: "system", content: "Read the user's text and answer with ONE JSON object and nothing else. name (text)\namount (number)" }, { role: "user", content: text }], expect: { kind: "json" }, model: "default" });

test("the runner's reading of an answer is one function", () => {
  assert.deepEqual(jsonAnswer('```json\n{"a":1}\n```'), { a: 1 });
  assert.equal(jsonAnswer("Sure! {\"a\":1}"), null);
  assert.equal(jsonAnswer("[1]"), null);
  assert.equal(labelAnswer(" refund\n", ["refund", "other"]), "refund");
  assert.equal(labelAnswer("Refund.", ["refund", "other"]), null);
  assert.equal(answerReads("anything", undefined), true);
});

test("Claude: a classify step runs on HER setup token, in her child only, with no tools, no MCP and nothing kept", async t => {
  const w = world(t);
  const before = JSON.stringify(process.env);
  const r = await w.d.claude.call({ ...classify("MARK-c1 LABEL=refund I want my money back"), credential: { account: acct("claude", "setup-token"), env: { CLAUDE_CODE_OAUTH_TOKEN: BEN_TOKEN } } });
  assert.equal(r.content, "refund");
  assert.deepEqual(r.usage, { input_tokens: 6, output_tokens: 2 }, "a subscription spends no dollars");
  const [l] = w.log().filter(x => x.marker === "MARK-c1");
  assert.equal(l.got, sha(BEN_TOKEN), "her token reached the child");
  assert.notEqual(l.got, sha(OWNER_TOKEN));
  assert.equal(l.via, "CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR", "on descriptor 3, as a chat's is");
  assert.equal(l.env_holds, false, "no variable of the child's environment holds it");
  assert.ok(!l.env.includes("ANTHROPIC_API_KEY") && !l.env.includes("CLAUDE_CODE_OAUTH_TOKEN"), "no other credential variable rides along");
  assert.ok(l.no_tools && l.strict_mcp && l.no_persist, "no tools, no MCP but none, no session kept");
  assert.ok(l.home.startsWith(w.tmp) && l.home !== os.homedir(), "a HOME of its own: nobody's stored login is in reach");
  assert.ok(fs.realpathSync(path.dirname(l.home)) === fs.realpathSync(l.cwd), "a fresh folder to work in");
  assert.equal(JSON.stringify(process.env), before, "vyred's own environment never held it");
  assert.ok(!JSON.stringify(process.env).includes(BEN_TOKEN));
  assert.deepEqual(fs.readdirSync(w.tmp), [], "the folder is gone after the call");
});

test("Claude: an answer that does not read is asked for once more, and only once", async t => {
  const w = world(t);
  const cred = { account: acct("claude", "setup-token"), env: { CLAUDE_CODE_OAUTH_TOKEN: BEN_TOKEN } };
  const ok = await w.d.claude.call({ ...extract("MARK-j1 BADJSON-ONCE Ada owes 42"), credential: cred });
  assert.deepEqual(JSON.parse(ok.content), { name: "Ada", amount: 42 }, "the second answer reads");
  assert.equal(w.log().filter(x => x.marker === "MARK-j1").length, 2, "two launches");
  assert.deepEqual(ok.usage, { input_tokens: 12, output_tokens: 4 }, "both counted");
  const bad = await w.d.claude.call({ ...extract("MARK-j2 BADJSON-ALWAYS"), credential: cred });
  assert.equal(jsonAnswer(bad.content), null, "the runner gets the answer as it is and marks it unread");
  assert.equal(w.log().filter(x => x.marker === "MARK-j2").length, 2, "never a third");
  const good = await w.d.claude.call({ ...extract("MARK-j3 Ada owes 42"), credential: cred });
  assert.ok(jsonAnswer(good.content));
  assert.equal(w.log().filter(x => x.marker === "MARK-j3").length, 1, "an answer that reads is not asked again");
});

test("an expired sign-in, a refused key, a missing CLI and a slow one are said in plain words, with nothing else tried", async t => {
  const w = world(t, { timeoutMs: 1500 });
  const tokenCall = (/** @type {string} */ text, kind = "setup-token") => w.d.claude.call({ ...classify(text), credential: { account: acct("claude", kind), env: kind === "api-key" ? { ANTHROPIC_API_KEY: "sk-ant-api03-" + "x".repeat(40) } : { CLAUDE_CODE_OAUTH_TOKEN: BEN_TOKEN } } });
  await assert.rejects(tokenCall("MARK-e1 EXPIRED"), (e) => { assert.equal(/** @type {any} */ (e).code, "signin_expired"); assert.equal(/** @type {any} */ (e).message, EXPIRED_WORDS); return true; });
  await assert.rejects(tokenCall("MARK-e2 EXPIRED", "api-key"), /Your Claude key was refused\. Add it again in Settings, AI accounts\./);
  assert.equal(w.log().filter(x => x.marker === "MARK-e1").length, 1, "one launch: an expired sign-in is not asked again");
  await assert.rejects(tokenCall("MARK-e3 SLOW"), (e) => { assert.equal(/** @type {any} */ (e).code, "timeout"); assert.match(String(/** @type {any} */ (e).message), /^Your Claude account took longer than 2 seconds to answer, so this step stopped\. Nothing else was tried\.$/); return true; });
  const none = signinDoorDrivers({ bins: { claude: path.join(w.dir, "no-such-claude") }, spawner: () => false, tmp: w.tmp });
  await assert.rejects(none.claude.call({ ...classify("x"), credential: { account: acct("claude", "setup-token"), env: { CLAUDE_CODE_OAUTH_TOKEN: BEN_TOKEN } } }), (e) => /** @type {any} */ (e).code === "unavailable" && /Claude is not installed on this computer/.test(String(/** @type {any} */ (e).message)));
  // the words never carry what the CLI printed, nor the token
  for (const said of ["401 " + BEN_TOKEN, "rate limit for " + BEN_TOKEN, "weird " + BEN_TOKEN]) assert.ok(!plainFailure("claude", { kind: "setup-token" }, { said, exit: 1 }).message.includes(BEN_TOKEN));
  assert.equal(plainFailure("codex", { kind: "login" }, { said: "429 Too Many Requests", exit: 1 }).code, "rate_limited");
});

test("no account, another provider's account, or a key account with no key: nothing runs and nothing else is tried", async t => {
  const w = world(t);
  await assert.rejects(w.d.claude.call({ ...classify("MARK-n1"), credential: { account: acct("codex", "login"), env: {} } }), (e) => /** @type {any} */ (e).code === "bad_input");
  await assert.rejects(w.d.claude.call({ ...classify("MARK-n2"), credential: { account: acct("claude", "setup-token"), env: {} } }), (e) => /** @type {any} */ (e).code === "no_credential");
  await assert.rejects(w.d.claude.call({ ...classify("MARK-n3") }), (e) => /** @type {any} */ (e).code === "bad_input");
  // a member's Claude login is never run in this computer user's own folder (the home's own login)
  await assert.rejects(w.d.claude.call({ ...classify("MARK-n4"), credential: { account: acct("claude", "login"), env: {}, home: null } }), (e) => /** @type {any} */ (e).code === "no_credential");
  assert.equal(w.log().length, 0, "no CLI was started");
});

test("at most two calls of one account run at once; another account is not held up", async () => {
  const g = accountGate(2);
  let now = 0, most = 0;
  const job = () => g.run("a", "claude", async () => { now++; most = Math.max(most, now); await new Promise(r => setTimeout(r, 40)); now--; return 1; });
  const jobs = [job(), job(), job(), job(), job()];
  const other = g.run("b", "claude", async () => g.running("a"));
  const all = await Promise.all([...jobs, other]);
  assert.equal(most, 2);
  assert.equal(all[5], 2, "account b ran while a was full");
  assert.equal(g.running("a"), 0);
});

test("Codex: a login runs with its own CODEX_HOME, a key in its own child's environment, read-only, no MCP, no shell, the prompt on stdin", async t => {
  const w = world(t);
  const home = path.join(w.dir, "acct-codex"); fs.mkdirSync(path.join(home, ".codex"), { recursive: true });
  fs.writeFileSync(path.join(home, ".codex", "auth.json"), "codex-login-token-ben");
  const r = await w.d.codex.call({ ...classify("MARK-x1 LABEL=other a question"), credential: { account: acct("codex", "login"), env: {}, home } });
  assert.equal(r.content, "other");
  assert.deepEqual(r.usage, { input_tokens: 9, output_tokens: 4 });
  const [l] = w.log().filter(x => x.marker === "MARK-x1");
  assert.equal(l.got, sha("codex-login-token-ben"), "her own login");
  assert.equal(l.codex_home, path.join(home, ".codex"));
  assert.equal(l.sandbox, "read-only");
  assert.ok(l.configs.includes("mcp_servers={}") && l.configs.includes("features.shell_tool=false"), JSON.stringify(l.configs));
  assert.equal(l.stdin_prompt, true, "the prompt is never in the arguments");
  assert.ok(!l.env.includes("OPENAI_API_KEY"), "a login carries no key");
  const key = "sk-proj-" + "k".repeat(40);
  const k = await w.d.codex.call({ ...extract("MARK-x2 BADJSON-ONCE"), credential: { account: acct("codex", "api-key"), env: { OPENAI_API_KEY: key } } });
  assert.deepEqual(JSON.parse(k.content), { name: "Ada", amount: 42 }, "asked once more, then read");
  const ks = w.log().filter(x => x.marker === "MARK-x2");
  assert.equal(ks.length, 2);
  assert.equal(ks[0].got, sha(key));
  assert.ok(ks[0].home.startsWith(w.tmp), "a key gets an empty HOME of its own");
  assert.ok(!JSON.stringify(process.env).includes(key));
  fs.writeFileSync(path.join(home, ".codex", "auth.json"), "expired");
  await assert.rejects(w.d.codex.call({ ...classify("MARK-x3"), credential: { account: acct("codex", "login"), env: {}, home } }), /^Error: Your Codex sign-in has expired\. Sign in again in Settings, AI accounts\.$/);
});

test("Grok: ACP with no files, terminals or MCP; a login by its HOME, a key by xai.api_key; a tool is never allowed; an expired login in plain words", async t => {
  const w = world(t);
  const home = path.join(w.dir, "acct-grok"); fs.mkdirSync(path.join(home, ".grok"), { recursive: true });
  fs.writeFileSync(path.join(home, ".grok", "auth.json"), "grok-login-ben");
  const r = await w.d.grok.call({ ...classify("MARK-g1 TOOLTRY LABEL=refund"), credential: { account: acct("grok", "login"), env: {}, home } });
  assert.equal(r.content, "refund");
  assert.deepEqual(r.usage, { input_tokens: 7, output_tokens: 3 });
  const l = w.log();
  const prompt = l.find(x => x.marker === "MARK-g1"), opened = l.find(x => x.phase === "new");
  assert.equal(prompt.got, sha("grok-login-ben"));
  assert.equal(prompt.home, home);
  assert.deepEqual(prompt.permission, { outcome: { outcome: "cancelled" } }, "the permission question is answered cancelled");
  assert.deepEqual(opened.mcp_servers, [], "no MCP server");
  assert.deepEqual(opened.caps, { fs: { readTextFile: false, writeTextFile: false }, terminal: false }, "no files, no terminal");
  assert.ok(prompt.env.includes("GROK_CLAUDE_MCPS_ENABLED") && !prompt.env.includes("XAI_API_KEY"));
  const key = "xai-" + "q".repeat(40);
  const k = await w.d.grok.call({ ...extract("MARK-g2 BADJSON-ONCE"), credential: { account: acct("grok", "api-key"), env: { XAI_API_KEY: key } } });
  assert.deepEqual(JSON.parse(k.content), { name: "Ada", amount: 42 });
  assert.deepEqual(w.log().filter(x => x.marker === "MARK-g2").map(x => x.got), [sha(key), sha(key)]);
  fs.writeFileSync(path.join(home, ".grok", "auth.json"), "expired");
  await assert.rejects(w.d.grok.call({ ...classify("MARK-g3"), credential: { account: acct("grok", "login"), env: {}, home } }), (e) => /** @type {any} */ (e).code === "signin_expired" && /** @type {any} */ (e).message === "Your Grok sign-in has expired. Sign in again in Settings, AI accounts.");
});
