// @ts-check
// A member's lent key on the two paths that carry a session away from the plain spawn: onto the person's own computer (lentSpawn) and into the runner's sandbox (sandboxSpawn). On neither does the key sit in
// a process environment: the lender is handed no credential variable and the home's key goes nowhere near it (the process there uses that computer's own sign-in); the sandbox spawner is handed none either, and
// the sandbox gives the session its sign-in on a pipe (descriptor 3), which is what runner/sandbox.js launch does with a plan's secret. The box's own fallback, when nothing could start on the computer, is the plain
// spawn: the key on fd 3, none in the environment. No claude binary: /bin/sh stands in, as in spawn-agent.test.js.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSession } from "./spawn.js";
import { lentSpawnFor } from "../../lib/lent-placement.js";
import { launch } from "../runner/sandbox.js";
import { ACCOUNT_ENV, CREDENTIAL_VARS } from "../../lib/credential-env.js";

const KEY = "sk-ant-oat01-lent-key-0123456789abcdef";
// every variable a provider's key can ride in (lib/credential-env.js, the list accountEnv and spawn.js both read), and the two that name a descriptor
const NAMES = [...CREDENTIAL_VARS, "CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR", "CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR"];
const env = () => ({ PATH: "/usr/bin:/bin", VYRE_API_BASE_URL: "https://api.example.test/v1", VYRE_API_MODEL: "m", ...Object.fromEntries(NAMES.map((n, i) => [n, `${KEY}-${i}`])) });
const one = () => ({ PATH: "/usr/bin:/bin", CLAUDE_CODE_OAUTH_TOKEN: KEY });   // a member's setup token: the one credential a launch holds
const collect = (/** @type {any} */ s) => new Promise(r => { let out = ""; s.setEncoding("utf8"); s.on("data", (/** @type {string} */ d) => (out += d)); s.on("end", () => r(out)); });
const SHOW = 'echo "env=${CLAUDE_CODE_OAUTH_TOKEN:-none} api=${ANTHROPIC_API_KEY:-none} fdvar=${CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR:-none} fd3=$(cat <&3)"';

test("every provider's key variable is withheld from lentSpawn and from sandboxSpawn: one list (lib/credential-env.js) is read by the Switchboard and by spawn.js", async () => {
  assert.deepEqual(Object.values(ACCOUNT_ENV).flatMap(o => Object.values(o)).filter(n => !CREDENTIAL_VARS.includes(n)), [], "a variable accountEnv can set is on the list spawn.js strips");
  for (const n of ["XAI_API_KEY", "OPENROUTER_API_KEY", "OPENAI_COMPAT_API_KEY", "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"]) assert.ok(CREDENTIAL_VARS.includes(n), n);
  /** @type {any[]} */ const lent = [], boxed = [];
  spawnSession("/bin/sh", ["-c", "true"], { env: env(), lentSpawn: (/** @type {string} */ _c, /** @type {string[]} */ _a, /** @type {any} */ e) => { lent.push(e); return { pid: 1, stdin: { on() {}, write() {}, end() {} }, stdout: null, stderr: null, on() {}, kill() {} }; } });
  spawnSession("/bin/sh", ["-c", "true"], { env: env(), sandboxSpawn: (/** @type {string} */ _c, /** @type {string[]} */ _a, /** @type {any} */ e) => { boxed.push(e); return { pid: 1 }; } });
  for (const seen of [lent[0], boxed[0]]) {
    assert.ok(seen, "the path was taken");
    for (const n of NAMES) assert.equal(n in seen, false, `${n} is withheld`);
    assert.ok(!JSON.stringify(seen).includes(KEY), "no key value anywhere");
    assert.equal(seen.VYRE_API_BASE_URL, "https://api.example.test/v1", "the endpoint and model are not secrets and stay");
    assert.equal(seen.VYRE_API_MODEL, "m");
  }
});

test("lentSpawn is handed an environment with no credential and none that names a descriptor; the key is in nothing the lender receives", async () => {
  /** @type {any[]} */ const seen = [];
  const lentSpawn = (/** @type {string} */ c, /** @type {string[]} */ a, /** @type {any} */ e) => { seen.push({ c, a, e }); return null; };   // null: nothing could start on the computer
  const child = spawnSession("/bin/sh", ["-c", SHOW], { env: one(), lentSpawn });
  const out = await collect(child.stdout);
  assert.equal(seen.length, 1, "the lender was asked");
  assert.equal(seen.length, 1);
  assert.ok(!JSON.stringify(seen).includes(KEY));
  // the box's fallback keeps the whole environment and moves the key onto fd 3, as every launch does
  assert.equal(out.trim(), `env=none api=none fdvar=3 fd3=${KEY}`, "absent from the environment, present on fd 3");
});

test("the placement the home builds for a chat on a person's computer sends the runner the command, arguments and person only: the key is in none of it", async () => {
  /** @type {any[]} */ const calls = [];
  const row = { where: "mac", session: "ses_native", chat: "chat_1", person: "per_bob" };
  const kernel = { runnerHost: () => ({ lentSpawn: (/** @type {string} */ space, /** @type {any} */ i) => { calls.push({ space, ...i }); return {}; }, placements: { spaces: () => ["spc_a"], find: (/** @type {string} */ _s, /** @type {string} */ id) => (id === "chat_1" ? row : null) } }) };
  const fn = await lentSpawnFor(kernel, { thread: "thr_1", chat: "chat_1", native: "ses_native", asker: "per_bob" });
  assert.ok(fn);
  fn?.("claude", ["--output-format", "stream-json"], env(), "/box/work", {});
  assert.equal(calls.length, 1);
  assert.ok(!JSON.stringify(calls).includes(KEY) && !JSON.stringify(calls).includes("TOKEN"), "nothing of the environment went to the runner");
});

test("sandboxSpawn is handed an environment with no credential and none that names a descriptor; the sandbox's own pipe is what carries the sign-in", async () => {
  /** @type {any[]} */ const seen = [];
  spawnSession("/bin/sh", ["-c", "true"], { env: env(), sandboxSpawn: (/** @type {string} */ c, /** @type {string[]} */ a, /** @type {any} */ e) => { seen.push(e); return { pid: 1 }; } });
  assert.equal(seen.length, 1);
  for (const n of NAMES) assert.equal(n in seen[0], false, `${n} is not handed to the sandbox spawner`);
  assert.ok(!JSON.stringify(seen).includes(KEY));
  // and the runner's launch gives a plan's secret to the process on descriptor 3 only, never in its environment
  const child = launch({ argv: ["/bin/sh", "-c", SHOW], env: { PATH: "/usr/bin:/bin" }, cwd: undefined, cleanup() {}, secret: { fd: 3, payload: KEY } }, {});
  const out = await collect(child.stdout);
  assert.equal(out.trim(), `env=none api=none fdvar=none fd3=${KEY}`, "absent from the environment, present on fd 3");
});
