// @ts-check
// `vyre relay` as a person runs it: the real bin/vyre in a child process, against a vyred started
// in this process in a temp home, with the Node relay on 127.0.0.1. No Tailscale, no Cloudflare.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { start } from "../../daemon/index.js";
import { tempHome } from "../../../test/helpers.js";
import { createRelay } from "../../../relay/node/server.js";
import { terminalQr } from "./relay.js";

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "bin", "vyre");

/** @returns {Promise<{ code: number, out: string }>} */
const run = (root, args) => new Promise(resolve =>
  execFile(process.execPath, [BIN, ...args], { env: { ...process.env, VYRE_HOME: root, NO_COLOR: "1", VYRE_NO_DIALOGS: "1" }, timeout: 30_000 },
    (err, stdout, stderr) => resolve({ code: err ? Number(/** @type {any} */ (err).code ?? 1) : 0, out: stdout + stderr })));

test("relay cli: the terminal QR is square, with a quiet zone, in half blocks only", () => {
  const qr = terminalQr("https://vyre.run/pair#eyJ2IjoxfQ").split("\n");
  const width = qr[0].length;
  assert.ok(qr.every(l => l.length === width));
  assert.equal(qr.length, Math.ceil(width / 2));
  assert.match(qr.join(""), /^[█▀▄ ]+$/);
  assert.match(qr[0], /^█+$/, "the quiet zone is light");
});

test("relay cli: status and devices read without presence; pair and changes need a person", async t => {
  const relay = createRelay();
  const url = await relay.listen();
  t.after(() => relay.close());
  const root = tempHome(t);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ role: "box", name: "alex", transcripts: [],
    network: { name: "alex" }, relay: { enabled: false, url }, modules: { disable: ["names", "onboard", "recall", "memory", "learn"] } }));
  const d = await start({ root, log: () => {} });
  t.after(() => d.stop());

  const s = await run(root, ["relay"]);
  assert.equal(s.code, 0, s.out);
  assert.match(s.out, /relay off/);
  assert.match(s.out, /vyre relay pair/);

  const list = await run(root, ["relay", "devices", "--json"]);
  assert.equal(list.code, 0, list.out);
  assert.deepEqual(JSON.parse(list.out), { devices: [] });

  // On testbox the child has no terminal, so presence cannot be asked and nothing changes. On a
  // Mac a terminal could offer Touch ID, which a test must never raise: checked on Linux only.
  if (process.platform === "linux") {
    const pair = await run(root, ["relay", "pair"]);
    assert.notEqual(pair.code, 0);
    assert.match(pair.out, /terminal|presence/i);
  }
  assert.equal((await run(root, ["relay", "remove"])).code, 2);
  assert.equal((await run(root, ["relay", "bogus"])).code, 2);
});
