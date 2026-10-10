// @ts-check
// The app module half of the Space helper, split into four files (one ran past the per-file time limit): this one is stop, down, reattach, purge, the rate limit and APP_URL. The rig and the fakes are test/space-helper-apps-rig.js.
// catalog, walled off the way a Space's store is. Run with sh against a temp folder; docker and nsenter are the fakes of test/space-helper-apps-rig.js (the Space helper's own fakes behind them), the
// generated compose file is the REAL one from core/appmods/host-plan.js. Linux only (stat -c). Real iptables, real Docker and a real DocuSeal need a box: see the live test, VYRE_APPMODS_LIVE=1.
import "../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { appRig, lineOf } from "./space-helper-apps-rig.js";
import { opts, UID } from "./space-helper-rig.js";

const SECRET = /api_token=tok_|login_password=pw_|hook_token=|SECRET_KEY_BASE=[0-9a-f]{64}/;
/** A rig with the helper installed and the catalog recorded (the real DocuSeal line). */
async function ready(/** @type {import("node:test").TestContext} */ t, over = {}) {
  const r = appRig(t);
  for (const [k, v] of Object.entries(over)) r.flag(k, v);
  await r.prime();
  return r;
}
const read = (/** @type {string} */ p) => fs.readFileSync(p, "utf8");


test("app helper: app-stop keeps the walls; app-down removes both chains' rules BEFORE the app leaves the interface, the subnet entry, the join and the app, and keeps the data", opts, async t => {
  const r = await ready(t);
  await r.appUp();
  const s = r.ask("app-stop documents\n");
  await r.helper();
  assert.equal(r.status(s).state, "ok");
  assert.ok(!fs.existsSync(path.join(r.F, "app-running-documents")));
  assert.equal(r.appFw().length, 5, "a stopped app keeps its walls");
  fs.writeFileSync(path.join(r.F, "calls"), "");
  const dn = r.ask("app-down documents\n");
  await r.helper();
  assert.equal(r.status(dn).state, "ok", JSON.stringify(r.status(dn)));
  assert.deepEqual(r.appFw(), [], "every rule with the app's comment is gone, INPUT and OUTPUT");
  assert.ok(!read(path.join(r.SP, "status", "subnets")).includes("app:documents"));
  assert.ok(!fs.existsSync(path.join(r.F, "app-net-documents")), "the network is removed");
  assert.ok(!read(path.join(r.F, "joined")).includes("vyre-app-documents_net"), "the vyre container left it");
  const calls = r.calls();
  assert.ok(calls.search(/-D INPUT/) < calls.search(/network disconnect -f vyre-app-documents_net/), "rules first, then the join");
  assert.ok(calls.search(/network disconnect/) < calls.search(/compose .* down/));
  assert.ok(!/ -v\b|volume rm/.test(calls), "the data is kept");
  assert.ok(!fs.existsSync(path.join(r.priv, "apps", "documents", "bootstrapped")), "the setup runs again on the next install");
  assert.ok(fs.existsSync(path.join(r.priv, "apps", "documents", "secrets.env")), "root keeps the app's keys with its data");
  // down for an app that was never started, stop for one, and a rule the helper cannot read as its own
  const never = appRig(t);
  await never.prime();
  const n = never.ask("app-down documents\n");
  await never.helper();
  assert.equal(never.status(n).state, "failed");
  assert.match(never.status(n).message, /never started/);
});

test("app helper: another app's, and a Space's, rules are never touched by app-down", opts, async t => {
  const r = await ready(t);
  // a second app: the real DocuSeal line and compose under another name and hook port
  const { composeFile } = await import("../core/appmods/host-plan.js");
  const first = r.catalogLine().trim().split("\n").find((/** @type {string} */ l) => l.startsWith("documents ")) || "";
  r.flag("hostplan-list", first + "\n" + first.split(" ").map((x, i) => (i === 0 ? "documents-two" : i === 6 ? "43002" : x)).join(" ") + "\n");
  r.flag("hostplan-compose-documents-two", composeFile("documents").replaceAll("vyre-app-documents", "vyre-app-documents-two"));
  await r.run(["space-helper", "install"]);
  assert.equal(r.catalogLine().trim().split("\n").length, 2);
  // a Space with its own rules in the same container
  const sp = r.ask("up harlow\n");
  await r.helper();
  assert.equal(r.status(sp).state, "ok");
  for (const m of ["documents", "documents-two"]) { r.flag("hook-port", m === "documents" ? "43001" : "43002"); const o = await r.appUp(m); assert.equal(o.st.state, "ok", m + ": " + JSON.stringify(o.st)); }
  assert.equal(r.appFw().length, 10);
  const dn = r.ask("app-down documents\n");
  await r.helper();
  assert.equal(r.status(dn).state, "ok");
  const left = r.appFw();
  assert.equal(left.length, 5);
  assert.ok(left.every((/** @type {any} */ x) => x.r.c === "vyre-app:documents-two"), "documents-two keeps all five");
  assert.equal(r.rules().filter(l => l.includes("vyre:harlow")).length, 2, "the Space keeps its two");
});

