// @ts-check
// The code's handoff from the install script to the box: install-box.sh's write_code puts
// VYRE_SETUP_CODE into vyre.env, compose hands that file to the container as its environment, and
// the relay module reads the same name at boot (reviewer-2, 30 Sep: the two once disagreed, so
// setup never started). The script arrives with launch's branch; until then this skips.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { start } from "../daemon/index.js";
import { createRelay } from "../../relay/node/server.js";
import { createSetupKey, setupCode } from "../../relay/client/setup.js";
import { tempHome } from "../../test/helpers.js";

const SCRIPT = fileURLToPath(new URL("../../scripts/install-box.sh", import.meta.url));
const text = fs.readFileSync(SCRIPT, "utf8");
const fn = name => new RegExp(`^${name}\\(\\) \\{\\n[\\s\\S]*?\\n\\}\\n`, "m").exec(text)?.[0];
const wc = fn("write_code"), pt = fn("put");

test("setup handoff: the name install-box.sh writes into vyre.env is the name the relay boots on", { skip: wc && pt ? false : "install-box.sh has no write_code yet (launch's branch)" }, async t => {
  const real = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: "linux", configurable: true });
  t.after(() => Object.defineProperty(process, "platform", /** @type {any} */ (real)));

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vyre-handoff-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const key = await createSetupKey();
  const code = await setupCode(crypto.randomBytes(16), key.spki);

  // The installer's own function, in its own shell, with the file put in place by the script's own put.
  fs.writeFileSync(path.join(dir, "vyre.env"), "CLOUDFLARE_VYRE_TOKEN=keep\n", { mode: 0o600 });
  const r = spawnSync("sh", ["-c", `mine() { return 0; }\nrun() { \"$@\"; }\npriv() { \"$@\"; }\nsay() { :; }\n${pt}\n${wc}\nwrite_code`], { encoding: "utf8",
    env: { PATH: process.env.PATH || "/usr/bin:/bin", CODE: code, DRY: "0", DIR: dir, SUDO: "", TMP: fs.mkdtempSync(path.join(dir, "t")) } });
  assert.equal(r.status, 0, r.stderr);
  const lines = fs.readFileSync(path.join(dir, "vyre.env"), "utf8").split("\n");
  assert.ok(lines.includes("CLOUDFLARE_VYRE_TOKEN=keep"), "the person's lines stay");
  const names = lines.filter(l => !l.startsWith("#") && /code/i.test(l.split("=")[0])).map(l => l.split("=")[0]);
  assert.deepEqual(names.filter(n => n !== "VYRE_SETUP_CODE_AT"), ["VYRE_SETUP_CODE"], "the box's name for the code, and only that");
  assert.ok(names.includes("VYRE_SETUP_CODE_AT"), "and the stamp the relay needs to accept it (epoch seconds)");

  // What compose does with env_file: every KEY=VALUE becomes the container's environment. The relay
  // boots on it and starts a setup session.
  const relay = createRelay();
  const base = await relay.listen();
  t.after(() => relay.close());
  const root = tempHome(t);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ role: "box", name: "alex", transcripts: [], network: { name: "alex" }, relay: { enabled: false, url: base }, modules: { disable: ["names", "onboard"] } }));
  const saved = { ...process.env };
  for (const l of lines.filter(l => !l.startsWith("#"))) { const i = l.indexOf("="); if (i > 0 && !l.startsWith("#")) process.env[l.slice(0, i)] = l.slice(i + 1); }
  t.after(() => { for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]; });
  const d = await start({ root, log: () => {} });
  t.after(() => d.stop());
  let st;
  for (let i = 0; i < 50; i++) { st = (await d.registry.call("relay.setup.status", {}, "cli")).data; if (st && st.state === "waiting" && st.registered) break; await new Promise(x => setTimeout(x, 50)); }
  assert.equal(st.state, "waiting", "the relay read the code the script wrote");
  assert.equal(process.env.VYRE_SETUP_CODE, undefined, "and took it out of its environment");
});
