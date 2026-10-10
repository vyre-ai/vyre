// The root side of a scheduled job: pub-up sets it up (nothing starts, nothing joins the vyre container, the approved image is recorded) and pub-run runs that image once, with the limits, the
// floor between runs, the container removed and the output kept without the job's own secrets. The rig is test/space-helper-pub-rig.js.
// @ts-check
import "../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { opts } from "./space-helper-rig.js";
import { DEP, DEP2, REQUEST, read, ready } from "./space-helper-pub-rig.js";

const JOB = (/** @type {Record<string, string>} */ over = {}) => REQUEST({ job: "600", ...over });
/** A job built and set up. */
async function jobReady(/** @type {import("node:test").TestContext} */ t, secrets = "-", values = {}) {
  const r = await ready(t);
  assert.equal((await r.build(DEP, { request: JOB() })).state, "ok");
  const st = await r.up(DEP, { request: JOB({ secrets }), secrets: values });
  assert.equal(st.state, "ok", JSON.stringify(st));
  return { r, st };
}

test("pub-up of a job sets it up: nothing starts, nothing joins the vyre container, no wall is needed, and the approved image is recorded", opts, async t => {
  const { r, st } = await jobReady(t);
  assert.equal(st.message, "the job is set up and has not run");
  const d = path.join(r.priv, "apps", "northwind");
  assert.ok(!fs.existsSync(path.join(r.F, "app-running-northwind")), "not started");
  assert.ok(!/network connect/.test(r.calls()), "it does not join the vyre container");
  assert.deepEqual(r.appFw(), [], "no door and no wall: there is no neighbour");
  assert.match(read(path.join(d, "jobok")), /^sha256:[0-9a-f]{64} 600$/m);
  assert.match(read(path.join(d, "compose.yml")), /^    internal: true$/m, "its own internal network");
  assert.match(read(r.rec(DEP)), / spc_abcdefghijkl 600\n$/, "the record carries the job's limit");
});

test("pub-run runs the approved image once with the limit, removes the container, keeps what it printed without its own secrets, and answers the exit code", opts, async t => {
  const { r } = await jobReady(t, "API_KEY", { API_KEY: "sk_live_abc123" });
  r.flag("job-out", "hello\nkey=sk_live_abc123 end\u0001x\n");
  r.flag("job-leftover");
  const st = await r.ask(`pub-run ${DEP}`);
  assert.equal(st.state, "ok", JSON.stringify(st));
  assert.match(st.message, /^the job ran: exit 0 in \d+ seconds$/);
  const out = read(path.join(r.priv, "..", "status", `jobout-${DEP}`));
  assert.match(out, /^exit=0 seconds=\d+\n/);
  assert.ok(out.includes("key=[secret] end?x"), out);
  assert.ok(!out.includes("sk_live_abc123"), "the job's own secret is not kept");
  assert.equal(fs.statSync(path.join(r.priv, "..", "status", `jobout-${DEP}`)).mode & 0o777, 0o644);
  assert.match(read(path.join(r.F, "job-runs")), /vyre-app-northwind .* run --rm -T app/);
  assert.ok(fs.existsSync(path.join(r.F, "job-removed")), "the container was removed");
  assert.ok(!/up -d|network connect/.test(r.calls()), "it was run, never started as a server");
});

test("pub-run refuses a second run within the floor, a failing job says its exit code, and the output of a failing job is kept", opts, async t => {
  const { r } = await jobReady(t);
  r.flag("job-exit", "3"); r.flag("job-out", "boom\n");
  const first = await r.ask(`pub-run ${DEP}`);
  assert.equal(first.state, "failed");
  assert.match(first.message, /ended with exit 3/);
  assert.match(read(path.join(r.priv, "..", "status", `jobout-${DEP}`)), /^exit=3 seconds=\d+\nboom\n/);
  const again = await r.ask(`pub-run ${DEP}`);
  assert.equal(again.state, "failed");
  assert.match(again.message, /ran less than 5 minutes ago/);
  // after the floor it may run again
  const ran = path.join(r.priv, "apps", "northwind", "jobran");
  const old = new Date(Date.now() - 6 * 60_000); fs.utimesSync(ran, old, old);
  r.flag("job-exit", "0");
  assert.equal((await r.ask(`pub-run ${DEP}`)).state, "ok");
});

test("pub-run runs only a job, only the image that was approved, and only what is still here", opts, async t => {
  const { r } = await jobReady(t);
  const jobok = path.join(r.priv, "apps", "northwind", "jobok");
  fs.writeFileSync(jobok, "sha256:" + "0".repeat(64) + " 600\n");
  const other = await r.ask(`pub-run ${DEP}`);
  assert.equal(other.state, "failed");
  assert.match(other.message, /not the one the owner approved/);
  fs.writeFileSync(jobok, `${read(r.rec(DEP)).split(" ")[2]} 600\n`);
  r.flag("pub-image-gone");
  assert.match((await r.ask(`pub-run ${DEP}`)).message, /image that was approved is not here any more/);
  fs.rmSync(path.join(r.F, "pub-image-gone"));
  assert.match((await r.ask("pub-run dep_ffffffffffffffff")).message, /never built here/);
  // a server is not a job
  await r.build(DEP2, { request: REQUEST({ name: "other", version: "4" }) }); await r.up(DEP2, { request: REQUEST({ name: "other", version: "4" }) });
  const srv = await r.ask(`pub-run ${DEP2}`);
  assert.equal(srv.state, "failed");
  assert.match(srv.message, /not a job/);
  assert.ok(!fs.existsSync(path.join(r.F, "job-runs")), "nothing ran");
});

test("a job's limit is 60 to 3600 seconds: the settings say so before anything is built", opts, async t => {
  const r = await ready(t);
  for (const bad of ["59", "3601", "abc", "-5"]) {
    const st = await r.build(DEP, { request: JOB({ job: bad }) });
    assert.equal(st.state, "failed", bad);
    assert.match(st.message, /60 to 3600 seconds/, bad);
  }
  assert.equal((await r.build(DEP, { request: JOB({ job: "3600" }) })).state, "ok");
});
