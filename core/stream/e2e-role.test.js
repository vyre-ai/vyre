// @ts-check
// Step 7 role limits on a REAL vyred process with two real members (alex the owner, carol a member; presence is the test verifier `kernelPresence`, which accepts any proof for a grants act: a stand-in, said
// plainly in team/0.3/E2E-RUN.md): a turn belongs to its asker for its whole run. carol's turn is running when alex speaks: alex's message is queued as the NEXT turn, never steers carol's,
// the kernel still holds carol's open turn while hers runs (it is not swapped for alex's), and alex's turn then runs as alex. Skipped unless VYRE_E2E=1 (see e2e-step7.test.js for how to run).
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { tempHome } from "../../test/helpers.js";
import { SCRATCH } from "../../test/scratch.mjs";
import { FAKE } from "../sessions/testing/boot.js";
import { connect, wsDuplex } from "./client.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const sleep = (/** @type {number} */ ms) => new Promise(r => setTimeout(r, ms));
const until = async (/** @type {() => any} */ f, /** @type {string} */ what, ms = 30_000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await f()) return; await sleep(20); } throw new Error(`timed out waiting for ${what}`); };
const textOf = (/** @type {any[]} */ frames) => frames.filter(f => f.type === "session.text-delta" && !f.data.reasoning).map(f => f.data.text).join("");
const LONG = (/** @type {string} */ tag) => `${tag} ` + Array(400).fill("word").join(" ");

test("carol's paired device, admitted as a member, reaches her chat and nothing outside her role", { skip: (process.env.VYRE_E2E !== "1" && "set VYRE_E2E=1 on the test box") || false, timeout: 120_000 }, async t => {
  const home = tempHome(t);
  const env = { ...process.env, VYRE_HOME: home, VYRE_KERNEL: "1", VYRE_SEAL_DEV: "1", VYRE_KERNEL_PATH_RULE: "1", VYRE_SESSION_SANDBOX_OFF: "1", VYRE_TEST_HOST: "testbox",
    VYRE_CLAUDE_BIN: FAKE, VYRE_SESSIONS_DRIVER: "cli", VYRE_SESSIONS_SPAWNER: "off", VYRE_SESSIONS_THREAD_SOCKET: "on", VYRE_NO_DIALOGS: "1" };
  delete env.NODE_TEST_CONTEXT;
  fs.mkdirSync(path.join(home, "logs"), { recursive: true });
  const fd = fs.openSync(path.join(home, "logs", "e2e-role.log"), "a");
  const child = spawn(process.execPath, [path.join(HERE, "e2e-step7-vyred.js")], { detached: true, stdio: ["ignore", fd, fd], env });
  t.after(() => { try { process.kill(-/** @type {number} */ (child.pid), "SIGKILL"); } catch { /* gone */ } });
  await until(() => fs.existsSync(path.join(home, "e2e-harness.json")) || child.exitCode !== null, "vyred's harness", 60_000);
  const h = JSON.parse(fs.readFileSync(path.join(home, "e2e-harness.json"), "utf8"));
  const base = `http://127.0.0.1:${h.port}`;
  const post = async (/** @type {string} */ p, /** @type {any} */ b) => (await fetch(base + p, { method: "POST", body: JSON.stringify(b || {}) })).json();
  const info = await (await fetch(base + "/info")).json();
  const call = (/** @type {string} */ who, /** @type {string} */ tool, /** @type {any} */ input) => post("/call", { who, tool, input });
  assert.ok((await post("/add-carol")).ok, "carol is a member and in the chat");
  // what her role gives her: her chat opens for her device
  const mine = await call("carol", "stream.open", { session: info.chat, from: 0 });
  assert.ok(!mine.error, `carol opens her chat: ${JSON.stringify(mine.error)}`);
  // what it does not: the owner's and admin's acts, each refused to her with the product's own code. The owner's same call is the control: it is not refused as malformed (bad_input), so the
  // refusal of carol's is her role's, not the input's.
  const space = (await call("alex", "records.me", {})).data.space;
  const type = { diff: { add_types: [{ name: "plant", label: "Plant", fields: [{ name: "name", kind: "text", label: "Name" }] }] } };
  const outside = [
    ["records.define", type],
    ["spaces.members.set-role", { space, person: info.alex, role: "member" }],
    ["spaces.invites.create", { space, role: "member" }],
    ["tasks.decide", { id: "no-such-task", outcome: "approved" }],
  ];
  for (const [tool, input] of outside) {
    const r = await call("carol", tool, input);
    const own = await call("alex", tool, input);
    console.log("ROLE " + tool + ": carol -> " + (r.error ? r.error.code + " (" + String(r.error.message).slice(0, 70) + ")" : "NO ERROR") + " | alex -> " + (own.error ? own.error.code : "ok"));
    assert.ok(r.error, `${tool} is refused to a member's device`);
    assert.notEqual(r.error.code, "harness", `${tool} was refused by the product, not by a crash of the harness`);
    assert.notEqual(own.error && own.error.code, "bad_input", `${tool}: the owner's control call is well formed`);
  }
  // and nobody else's chat: a chat of alex's alone is not hers
  const other = await call("carol", "stream.open", { session: "chat_no_such", from: 0 });
  assert.ok(other.error, "carol cannot open a chat she is not in");
});
