// @ts-check
// One identity per person (DESIGN-wink 1), on a REAL vyred: after the identity is claimed through the names directory (the stand-in, a real process on loopback), the pairing
// targets Wink offers name that same id, not a second one made from the box's route. Run on a runner or the test box, never on a person's Mac.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { start } from "../core/daemon/index.js";
import { createRelay } from "../relay/node/server.js";
import { call } from "../core/daemon/client.js";
import { tempHome } from "./helpers.js";

const SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "scripts", "standin-directory.mjs");
const freePort = () => new Promise(res => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const p = /** @type {any} */ (s.address()).port; s.close(() => res(p)); }); });

test("wink.pair.targets and spaces.identity.status report the same identity id, before and after a claim", async t => {
  process.env.VYRE_SEAL_DEV = "1";
  process.env.VYRE_KERNEL_PATH_RULE = "1";
  t.after(() => { delete process.env.VYRE_KERNEL_PATH_RULE; });
  const port = await freePort();
  const child = spawn(process.execPath, [SCRIPT, "--port", String(port)], { stdio: ["ignore", "pipe", "inherit"] });
  t.after(() => { child.kill("SIGTERM"); });
  await new Promise((res, rej) => { child.stdout.on("data", d => { if (String(d).includes("stand-in names directory")) res(null); }); child.on("exit", c => rej(new Error(`the stand-in exited early (${c})`))); });
  const relay = createRelay();
  const relayUrl = await relay.listen();
  t.after(() => relay.close());
  const root = tempHome(t);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ name: "one-box", transcripts: [], vault: { keystore: "file" }, relay: { enabled: true, url: relayUrl }, names: { directory: `http://127.0.0.1:${port}` },
    modules: { disable: ["recall", "memory", "learn"] } }));
  const lines = /** @type {string[]} */ ([]);
  const d = await start({ root, kernel: true, log: m => { lines.push(m); } });
  t.after(() => d.stop());
  const deck = (/** @type {string} */ tool, /** @type {any} */ input = {}) => call(tool, input, { root, caller: "deck" });
  const targets = async () => { const r = await deck("wink.pair.targets"); assert.ok(!r.error, JSON.stringify(r.error) + " " + lines.filter(l => /wink/i.test(l)).join(" ; ").slice(0, 1200)); return r.data.targets[0]; };

  const before = await targets();
  assert.equal(before.kind, "identity");
  const made = await deck("spaces.identity.create", { name: "alex" });
  assert.ok(!made.error, JSON.stringify(made.error));
  const st = (await deck("spaces.identity.status")).data;
  assert.equal(st.id, made.data.id);
  const after = await targets();
  assert.equal(after.id, st.id, "pairing targets the identity the spaces module claimed");
  assert.notEqual(after.id, before.id, "the route-derived stand-in id is no longer used once an identity exists");
});
