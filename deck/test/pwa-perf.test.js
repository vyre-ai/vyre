// @ts-check
// The phone app's speed budget as a test: a tab switch, a revisit and going back in Chat each
// paint within 100 ms on a 4x slower CPU with 60 ms to the box (deck/test/pwa-perf.js). It needs a
// running Chrome, so it runs only when CDP names one (the test box has it); anywhere else it skips.
//
//   CDP=http://127.0.0.1:9422 node --test deck/test/pwa-perf.test.js

import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const free = () => new Promise(r => { const s = net.createServer().listen(0, "127.0.0.1", () => { const p = /** @type {any} */ (s.address()).port; s.close(() => r(p)); }); });

test("pwa perf: tabs, revisits and Chat paint within budget", { skip: !process.env.CDP && "no CDP Chrome here", timeout: 180_000 }, async t => {
  const port = await free();
  const world = spawn(process.execPath, [path.join(HERE, "world.js"), String(port)], { env: { ...process.env, VYRE_NO_DIALOGS: "1" }, stdio: ["ignore", "pipe", "inherit"] });
  t.after(() => world.kill("SIGTERM"));
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("the world did not come up")), 90_000);
    world.stdout.on("data", d => { if (String(d).includes("deck world:")) { clearTimeout(timer); resolve(null); } });
  });
  await new Promise(r => setTimeout(r, 3000)); // the first Recall pass
  const run = spawn(process.execPath, [path.join(HERE, "pwa-perf.js"), `http://127.0.0.1:${port}`], { env: process.env, stdio: ["ignore", "pipe", "inherit"] });
  let out = "";
  run.stdout.on("data", d => { out += d; });
  const code = await new Promise(r => run.on("exit", r));
  t.diagnostic(out.trim().split("\n").at(-1) || "");
  assert.equal(code, 0, out);
});
