// @ts-check
// G18 on a real vyred: the names a person sees for their Spaces. A computer's own Space is "My Home"; on a server it is "My Cloud"; a team Space on a server is "<its name>'s Cloud". The app draws every name with the
// one function (apps/app/src/state/space-name.js) from what spaces.list answers, so the names are read from a real daemon's own rows.
import "../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { start } from "../core/daemon/index.js";
import net from "node:net";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tempHome, present } from "./helpers.js";
import { spaceName } from "../apps/app/src/state/space-name.js";

process.env.VYRE_KERNEL ??= "1"; process.env.VYRE_KERNEL_PATH_RULE ??= "1"; process.env.VYRE_SEAL_DEV ??= "1";

const SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "scripts", "standin-directory.mjs");
const freePort = () => new Promise(res => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const p = /** @type {any} */ (s.address()).port; s.close(() => res(p)); }); });

async function world(/** @type {import("node:test").TestContext} */ t, /** @type {any} */ cfg) {
  const port = await freePort();
  const child = spawn(process.execPath, [SCRIPT, "--port", String(port)], { stdio: ["ignore", "pipe", "inherit"] });
  t.after(() => { child.kill("SIGTERM"); });
  await new Promise((res, rej) => { child.stdout.on("data", d => { if (String(d).includes("stand-in names directory")) res(null); }); child.on("exit", c => rej(new Error(`the stand-in exited early (${c})`))); });
  const root = tempHome(t);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ name: "names-box", vault: { keystore: "file" }, names: { directory: `http://127.0.0.1:${port}` }, ...cfg }));
  const d = await start({ root, presence: present, log: () => {}, kernel: true });
  t.after(() => d.stop());
  const as = async (/** @type {string} */ tool, /** @type {any} */ input = {}) => {
    const owner = d.kernel.chains.fromFacts({ kind: "device", device_key_id: "d-o", person: d.kernel.id.owner, path: "direct", session: "s" });
    return d.registry.call(tool, input, "cli", { token: (await d.kernel.surfaces.open(owner, {})).token });
  };
  return { d, as };
}

test("a computer's own Space reads My Home", async t => {
  const { as } = await world(t, { machine: "solo" });
  assert.ok(!(await as("spaces.identity.create", { name: "alex" })).error);
  const rows = (await as("spaces.list")).data;
  const home = rows.find((/** @type {any} */ r) => r.label === "personal");
  assert.ok(home, JSON.stringify(rows));
  assert.equal(spaceName(home), "My Home", JSON.stringify(home));
});

test("on a server the person's own Space reads My Cloud", async t => {
  const { as } = await world(t, { machine: "server" });
  assert.ok(!(await as("spaces.identity.create", { name: "sam" })).error);
  const rows = (await as("spaces.list")).data;
  const home = rows.find((/** @type {any} */ r) => r.label === "personal");
  assert.ok(home, JSON.stringify(rows));
  assert.equal(spaceName(home), "My Cloud", JSON.stringify(home));
});

test("a team Space on a server reads <its name as the person typed it>'s Cloud", async t => {
  const { as } = await world(t, { machine: "server" });
  assert.ok(!(await as("spaces.identity.create", { name: "sam" })).error);
  const made = await as("spaces.create", { name: "northwind", displayName: "Northwind Bakery", home: { kind: "this-computer", confirmed: true } });
  assert.ok(!made.error, JSON.stringify(made.error));
  const rows = (await as("spaces.list")).data;
  const team = rows.find((/** @type {any} */ r) => r.label !== "personal");
  assert.ok(team, JSON.stringify(rows));
  assert.equal(spaceName(team), "Northwind Bakery's Cloud", JSON.stringify(team));
});
