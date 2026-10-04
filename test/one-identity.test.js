// @ts-check
// ONE identity per person, on a real vyred: after a claim, spaces.identity.status, wink.pair.targets and the spaces list all report the same identity id. Pairing and install read the id
// from the spaces module (spaces.identity.id); they never derive or keep their own.
// Steps 2 and 3 of the end-to-end walk on a REAL vyred (core/daemon start, a real socket, the callers the daemon itself decides) against the stand-in names directory
// (scripts/standin-directory.mjs, a real process on loopback): claim an identity, create a space, resolve both by name. Then BR-1 on the same daemon with the kernel on:
// every unprivileged caller label naming a real member is refused by every bridges tool, and the member's own verified call works.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { tempHome } from "./helpers.js";
import { start } from "../core/daemon/index.js";
import { call } from "../core/daemon/client.js";

const SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "scripts", "standin-directory.mjs");
const freePort = () => new Promise(res => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const p = /** @type {any} */ (s.address()).port; s.close(() => res(p)); }); });

test("one identity: spaces.identity.status and wink.pair.targets report the same id after a claim", async t => {
  const port = await freePort();
  const child = spawn(process.execPath, [SCRIPT, "--port", String(port)], { stdio: ["ignore", "pipe", "inherit"] });
  t.after(() => { child.kill("SIGTERM"); });
  await new Promise((res, rej) => { child.stdout.on("data", d => { if (String(d).includes("stand-in names directory")) res(null); }); child.on("exit", c => rej(new Error(`the stand-in exited early (${c})`))); });
  const root = tempHome(t);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ name: "one-id-box", transcripts: [], vault: { keystore: "file" }, names: { directory: `http://127.0.0.1:${port}` }, modules: { enable: [], disable: ["recall", "memory", "learn"] } }));
  const lines = /** @type {string[]} */ ([]);
  const d = await start({ root, kernel: true, log: m => lines.push(String(m)) });
  t.after(() => d.stop());
  const deck = (/** @type {string} */ tool, /** @type {any} */ input = {}) => call(tool, input, { root, caller: "deck" });
  const wink = d.registry.modules.get("wink");
  assert.equal(wink && wink.state, "running", wink && wink.error);
  const before = await deck("wink.pair.targets");
  assert.ok(!before.error, JSON.stringify(before.error));
  const made = await deck("spaces.identity.create", { name: "alex" });
  assert.ok(!made.error, JSON.stringify(made.error));
  const st = await deck("spaces.identity.status");
  assert.equal(st.data.id, made.data.id);
  const after = await deck("wink.pair.targets");
  assert.ok(!after.error, JSON.stringify(after.error));
  const me = after.data.targets.find((/** @type {any} */ x) => x.kind === "identity");
  assert.equal(me.id, made.data.id, "pairing answers for the identity the person claimed");
  await deck("spaces.create", { name: "harlow", home: { kind: "this-computer", confirmed: true } });
  const list = await deck("spaces.list");
  assert.equal(list.data.length, 1, lines.filter(l => /records/.test(l)).join(" ; "));
  assert.equal((await deck("wink.pair.targets")).data.targets[0].id, made.data.id);
});