test("app helper: the handoff file is swept after ten minutes, and `reattach` walls and proves a running app again in a new container, or stops it", opts, async t => {
  const r = await ready(t);
  await r.appUp();
  const hand = path.join(r.SP, "status", "app-documents-secrets");
  assert.ok(fs.existsSync(hand));
  const old = new Date(Date.now() - 11 * 60 * 1000);
  fs.utimesSync(hand, old, old);
  r.ask("app-stop documents\n");
  r.ask("app-up documents\n");
  await r.helper();
  assert.ok(!fs.existsSync(hand), "an unread handoff does not wait for ever");
  // a new vyre container: new pid, no joins, no rules
  const again = async () => { r.flag("ctr-pid", String(9000 + Math.floor(Math.random() * 900))); fs.writeFileSync(path.join(r.F, "joined"), ""); fs.writeFileSync(path.join(r.F, "app-running-documents"), "1"); return /** @type {any} */ (await r.run(["space-helper", "reattach"], { SP_REWALL_WAIT: "0" })); };
  const ok = await again();
  assert.equal(ok.code, 0, ok.out);
  const pid = read(path.join(r.F, "ctr-pid"));
  assert.equal(r.appFw(pid).length, 5, "joined and walled again in the new container");
  assert.match(read(path.join(r.F, "joined")), /vyre-app-documents_net/);
  // a namespace still settling: a proof that fails twice and then holds does not stop the app
  r.flag("probe-flaky", "2");
  const settling = await again();
  assert.equal(settling.code, 0, settling.out);
  assert.ok(fs.existsSync(path.join(r.F, "app-running-documents")), "two failed proofs and a third that holds: the app stays");
  fs.rmSync(path.join(r.F, "probe-flaky"));
  r.flag("fw-ineffective");
  const bad = await again();
  assert.match(bad.out, /the app documents was stopped/);
  assert.ok(!fs.existsSync(path.join(r.F, "app-running-documents")), "an app that cannot be proved is stopped, never left running unwalled");
});

test("app helper: with no catalog the helper behaves as before (no app directory, no app rule, Twenty's rules unchanged)", opts, async t => {
  const r = appRig(t);
  r.flag("hostplan-list", "\n");
  await r.prime();
  assert.equal(r.catalogLine(), "");
  const id = r.ask("up harlow\n");
  await r.helper();
  assert.equal(r.status(id).state, "ok");
  assert.equal(r.appFw().length, 0);
  assert.equal(r.rules().length, 2);
});

test("app helper: app-up shares the up lane's rate limit with Twenty's up, and app-stop and app-down are never held back by it", opts, async t => {
  const r = await ready(t);
  // every app-up is refused at once (the vyre image is not the recorded one) so the eight land inside one minute; the count is taken before the work, as for Twenty's up
  r.flag("ctr-image", "sha256:" + "c".repeat(64));
  let states = [], stop = "";
  for (let attempt = 0; attempt < 2 && !states.includes("busy"); attempt++) {   // a minute boundary inside the run resets the window: look again once
    const ids = [];
    for (let i = 0; i < 8; i++) ids.push(r.ask("app-up documents\n"));
    const s = r.ask("app-stop documents\n");
    const h = /** @type {any} */ (await r.run(["space-helper-run"]));
    assert.equal(h.code, 0, h.out);
    states = ids.map(i => r.status(i).state);
    stop = r.status(s).state;
  }
  assert.ok(states.filter(x => x === "busy").length >= 2, `some are held back: ${states}`);
  assert.notEqual(stop, "busy", "a stop is not an up");
});

