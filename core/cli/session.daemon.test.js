// @ts-check
// The limited `vyre` of a session sandbox, on a real daemon: the real shim (bin/session/vyre) is run by a shell inside a session, on that session's own socket. It finds the send tool, a call to a
// send is held at the Gate (and the module never runs), a vault read through `vyre call` is refused, and a tool that is not listed is not there.
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { boot } from "../sessions/testing/boot.js";

const kit = (/** @type {string} */ ran) => ({ name: "kit", manifest: { name: "kit", version: "0.1.0", apiVersion: 1, description: "Notes for the session test.",
  does: { tools: [{ name: "kit.read", summary: "read a note" }, { name: "kit.mail", summary: "mail a note to a person", outward: "send" }] } },
  source: `
    import fs from "node:fs";
    export default { async start(ctx) {
      ctx.tool("kit.read", { callers: ["mcp"], input: { type: "object" }, run: async () => ({ note: "rye" }) });
      ctx.tool("kit.mail", { callers: ["mcp"], input: { type: "object", properties: { to: { type: "string" } } }, run: async input => { fs.appendFileSync(${JSON.stringify(ran)}, JSON.stringify(input) + "\\n"); return { sent: true }; } });
      return { async stop() {} };
    } };` });

/** Run one shell line of the session's `vyre` as a turn and read what the model would. */
async function turn(/** @type {any} */ w, /** @type {string} */ id, /** @type {string} */ line, /** @type {number} */ n) {
  await w.tool("threads.send", { thread: id, text: `vyre-cli ${line}`, surface: "deck" });
  await w.finished(id, n);
  return JSON.parse((await w.said(id)).at(-1));
}

test("vyre in a session: find returns the send tool, a call to it is held and never runs, a vault read and a hidden tool are refused", { timeout: 120_000 }, async t => {
  const ran = path.join(fs.mkdtempSync(path.join(process.env.TMPDIR || "/tmp", "sc-")), "ran.log");
  t.after(() => fs.rmSync(path.dirname(ran), { recursive: true, force: true }));
  const w = await boot(t, { driver: "cli", kernel: true, sessions: { thread_socket: "on" }, modules: [kit(ran)] });
  const th = (await w.tool("threads.start", { cwd: w.work, prompt: "vyre-cli tools find 'send an email'", surface: "deck" })).data;
  await w.finished(th.id);
  const found = JSON.parse((await w.said(th.id)).at(-1));
  assert.equal(found.status, 0, found.err);
  assert.match(found.out, /mail\.send/, "the send tool is found for words about sending");
  assert.match(found.out, /vyre call mail\.send '/);

  const described = await turn(w, th.id, "tools describe kit.mail", 2);
  assert.equal(described.status, 0, described.err);
  assert.match(described.out, /kit\.mail/);

  const sent = await turn(w, th.id, `call mail.send '{"to":"dana@example.com","subject":"s","body":"b"}'`, 3);
  assert.equal(sent.status, 1, "a held send is not a success");
  assert.match(sent.err, /held_for_approval: mail\.send .*Nothing ran/, "a send is held for the person's yes, and the model is told nothing ran");
  assert.doesNotMatch(sent.err, /ExperimentalWarning/, "no node noise in what the model reads");
  const outward = await turn(w, th.id, `call kit.mail '{"to":"dana@example.com"}'`, 4);
  assert.equal(outward.status, 1);
  assert.ok(!fs.existsSync(ran), "the module's send never ran");

  const read = await turn(w, th.id, "call kit.read '{}'", 5);
  assert.equal(read.status, 0, read.err);
  assert.match(read.out, /rye/);

  const vault = await turn(w, th.id, `call vault.reveal '{"name":"x"}'`, 6);
  assert.equal(vault.status, 1);
  assert.doesNotMatch(vault.out, /secret|value/i);
  const hidden = await turn(w, th.id, "call nope.thing '{}'", 7);
  assert.equal(hidden.status, 1);
  const bare = await turn(w, th.id, "vault get x", 8);
  assert.equal(bare.status, 2, "only tools and call exist");
});
