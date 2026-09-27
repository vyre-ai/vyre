// @ts-check
// `vyre vault` and `vyre memory` writes against the REAL presence verifier (no test fixture that
// finds a person at every call). Without a terminal they are refused asking for a person at a
// terminal, which is callAsPerson's answer, so the commands do route through it. With the proof
// (the code vyred writes to the person's login terminal, typed back) they go through.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { start } from "../core/daemon/index.js";
import { Presence } from "../core/presence/index.js";
import { callAsPerson } from "../core/cli/presence.js";
import { tempHome } from "./helpers.js";

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "bin", "vyre");

/** A real vyred with the real verifier: Touch ID off, and codes written to `screen`. */
async function realVyred(t) {
  const root = tempHome(t);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ transcripts: [], vault: { keystore: "file" } }));
  const screen = [];
  const d = await start({ root, log: () => {}, presence: deps => new Presence({ ...deps,
    touchid: { available: async () => false, authenticate: async () => ({ ok: false, reason: "unavailable" }) },
    who: async () => ["ttys007"], statTty: () => ({ uid: process.getuid?.() ?? 0, isCharacterDevice: () => true }),
    writeTty: (file, text) => screen.push({ file, text }) }) });
  t.after(() => d.stop());
  return { root, screen };
}

/** The CLI as the model's Bash runs it: pipes, no controlling terminal. */
function vyre(args, env, input = "") {
  return new Promise(resolve => {
    const p = spawn(process.execPath, [BIN, ...args], { env: { ...process.env, ...env, NO_COLOR: "1" }, detached: true, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    p.stdout.on("data", c => (out += c)); p.stderr.on("data", c => (out += c));
    p.on("close", code => resolve({ code, out }));
    p.stdin.end(input);
  });
}

/** A terminal that reads the code vyred wrote to the login terminal and types it back. */
const terminal = screen => ({
  openTty: () => 99, ttyName: () => "/dev/ttys007", print() {}, close() {},
  prompt: async () => /type this code[^:]*: ([A-Z0-9]+)/i.exec(screen.at(-1)?.text || "")?.[1] || "",
});

test("presence cli: vault and memory writes without a person are refused asking for one, exit 3", async t => {
  const { root } = await realVyred(t);
  const env = { VYRE_HOME: root };
  const cases = [
    [["vault", "put", "mail-token", "--kind", "api-key"], "fixture-value\n"],
    [["vault", "grant", "mail-token", "gate"]],
    [["vault", "get", "mail-token", "--copy"]],
    [["memory", "correct", "alex prefers tea", "wrong"]],
    [["memory", "merge", "Harlow", "Harlow Legal"]],
    [["memory", "split", "Harlow", "Harlow Legal"]],
  ];
  for (const [args, input] of cases) {
    const r = await vyre(args, env, input || "");
    assert.equal(r.code, 3, `vyre ${args.join(" ")}: ${r.out}`);
    assert.match(r.out, /needs a person at a terminal/, `vyre ${args.join(" ")} did not go through callAsPerson: ${r.out}`);
  }
});

test("presence cli: with the person's proof from their terminal, vault.put and memory.correct go through", async t => {
  const { root, screen } = await realVyred(t);
  const io = terminal(screen);
  const put = await callAsPerson("vault.put", { name: "mail-token", kind: "api-key", fields: { value: "fixture-value" } }, { root, io, tty: true });
  assert.ok(put.data, JSON.stringify(put));
  assert.equal(screen.at(-1).file, "/dev/ttys007", "the code went to the person's login terminal");
  const grant = await callAsPerson("vault.grant", { name: "mail-token", module: "gate" }, { root, io, tty: true });
  assert.ok(grant.data, JSON.stringify(grant));
  // A fact that is not there is the tool's own answer, past presence: proof was accepted.
  const c = await callAsPerson("memory.correct", { fact: "no such fact", action: "wrong" }, { root, io, tty: true });
  assert.notEqual(c.error && c.error.code, "presence_required", JSON.stringify(c));
});
