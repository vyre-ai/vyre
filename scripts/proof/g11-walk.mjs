// @ts-check
// G11 on a fresh install: a development-build box installed by the real installer, then what a person gets. The agents' computers are on from the install (no .env edit): the .env has the profile and the
// docker-api proxy runs. The cloud computer is the default of Vyre Computer. "Vyre Computer as my default browser" is a setting that is off, and turning it on puts one line in the environment brief every
// assistant is told.
//   VYRE_JOURNEY_BOX=1 node scripts/proof/g11-walk.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRun } from "../lib/proof/run.mjs";
import { bringUp } from "../journeys/lib/world.mjs";
import { stepper } from "../journeys/lib/journey.mjs";

const out = fs.mkdtempSync(path.join(os.tmpdir(), "g11-walk-"));
const run = createRun({ out });
const sh = (/** @type {string} */ cmd) => spawnSync("sh", ["-c", cmd], { encoding: "utf8" });
const assert = (/** @type {any} */ v, /** @type {string} */ m) => { if (!v) throw new Error(m); };
let code = 1;
/** @type {any} */ let w = null;
try {
  w = await bringUp({ run, out, kind: "box", store: "plain", devBuild: true });
  const J = stepper(run, { id: "G11", owner: "operations" });
  if (!w.ready) { await J.step("the world is up", () => { throw new Error("the dev-build box world did not come up"); }); throw new Error("no world"); }
  await J.step("a fresh install turns the agents' computers on: COMPOSE_PROFILES=computers is in the .env the installer wrote", async () => {
    const env = fs.readFileSync("/srv/vyre/.env", "utf8");
    assert(/^COMPOSE_PROFILES=computers$/m.test(env), env);
    return "COMPOSE_PROFILES=computers";
  });
  await J.step("the docker-api proxy for the agents' computers is running without any edit", async () => {
    let names = "";
    for (let i = 0; i < 30; i++) { names = sh("docker ps --format '{{.Names}}'").stdout; if (/docker-api/.test(names)) break; await new Promise(r => setTimeout(r, 2000)); }
    assert(/docker-api/.test(names), `running: ${names.replace(/\n/g, " ")}`);
    return names.split("\n").filter(n => /docker-api/.test(n)).join(",");
  });
  await J.step("Vyre Computer lists the cloud computer first, the default", async () => {
    const r = await w.call("computer.targets", {});
    const names = (r.computers || []).map((/** @type {any} */ c) => c.name);
    assert(names[0] === "Cloud computer", JSON.stringify(names));
    return names.join(", ");
  });
  await J.step("the default-browser setting is off, and turning it on adds one line to the brief every assistant is told", async () => {
    const off = await w.call("settings.get", { key: "computer.default-browser" });
    assert(off.value === false, JSON.stringify(off).slice(0, 200));
    const briefOff = await w.call("sessions.environment", {});
    assert(!/default browser/.test(JSON.stringify(briefOff)), "the brief says nothing about it while it is off");
    const set = await w.call("settings.set", { key: "computer.default-browser", value: true });
    assert(set && !set.error, JSON.stringify(set).slice(0, 200));
    const briefOn = await w.call("sessions.environment", {});
    assert(/Vyre Computer is this person's default browser/.test(JSON.stringify(briefOn)), JSON.stringify(briefOn).slice(0, 300));
    return "off, then on";
  });
  code = run.finish();
} catch (e) {
  console.error(String(/** @type {Error} */ (e).stack || e));
  code = run.finish();
} finally {
  if (w) await w.stop().catch(() => {});
}
process.exit(code);
