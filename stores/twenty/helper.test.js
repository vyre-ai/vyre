import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { SCRATCH } from "../../test/scratch.mjs";
import { helperPresent, askHelper, helperRunner } from "./helper.js";
import { preflight, planStore, createStoreFor, SMALL_BOX_CHOICES } from "./space-store.js";

const dirs = [];
const mk = () => { const root = fs.mkdtempSync(path.join(SCRATCH, "hp-")); dirs.push(root); const spool = path.join(root, "spool"), state = path.join(root, "state"); fs.mkdirSync(spool); fs.mkdirSync(state); return { spool, state }; };
process.on("exit", () => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

/** The root helper's side, for a test: claim each request, answer running then ok (or the answer given). */
function fakeHelper({ spool, state }, answer = { state: "ok", message: "done" }) {
  const seen = [];
  const t = setInterval(() => {
    for (const f of fs.readdirSync(spool).filter((x) => x.startsWith("req-"))) {
      const text = fs.readFileSync(path.join(spool, f), "utf8"); fs.rmSync(path.join(spool, f));
      const id = f.slice(4); seen.push(text.trim());
      fs.writeFileSync(path.join(state, `status-${id}`), JSON.stringify({ id, state: "running", message: "up", at: 1 }));
      setTimeout(() => fs.writeFileSync(path.join(state, `status-${id}`), JSON.stringify({ id, ...answer, at: 2 })), 20);
    }
  }, 5);
  return { seen, stop: () => clearInterval(t) };
}

test("helper: the spool is the capability; a request is one line, mode 0600, and the answer is read by its id", async () => {
  const d = mk();
  assert.equal(helperPresent(d), true);
  assert.equal(helperPresent({ spool: path.join(d.spool, "nope"), state: d.state }), false);
  const h = fakeHelper(d);
  const r = await askHelper("up", "spc-abcdefghijkl", { ...d, pollMs: 5 });
  h.stop();
  assert.deepEqual([r.state, r.message], ["ok", "done"]);
  assert.deepEqual(h.seen, ["up spc-abcdefghijkl"]);
  await assert.rejects(() => askHelper("purge", "spc-abcdefghijkl", d), /not a request/);
  await assert.rejects(() => askHelper("up", "../x", d), /not a request/);
});

test("helper: a refusal or a failure is the helper's own short message, and no answer in time is unavailable", async () => {
  const d = mk();
  const h = fakeHelper(d, { state: "failed", message: "not enough memory" });
  await assert.rejects(() => askHelper("up", "spc-abcdefghijkl", { ...d, pollMs: 5 }), (e) => e.code === "failed" && /not enough memory/.test(e.message));
  h.stop();
  const quiet = mk();
  let t = 0;
  await assert.rejects(() => askHelper("up", "spc-abcdefghijkl", { ...quiet, pollMs: 1, timeoutMs: 50, now: () => (t += 20), sleep: async () => {} }), (e) => e.code === "unavailable");
});

test("helper: the provisioning runner turns the docker calls into requests, once for up, and refuses what the helper does not do", async () => {
  const d = mk();
  const h = fakeHelper(d);
  const r = helperRunner("spc-abcdefghijkl", { ...d, pollMs: 5 });
  await r.exec("docker", ["compose", "-f", "compose.yml", "--env-file", ".env", "pull", "--quiet"]);
  await r.exec("docker", ["compose", "-f", "compose.yml", "--env-file", ".env", "up", "-d", "--wait", "db", "redis"]);
  await r.exec("docker", ["compose", "-f", "compose.yml", "--env-file", ".env", "up", "-d", "--wait"]);
  await r.exec("docker", ["network", "connect", "--alias", "x", "n", "c"]);
  await r.exec("docker", ["compose", "stop"]);
  h.stop();
  assert.deepEqual(h.seen, ["up spc-abcdefghijkl", "stop spc-abcdefghijkl"], "pull and network are the helper's own; the two ups are one request");
  await assert.rejects(() => r.exec("docker", ["compose", "exec", "-T", "db", "pg_dump"]), /does not run/);
  await assert.rejects(() => r.exec("docker", ["run", "alpine"]), /does not run/);
});

test("capability: on a box the check asks for the helper, not for docker; with neither the reason is plain and the person's server is offered", async () => {
  const d = mk();
  const fixtures = { readMeminfo: () => "MemAvailable: 9000000 kB\n", statfs: () => ({ bavail: 20_000_000, bsize: 4096 }), docker: async () => false };
  const ok = await preflight({ dir: SCRATCH, helper: d, ...fixtures });
  assert.equal(ok.ok, true, ok.reasons.join("; "));
  assert.deepEqual([ok.facts.helper, ok.facts.docker], [true, true]);
  const none = await preflight({ dir: SCRATCH, helper: false, ...fixtures });
  assert.equal(none.ok, false);
  assert.match(none.reasons.join(" "), /cannot run Docker/);
  const plan = await planStore({ dir: SCRATCH, mode: "auto", helper: false, preflight: async (o) => preflight({ ...o, ...fixtures }) });
  assert.equal(plan.store, "sqlite");
  assert.deepEqual([...plan.confirm.choices], [...SMALL_BOX_CHOICES]);
  assert.ok(plan.confirm.choices.includes("server") && !plan.confirm.choices.includes("create"), "the person's server is offered; the built-in store is not");
});

test("createStoreFor in twenty mode: a machine that cannot run Twenty refuses a new space with the plain note and offers the server, never a quiet fallback", async () => {
  const home = fs.mkdtempSync(path.join(SCRATCH, "cs-")); dirs.push(home);
  const f = createStoreFor({ home, mode: "twenty", helper: false, preflight: async () => ({ ok: false, reasons: ["no Docker"], facts: {} }) });
  await assert.rejects(() => f("spc_abcdefghijkl", {}), (e) => e.code === "unavailable" && /no Docker/.test(e.message));
  // a box that should run Twenty and cannot (no Docker) is broken: auto refuses too, with the cause, and never offers the built-in store
  const g0 = createStoreFor({ home, mode: "auto", helper: false, preflight: async () => ({ ok: false, reasons: ["no Docker"], facts: {} }) });
  await assert.rejects(() => g0("spc_mnopqrstuvwx", {}), (e) => e.code === "unavailable" && /no Docker/.test(e.message) && /Records store/.test(e.message));
  // only a box too small for Twenty asks about the built-in store, and offers the server
  const g = createStoreFor({ home, mode: "auto", helper: false, preflight: async () => ({ ok: false, reasons: ["not enough free memory: 900 MB available, a Space's Twenty needs about 2000 MB"], facts: {} }) });
  await assert.rejects(() => g("spc_mnopqrstuvwx", {}), (e) => e.code === "needs_confirmation" && e.plan.confirm.choices.includes("server"));
  assert.equal(fs.existsSync(path.join(home, "kernel", "spaces", "spc_mnopqrstuvwx", "store.json")), false, "nothing was decided or written");
});