test("app helper: `vyre admin purge-app` is an admin act (a terminal, a typed word), never a request: it removes the rules, the app, its volumes and root's folder for it", opts, async t => {
  const r = await ready(t);
  await r.appUp();
  const dir = path.join(r.priv, "apps", "documents");
  assert.ok(fs.existsSync(dir));
  // not a spool verb
  const id = r.ask("app-purge documents\n");
  await r.helper();
  assert.equal(r.status(id).state, "failed");
  assert.ok(fs.existsSync(dir));
  // no terminal, a wrong word, a name that is not an app, an app root never started
  let a = /** @type {any} */ (await r.run(["admin", "purge-app", "documents"], {}, "purge-app documents\n"));
  assert.notEqual(a.code, 0); assert.match(a.out, /needs a terminal/);
  a = /** @type {any} */ (await r.run(["admin", "purge-app", "documents"], { VYRE_ADMIN_NO_TTY: "1" }, "y\n"));
  assert.notEqual(a.code, 0); assert.match(a.out, /not the word/);
  a = /** @type {any} */ (await r.run(["admin", "purge-app", "Docu.seal"], { VYRE_ADMIN_NO_TTY: "1" }, "x\n"));
  assert.notEqual(a.code, 0);
  a = /** @type {any} */ (await r.run(["admin", "purge-app", "nothere"], { VYRE_ADMIN_NO_TTY: "1" }, "x\n"));
  assert.match(a.out, /no app named nothere/);
  assert.ok(fs.existsSync(dir), "nothing was touched by any of them");
  fs.writeFileSync(path.join(r.F, "calls"), "");
  a = /** @type {any} */ (await r.run(["admin", "purge-app", "documents"], { VYRE_ADMIN_NO_TTY: "1" }, "purge-app documents\n"));
  assert.equal(a.code, 0, a.out);
  assert.deepEqual(r.appFw(), [], "both chains' rules are gone");
  assert.ok(!fs.existsSync(dir), "root's folder for the app is gone");
  assert.match(r.calls(), /compose .* down -v --remove-orphans/);
  assert.match(r.calls(), /image rm docuseal\/docuseal:[0-9.]+@sha256:[0-9a-f]{64}/, "the app's image goes with it");
  assert.ok(!read(path.join(r.SP, "status", "subnets")).includes("app:documents"));
  assert.match(read(path.join(r.priv, "log")), /admin purge-app documents/);
});

test("app helper: an install over a running watcher restarts it, so the watcher that re-walls after a restart of the vyre container runs the wrapper that was installed", opts, async t => {
  const r = await ready(t);
  fs.writeFileSync(path.join(r.F, "calls"), "");
  const p = /** @type {any} */ (await r.run(["space-helper", "install"]));
  assert.equal(p.code, 0, p.out);
  assert.match(r.calls(), /systemctl try-restart vyre-spaces-watch\.service/);
});

test("app helper: purge-app keeps an image another app that still has a folder here runs", opts, async t => {
  const r = await ready(t);
  const { composeFile } = await import("../core/appmods/host-plan.js");
  const first = r.catalogLine().trim().split("\n").find((/** @type {string} */ l) => l.startsWith("documents ")) || "";
  r.flag("hostplan-list", first + "\n" + first.split(" ").map((x, i) => (i === 0 ? "documents-two" : i === 6 ? "43002" : x)).join(" ") + "\n");
  r.flag("hostplan-compose-documents-two", composeFile("documents").replaceAll("vyre-app-documents", "vyre-app-documents-two"));
  await r.run(["space-helper", "install"]);
  for (const m of ["documents", "documents-two"]) { r.flag("hook-port", m === "documents" ? "43001" : "43002"); assert.equal((await r.appUp(m)).st.state, "ok", m); }
  fs.writeFileSync(path.join(r.F, "calls"), "");
  let a = /** @type {any} */ (await r.run(["admin", "purge-app", "documents"], { VYRE_ADMIN_NO_TTY: "1" }, "purge-app documents\n"));
  assert.equal(a.code, 0, a.out);
  assert.ok(!/image rm/.test(r.calls()), "documents-two still runs that digest");
  a = /** @type {any} */ (await r.run(["admin", "purge-app", "documents-two"], { VYRE_ADMIN_NO_TTY: "1" }, "purge-app documents-two\n"));
  assert.equal(a.code, 0, a.out);
  assert.match(r.calls(), /image rm docuseal\/docuseal/, "the last one takes it");
});

test("app helper: APP_URL is the public address (https://<module>.<name>.vyre.run:<port>) when the box has a name on vyre.run, read through the vyre container but kept only if it has that shape; otherwise the internal one", opts, async t => {
  const r = await ready(t);
  const urlOf = () => /APP_URL: "([^"]*)"/.exec(read(path.join(r.priv, "apps", "documents", "compose.yml")))[1];
  assert.equal((await r.appUp()).st.state, "ok");
  assert.equal(urlOf(), "http://vyre-app-documents:3000", "no name on vyre.run: the internal address");
  for (const bad of ["alex.evil 7443", "alex 99999999", "Alex 7443", "alex 7443\nhttp://x", "alex -1", "al$(id) 7443", "alex"]) {
    r.flag("public", bad);
    assert.equal((await r.appUp()).st.state, "ok", bad);
    assert.equal(urlOf(), "http://vyre-app-documents:3000", `${JSON.stringify(bad)} is not a name and a port: the internal address stays`);
  }
  r.flag("public", "alex 7443");
  assert.equal((await r.appUp()).st.state, "ok");
  assert.equal(urlOf(), "https://documents.alex.vyre.run:7443");
  // and the setup (a first start with the same name) is told the same address
  const r2 = await ready(t, { public: "alex 7443" });
  assert.equal((await r2.appUp()).st.state, "ok");
  assert.match(read(path.join(r2.F, "exec-env")), /^APP_URL=https:\/\/documents\.alex\.vyre\.run:7443$/m);
});
