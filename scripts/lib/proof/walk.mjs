// @ts-check
// One walk of the new install and pairing flow for one store choice. Each step is a line in the report; a step that needs an earlier one is skipped when that one failed.
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import { createApp } from "./app.mjs";
import { startInstallerServer } from "./server-installer.mjs";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

// The first walk of the install and pairing flow (reserve a name, add a server, four words) is gone with the flow it walked: the new first run is proved by scripts/proof-first-run.mjs.

/**
 * The update walk (--update): an app with its own identity pairs a server that is the OLD release (v0.2.12 by default, installed by that release's own installer with the app's install line), then asks for the update from the app. The steps are in updateSteps.
 * @param {{ run: ReturnType<typeof import("./run.mjs").createRun>, ins: Awaited<ReturnType<typeof import("./standins.mjs").startStandins>>, out: string, update: { oldVersion: string, newVersion: string, oldBox: string, oldUrl: string, newUrl: string, pub: string }, label?: string, after?: (a: { mac: any, srv: () => any, S: (n: string) => string, back: string }) => Promise<void> }} w
 *   label: the prefix on every step (default "update"). after: more steps on the updated server, run before it is taken down (J8 restarts it with no one at the keyboard).
 */
export async function walkUpdate(w) {
  const { run, ins, update } = w;
  const tag = w.label || "update";
  const S = (/** @type {string} */ n) => `${tag}: ${n}`;
  const dir = path.join(w.out, tag);
  fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir, { recursive: true });
  const mac = createApp({ label: "Proof Mac", dir: path.join(dir, "mac"), directory: ins.names, relay: ins.relay });
  /** @type {any} */ let reservation = null, flow = null, srv = null;
  try {
    await run.step(S("reserve a name and become yourself in the app"), async () => {
      reservation = await mac.reserve(`walkeru${Math.random().toString(36).slice(2, 7)}`);
      await mac.becomeYourself({ name: reservation.name, code: reservation.code });
    });
    await run.step(S("add a server: the app shows the install line"), async () => {
      flow = mac.addServer();
      await flow.begin();
      assert.ok(flow.state.installLine.includes(`VYRE_CODE=${flow.state.code}`));
    }, { needs: [S("reserve a name and become yourself in the app")] });
    await run.step(S(`the old release (${update.oldVersion}) installs from the line`), async () => {
      const a = { dir: path.join(dir, "server"), repo, code: flow.state.code, relayForServer: ins.relayForServer, relayPort: ins.relayPort, hostIp: ins.hostIp, namesForServer: ins.namesForServer, store: /** @type {const} */ ("plain"), release: update };
      srv = await startInstallerServer(a);
    }, { needs: [S("add a server: the app shows the install line")] });
    await run.step(S("the server adopts this identity and the app is ready"), async () => {
      await mac.until(() => flow.state.stage === "done" || flow.state.stage === "stopped", 120_000, "the app to finish pairing");
      assert.equal(flow.state.stage, "done", flow.state.error && flow.state.error.message);
    }, { needs: [S(`the old release (${update.oldVersion}) installs from the line`)] });
    await run.step(S("the app reaches the server and calls a tool"), async () => {
      await mac.openSession();
      assert.ok(await mac.callTool("system.info"), "system.info answered");
    }, { needs: [S("the server adopts this identity and the app is ready")] });
    await updateSteps({ w: { update, out: w.out }, run, S, mac, srv: () => srv, CALL: S("the app reaches the server and calls a tool") });
    if (w.after) await w.after({ mac, srv: () => srv, S, back: S("the host's unit installs the candidate and the server comes back as it") });
  } finally {
    try { if (srv) await srv.stop(); } catch { /* gone */ }
  }
}

/**
 * The update, from the app. The server was installed from the OLD release (v0.2.11 by default); the app asks for the update the way its Settings button does (update.status, then update.apply over its paired session, no ssh), and the box's own
 * root unit downloads the candidate, checks its signature, backs up, swaps and restarts. Then the same app, with no new pairing, finds the new version and everything it wrote before.
 * @param {{ w: any, run: any, S: (n: string) => string, mac: any, srv: () => any, CALL: string }} a
 */
/** A call that cannot hang the proof: the box restarts under the app, and a session opened on a dying link may never answer. @param {number} ms @param {() => Promise<any>} fn */
/** A fresh signed-in session straight to the box on :7443 (no relay): what the app does on a network that sees the box. Tries https with a self-made certificate, then plain http. @param {any} app */
async function directSession(app) {
  const pairing = app.pairing;
  const tryOrigin = async (/** @type {string} */ scheme) => {
    const call = async (/** @type {string} */ tool, /** @type {any} */ input, /** @type {Record<string, string>} */ headers = {}) => {
      const mod = await import(scheme === "https" ? "node:https" : "node:http");
      return await new Promise((res, no) => {
        const req = mod.request({ host: "127.0.0.1", port: 7443, path: `/v1/tools/${tool}`, method: "POST", rejectUnauthorized: false, headers: { "content-type": "application/json", ...headers } }, (r) => { let b = ""; r.on("data", d => { b += d; }); r.on("end", () => { try { res(JSON.parse(b)); } catch { res({ error: { message: b.slice(0, 120) } }); } }); });
        req.on("error", no); req.end(JSON.stringify(input));
      });
    };
    return await app.startDirect(call);
  };
  try { return await tryOrigin("https"); } catch (e) { return await tryOrigin("http"); }
}

