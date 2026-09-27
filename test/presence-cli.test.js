// @ts-check
// `vyre vault` writes against the REAL presence verifier (no test fixture that finds a person at
// every call). Without a terminal they are refused asking for a person at a terminal, which is
// callAsPerson's answer, so the commands do route through it. With the proof (the code vyred
// writes to the person's login terminal, typed back) they go through. `vyre memory` corrections
// are the user's own and ask nothing (the no-nag rule).

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { start } from "../core/daemon/index.js";
import { Presence } from "../core/presence/index.js";
import { callAsPerson } from "../core/cli/presence.js";
import { call } from "../core/daemon/client.js";
import { tempHome } from "./helpers.js";

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "bin", "vyre");

/** A real vyred with the real verifier: Touch ID off, and codes written to `screen`. */
async function realVyred(t, { touchid = false } = {}) {
  const root = tempHome(t);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ transcripts: [], vault: { keystore: "file" } }));
  const screen = [];
  const d = await start({ root, log: () => {}, presence: deps => new Presence({ ...deps, ...(touchid ? { platform: "darwin" } : {}),
    touchid: { available: async () => touchid, authenticate: async () => (touchid ? { ok: true } : { ok: false, reason: "unavailable" }) },
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

test("presence cli: vault writes without a person are refused asking for one, exit 3; memory asks nothing", async t => {
  const { root } = await realVyred(t);
  const env = { VYRE_HOME: root };
  const cases = [
    [["vault", "put", "mail-token", "--kind", "api-key"], "fixture-value\n"],
    [["vault", "grant", "mail-token", "gate"]],
    [["vault", "get", "mail-token", "--copy"]],
  ];
  for (const [args, input] of cases) {
    const r = await vyre(args, env, input || "");
    assert.equal(r.code, 3, `vyre ${args.join(" ")}: ${r.out}`);
    assert.match(r.out, /needs a person at a terminal/, `vyre ${args.join(" ")} did not go through callAsPerson: ${r.out}`);
  }
  // No terminal, no code: a correction reaches memory, whose own answer (nothing matches) is past presence.
  for (const args of [["memory", "correct", "alex prefers tea", "wrong"], ["memory", "merge", "Harlow", "Harlow Legal"], ["memory", "split", "Harlow", "Harlow Legal"]]) {
    const r = await vyre(args, env);
    assert.notEqual(r.code, 3, `vyre ${args.join(" ")}: ${r.out}`);
    assert.doesNotMatch(r.out, /person at a terminal|Type the code/, `vyre ${args.join(" ")} asked for presence: ${r.out}`);
  }
});

test("presence cli: with the person's proof from their terminal, vault.put and vault.grant go through", async t => {
  const { root, screen } = await realVyred(t);
  const io = terminal(screen);
  const put = await callAsPerson("vault.put", { name: "mail-token", kind: "api-key", fields: { value: "fixture-value" } }, { root, io, tty: true });
  assert.ok(put.data, JSON.stringify(put));
  assert.equal(screen.at(-1).file, "/dev/ttys007", "the code went to the person's login terminal");
  const grant = await callAsPerson("vault.grant", { name: "mail-token", module: "gate" }, { root, io, tty: true });
  assert.ok(grant.data, JSON.stringify(grant));
});

test("presence cli: one Touch ID, then vault reads ask nothing for a while; MCP and agents are still refused", async t => {
  const { root, screen } = await realVyred(t, { touchid: true });
  const io = terminal(screen);
  assert.ok((await callAsPerson("vault.put", { name: "mail-token", kind: "api-key", fields: { value: "fixture-value" } }, { root, io, tty: true })).data);
  // The first reveal asks (Touch ID); the second, from a process with no terminal, rides the window.
  const first = await callAsPerson("vault.reveal", { name: "mail-token" }, { root, io });
  assert.ok(first.data, JSON.stringify(first));
  const r = await vyre(["vault", "get", "mail-token", "--json"], { VYRE_HOME: root });
  assert.equal(r.code, 0, r.out);
  assert.doesNotMatch(r.out, /person at a terminal|Type the code/);
  for (const caller of ["mcp", "cli agent:kit"]) {
    const e = await call("vault.reveal", { name: "mail-token" }, { root, caller });
    assert.ok(e.error, `${caller} revealed a value`);
  }
});