const within = (ms, fn) => Promise.race([fn(), new Promise((_, no) => setTimeout(() => no(new Error(`no answer in ${ms / 1000} s`)), ms))]);

async function updateSteps({ w, run, S, mac, srv, CALL }) {
  const u = w.update;
  const U = (/** @type {string} */ n) => S(n);
  /** @type {any} */ let before = null, notice = null;
  const sorted = (/** @type {any} */ l) => JSON.stringify((Array.isArray(l) ? l : (l && (l.items || l.entries || l.notes)) || []).map((/** @type {any} */ x) => (typeof x === "string" ? x : JSON.stringify({ name: x.name, kind: x.kind, text: x.text, id: x.id }))).sort());
  await run.step(U("the server runs the old release and the app shows its notice"), async () => {
    notice = await mac.callTool("update.status");
    assert.equal(notice.current, u.oldVersion, `the server runs ${notice.current}, not ${u.oldVersion}`);
    // what the app's Settings notice needs to show (apps/app/screens/settings/update-model.js showNotice): a newer version out, and an update the server can take from here
    assert.equal(notice.available, u.newVersion, "the notice names the candidate");
    assert.equal(notice.canApply, true, "the server takes the request from the app (the host's update unit is installed)");
    assert.ok(!notice.pending && !(notice.run && notice.run.state === "running"), "no update is running yet");
    return `${notice.current} -> ${notice.available}`;
  }, { needs: [CALL] });
  await run.step(U("record what the vault and records hold before the update"), async () => {
    // A vault write and a personal record need the owner's phone or a person at a terminal (presence), which a CI app has neither: what is written here is what an app may write alone.
    let wrote = false;
    for (let i = 0; i < 40 && !wrote; i++) {
      try { await mac.callTool("planner.add", { kind: "note", text: "written before the update" }); wrote = true; }
      catch (e) { if (/presence_required|no_terminal/.test(String(/** @type {Error} */ (e).message))) break; await new Promise(r => setTimeout(r, 10_000)); }
    }
    const vault = await mac.callTool("vault.list", {}), plan = await mac.callTool("planner.list", {});
    if (wrote) assert.match(JSON.stringify(plan), /written before the update/, "the planner lists the note");
    const info = await mac.callTool("system.info");
    before = { vault: sorted(vault), plan: sorted(plan), owner: JSON.stringify(mac.pairing.owner), device: JSON.stringify(mac.pairing.device && mac.pairing.device.id || null), info: info && info.version };
    return `vault ${JSON.parse(before.vault).length} item(s), planner ${JSON.parse(before.plan).length}`;
  }, { needs: [U("the server runs the old release and the app shows its notice")] });
  // #112: a device that signs in again with its own confirmed key REPLACES the session it held: the new token works and the old one is dead at once.
  /** One call with a given token, then back to the token that was there. @param {string} token */
  const worksWith = async (token) => { const keep = mac.session.token; mac.session.token = token; try { await mac.callTool("system.info"); return true; } catch { return false; } finally { mac.session.token = keep; } };
  const replaceStep = (/** @type {string} */ name, /** @type {string[]} */ needs) => run.step(U(name), async () => {
    const old = String(mac.session.token);
    await mac.openSession();
    const fresh = String(mac.session.token);
    assert.notEqual(fresh, old, "a new session was opened");
    assert.equal(await worksWith(fresh), true, "the new token works");
    assert.equal(await worksWith(old), false, "the old token is dead at once");
    return "replaced; the old token is dead";
  }, { needs });
  // (no replace step BEFORE the update: the old release this proof starts from (0.2.12) predates #112 and refuses a second sign-in while its first session is live)
  await run.step(U("the app asks for the update (update.apply, the Settings button's call)"), async () => {
    const r = await mac.callTool("update.apply", { yes: true });
    assert.equal(r.requested, true, `the request was not taken: ${JSON.stringify(r).slice(0, 200)}`);
    return "requested";
  }, { needs: [U("record what the vault and records hold before the update")] });
  await run.step(U("the host's unit installs the candidate and the server comes back as it"), async () => {
    // the container restarts under the app: the old session is gone, so the app opens its next one the way it does after any restart
    // Wait for the box to say it runs the new version AT THE BOX (a docker exec, no app sign-in), then make exactly ONE sign-in try as the app would on reconnecting: more wrong tries lock the device out (presence LOCK_MS).
    let last = "", st = null;
    const deadline = Date.now() + 5 * 60_000;
    let boxVersion = "";
    while (Date.now() < deadline && boxVersion !== u.newVersion) {
      await new Promise(r => setTimeout(r, 5000));
      try { boxVersion = String(JSON.parse(spawnSync("docker", ["exec", "-u", "vyre", "vyre-vyre-1", "vyre", "call", "system.info", "{}"], { encoding: "utf8", timeout: 20_000 }).stdout || "{}").version || ""); } catch { boxVersion = ""; }
    }
    console.log(`update: the box says ${boxVersion || "nothing"}; the app reconnects with the session it already holds`);
    try { const s = await within(60_000, async () => { await mac.reconnect(); return mac.callTool("update.status"); }); if (s.current === u.newVersion) st = s; else last = `still ${s.current}`; }
    catch (e) { last = String(/** @type {Error} */ (e).message).slice(0, 200); }
    console.log(`update: the reconnect: ${st ? "the same session answered" : last}`);
    if (!st) {
      // what the host and the box say, so a stall names its step
      const sh = (/** @type {string} */ c) => { try { return String(spawnSync("sh", ["-c", c], { encoding: "utf8", timeout: 30_000 }).stdout || ""); } catch { return ""; } };
      const op = (/** @type {string} */ tool, /** @type {string} */ input = "{}") => sh(`docker exec -u vyre vyre-vyre-1 vyre call ${tool} '${input}' 2>&1 | head -c 2500`);
      let devId = ""; try { devId = String(JSON.parse(op("relay.devices.list")).devices[0].id); } catch { /* unlisted */ }
      const logs = "docker exec -u vyre vyre-vyre-1 sh -c 'for f in ~/.vyre/logs/*; do tail -n 400 \"$f\"; done' 2>&1";
      const diag = ["== box says", boxVersion, "== wink.device.paired", op("wink.device.paired"), "== relay.devices.list", op("relay.devices.list"), `== wink.device.record ${devId}`, op("wink.device.record", JSON.stringify({ id: devId })),
        "== DEBUG lines (pair-challenge, renewGrant)", sh(`${logs} | grep DEBUG | tail -14`), "== relay and pairing log lines", sh(`${logs} | grep -i 'relay\\|device\\|denied\\|refus\\|pair' | tail -40`),
        "== update status.json", sh("sudo cat /var/lib/vyre-update/status/status.json 2>&1"), "== docker ps", sh("docker ps -a 2>&1 | head -10")].join("\n");
      fs.writeFileSync(path.join(w.out, "update-diag.txt"), diag);
      console.log(diag);
    }
    assert.ok(st, `the app could not sign in to the server on ${u.newVersion} (box says ${boxVersion || "nothing"}): ${last}`);
    assert.equal(st.current, u.newVersion, "the version changed");
    return `${notice.current} -> ${st.current}`;
  }, { needs: [U("the app asks for the update (update.apply, the Settings button's call)")] });
  const BACK = U("the host's unit installs the candidate and the server comes back as it");
  await replaceStep("after the update, signing in again with the device's own key still replaces the held session", [BACK]);
  await run.step(U("the notice is gone"), async () => {
    // the box can answer on the new version a moment before the host's unit writes its last word ("ok"): wait for it, up to two minutes
    let st = await mac.callTool("update.status");
    for (let i = 0; i < 24 && st.run && st.run.state === "running"; i++) { await new Promise(r => setTimeout(r, 5000)); st = await mac.callTool("update.status"); }
    assert.equal(st.available, null, "no newer version is offered any more");
    assert.deepEqual(st.notes, [], "no notes are left to show");
    assert.ok(!st.pending, "no request is waiting");
    assert.ok(!st.run || st.run.state === "ok", `the host says the run ${st.run && st.run.state}: ${st.run && st.run.message}`);
    return `current ${st.current}, available null`;
  }, { needs: [BACK] });
  await run.step(U("the vault, the records and the app's sign-in are untouched"), async () => {
    // the same pairing (no code, no words, no new owner) opened this session; the owner and the device are the ones from before
    assert.equal(JSON.stringify(mac.pairing.owner), before.owner, "the owner is unchanged");
    const vault = await mac.callTool("vault.list", {}), plan = await mac.callTool("planner.list", {});
    assert.equal(sorted(vault), before.vault, "the vault lists exactly what it listed before");
    assert.equal(sorted(plan), before.plan, "the planner lists exactly what it listed before");
    const info = await mac.callTool("system.info");
    assert.ok(info, "the signed-in app is still answered");
    return "vault, planner and sign-in as before";
  }, { needs: [BACK] });
}
