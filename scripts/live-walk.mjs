#!/usr/bin/env node
// scripts/live-walk.mjs: the install walk against the LIVE services, as a person would do it, on a fresh DigitalOcean droplet.
//   DIGITALOCEAN_TOKEN=... node scripts/live-walk.mjs [--out DIR] [--store auto|sqlite] [--update-to X.Y.Z] [--keep] [--size s-4vcpu-8gb] [--region sfo3]
// Real: vyre.run's names directory (names.vyre.run), the relay (relay.vyre.run), the installer the line runs (vyre.run/i), the droplet. The app side is this repo's headless app (scripts/lib/proof/app.mjs).
// The droplet is destroyed at the end (also on failure) unless --keep. Every step prints its seconds, so a wait shows as a wait. Writes DIR/walk.json (steps, droplet id, hours, cost).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createRun } from "./lib/proof/run.mjs";
import { createApp } from "./lib/proof/app.mjs";

const argv = process.argv.slice(2);
const take = (/** @type {string} */ f, /** @type {string} */ d = "") => { const i = argv.indexOf(f); return i < 0 ? d : argv[i + 1]; };
const out = path.resolve(take("--out", path.join(os.tmpdir(), `live-walk-${Date.now()}`)));
const store = take("--store", "auto"), size = take("--size", "s-4vcpu-8gb"), region = take("--region", "sfo3"), updateTo = take("--update-to", "");
const keep = argv.includes("--keep"), installer = take("--installer", "");   // --installer FILE: run this install-box.sh in place of the one vyre.run serves (a candidate fix, before it is released)
const TOKEN = process.env.DIGITALOCEAN_TOKEN || "";
if (!TOKEN) { console.error("live-walk: DIGITALOCEAN_TOKEN is not set"); process.exit(64); }
const NAMES = "https://names.vyre.run", RELAY = "wss://relay.vyre.run";
fs.mkdirSync(out, { recursive: true });
const run = createRun({ out });

const doApi = async (/** @type {string} */ method, /** @type {string} */ p, /** @type {any} */ body) => {
  const r = await fetch(`https://api.digitalocean.com/v2${p}`, { method, headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const text = await r.text();
  if (!r.ok && !(method === "DELETE" && r.status === 404)) throw new Error(`DigitalOcean ${method} ${p}: ${r.status} ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : {};
};
const keyFile = path.join(out, "walk-key");
const ssh = (/** @type {string} */ ip, /** @type {string} */ cmd, /** @type {number} */ ms = 600_000) => spawnSync("ssh", ["-i", keyFile, "-o", "StrictHostKeyChecking=no", "-o", "UserKnownHostsFile=/dev/null", "-o", "ConnectTimeout=15", "-o", "LogLevel=ERROR", `root@${ip}`, cmd], { encoding: "utf8", timeout: ms });

let droplet = null, keyId = 0, t0 = Date.now(), mac = null;
const report = { steps: /** @type {any[]} */ ([]), droplet: null, hours: 0, costUsd: 0, snags: /** @type {string[]} */ ([]) };
const snag = (/** @type {string} */ s) => { report.snags.push(s); console.log(`SNAG  ${s}`); };
try {
  await run.step("make a fresh droplet (Ubuntu 24.04, 8 GB)", async () => {
    spawnSync("ssh-keygen", ["-t", "ed25519", "-N", "", "-f", keyFile, "-C", "vyre-live-walk"], { stdio: "ignore" });
    const k = await doApi("POST", "/account/keys", { name: `vyre-live-walk-${Date.now()}`, public_key: fs.readFileSync(`${keyFile}.pub`, "utf8").trim() });
    keyId = k.ssh_key.id;
    const d = await doApi("POST", "/droplets", { name: `vyre-live-walk-${new Date().toISOString().slice(0, 10)}`, region, size, image: "ubuntu-24-04-x64", ssh_keys: [keyId], tags: ["vyre-live-walk"] });
    droplet = { id: d.droplet.id, ip: "", price: 0 };
    t0 = Date.now();
    for (let i = 0; i < 60; i++) {
      await new Promise(r => setTimeout(r, 5000));
      const g = (await doApi("GET", `/droplets/${droplet.id}`)).droplet;
      const v4 = (g.networks.v4 || []).find((/** @type {any} */ n) => n.type === "public");
      if (g.status === "active" && v4) { droplet.ip = v4.ip_address; droplet.price = Number(g.size.price_hourly); break; }
    }
    assert.ok(droplet.ip, "the droplet got no address in 5 minutes");
    for (let i = 0; i < 40; i++) { if (ssh(droplet.ip, "true", 20000).status === 0) break; await new Promise(r => setTimeout(r, 5000)); }
    report.droplet = { id: droplet.id, ip: droplet.ip };
    return `droplet ${droplet.id} at ${droplet.ip}`;
  });
  const NEED = ["make a fresh droplet (Ubuntu 24.04, 8 GB)"];

  mac = createApp({ label: "Live-walk Mac", dir: path.join(out, "mac"), directory: NAMES, relay: RELAY });
  const person = `walk${Math.random().toString(36).slice(2, 8)}`;
  /** @type {any} */ let reservation = null, flow = null;
  await run.step("reserve a name on the setup page (live names.vyre.run)", async () => { reservation = await mac.reserve(person); return `${reservation.name}.vyre.run`; });
  await run.step("become yourself in the app (the code is spent)", async () => { const me = await mac.becomeYourself({ name: reservation.name, code: reservation.code }); return `${me.id}`; }, { needs: ["reserve a name on the setup page (live names.vyre.run)"] });
  await run.step("add a server: the app shows the install line", async () => {
    flow = mac.addServer(); await flow.begin(store === "sqlite" ? "plain" : "records");
    return flow.state.installLine.replace(flow.state.code, "<code>");
  }, { needs: ["become yourself in the app (the code is spent)"] });
  let words = "";
  await run.step("run the install line on the droplet (live vyre.run/i)", async () => {
    let line = flow.state.installLine;
    if (installer) {
      const cp = spawnSync("scp", ["-i", keyFile, "-o", "StrictHostKeyChecking=no", "-o", "UserKnownHostsFile=/dev/null", "-o", "LogLevel=ERROR", installer, `root@${droplet.ip}:/root/ib.sh`], { encoding: "utf8" });
      assert.equal(cp.status, 0, `could not copy the installer: ${cp.stderr}`);
      line = line.replace("curl -fsSL vyre.run/i |", "cat /root/ib.sh |");
      assert.ok(line.startsWith("cat /root/ib.sh"), "the install line has the shape the walk expects");
    }
    const started = Date.now();
    let r = ssh(droplet.ip, `export DEBIAN_FRONTEND=noninteractive; ${line} 2>&1`, 25 * 60_000);
    let all = String(r.stdout || "") + String(r.stderr || "");
    if (r.status !== 0 && /Install it with:\s*\n?\s*curl -fsSL https:\/\/get\.docker\.com/.test(all)) {
      // a plain Ubuntu droplet has no Docker: the installer says so and what to run; a person runs that, then the line again
      snag("the installer stops on a plain Ubuntu server because Docker is not installed, and tells the person to install it and run the line again");
      const d0 = Date.now();
      const dk = ssh(droplet.ip, "export DEBIAN_FRONTEND=noninteractive; curl -fsSL https://get.docker.com | sh 2>&1 | tail -5", 15 * 60_000);
      console.log(`docker installed on the droplet in ${Math.round((Date.now() - d0) / 1000)} s (exit ${dk.status})`);
      r = ssh(droplet.ip, `export DEBIAN_FRONTEND=noninteractive; ${line} 2>&1`, 25 * 60_000);
      all = String(r.stdout || "") + String(r.stderr || "");
    }
    fs.writeFileSync(path.join(out, "install.log"), all.replace(/VYRE_CODE=\S+/g, "VYRE_CODE=<hidden>"));
    assert.equal(r.status, 0, `the installer exited ${r.status}: ${all.split("\n").filter(Boolean).slice(-4).join(" | ").slice(0, 400)}`);
    const m = all.match(/Your four words:\s*(?:\x1b\[[0-9;]*m)*([a-z]+(?: [a-z]+){3})/);
    words = m ? m[1] : "";
    if (!words) snag("the installer printed no four words on the terminal");
    return `${Math.round((Date.now() - started) / 1000)} s; words ${words ? "printed" : "not printed"}`;
  }, { needs: ["add a server: the app shows the install line", ...NEED] });
  const INST = "run the install line on the droplet (live vyre.run/i)";
  await run.step("the app finds the server", async () => {
    const s = Date.now();
    await mac.until(() => flow.state.stage === "found" || flow.state.stage === "stopped", 180_000, "the app to find the server");
    assert.equal(flow.state.stage, "found", flow.state.error && flow.state.error.message);
    return `${Math.round((Date.now() - s) / 1000)} s after the installer finished`;
  }, { needs: [INST] });
  await run.step("the four words in the app are the ones the server shows", async () => {
    assert.equal(flow.state.box.words.join(" "), words);
    return words;
  }, { needs: ["the app finds the server"] });
  await run.step("confirm the words in the app: adopt and pair", async () => {
    await flow.confirmWords();
    assert.equal(flow.state.stage, "done", flow.state.error && flow.state.error.message);
    return "paired";
  }, { needs: ["the four words in the app are the ones the server shows"] });
  await run.step("the app reaches the server and calls a tool", async () => {
    await mac.openSession();
    const info = await mac.callTool("system.info");
    assert.ok(info);
    return `version ${info.version}`;
  }, { needs: ["confirm the words in the app: adopt and pair"] });
  const CALL = "the app reaches the server and calls a tool";
  await run.step("the record store (Records) answers", async () => {
    if (store === "sqlite") { const e = new Error("a plain-store walk"); /** @type {any} */ (e).skip = true; throw e; }
    let last = "";
    for (let i = 0; i < 60; i++) { try { await mac.callTool("records.me", {}); return `up after ${i * 10} s`; } catch (e) { last = String(/** @type {Error} */ (e).message); await new Promise(r => setTimeout(r, 10_000)); } }
    throw new Error(`not up after 10 minutes: ${last}`);
  }, { needs: [CALL] });
  /** @type {any} */ let code = null;
  await run.step("Join: a team space on the server (named in the app, signed with the identity)", async () => {
    const team = await mac.createTeamSpace(`team${person.slice(-5)}`);
    return team.name;
  }, { needs: [CALL] });
  await run.step("add a device: the computer shows a code", async () => {
    try { code = await mac.showDeviceCode(); } catch (e) {
      if (/** @type {any} */ (e).code === "presence_required") { snag("add a device asks for a hardware key (Touch ID or a phone's chip): this headless app has a software key, so it cannot be walked here"); const x = new Error(String(/** @type {Error} */ (e).message)); /** @type {any} */ (x).skip = true; throw x; }
      throw e;
    }
    return "a code for the new device";
  }, { needs: [CALL] });
  await run.step("add a device: a second app joins and the first says yes", async () => {
    const phone = createApp({ label: "Live-walk phone", dir: path.join(out, "phone"), directory: NAMES, relay: RELAY, about: { kind: "app" } });
    try {
      /** @type {string[]} */ const shown = [];
      const joining = phone.addThisDeviceToName({ payload: code.qr, onWords: w => shown.push(w) });
      const failed = new Promise((_, rej) => joining.catch(rej)); failed.catch(() => {});
      const ask = /** @type {any} */ (await Promise.race([mac.answerDevice(), failed]));
      await phone.until(() => shown.length, 15_000, "the phone to show its words");
      await mac.sayYes(shown[0].split(" "), ask.raw);
      await mac.serveEnrol();
      const r = await joining;
      assert.equal(r.id, mac.identity.id);
      await phone.openSession();
      assert.ok(await phone.callTool("system.info"));
      return shown[0];
    } finally { phone.close(); }
  }, { needs: ["add a device: the computer shows a code"] });

  // the update, from the app, to a release that ships the fix
  await run.step("the app shows an update notice and asks for the update (Settings button)", async () => {
    let st = null;
    const deadline = Date.now() + 90 * 60_000;
    while (Date.now() < deadline) { st = await mac.callTool("update.status"); if (st.available && (!updateTo || st.available === updateTo)) break; await new Promise(r => setTimeout(r, 60_000)); }
    assert.ok(st && st.available, `no update was offered (current ${st && st.current})`);
    assert.equal(st.canApply, true, "the server takes the request from the app");
    const r = await mac.callTool("update.apply");
    assert.equal(r.requested, true, JSON.stringify(r).slice(0, 200));
    return `${st.current} -> ${st.available}`;
  }, { needs: [CALL] });
  await run.step("the server comes back on the new version, and the same app signs in again", async () => {
    let ver = "";
    const deadline = Date.now() + 15 * 60_000;
    while (Date.now() < deadline && !/^0\.3\.[1-9]/.test(ver)) { await new Promise(r => setTimeout(r, 10_000)); const r = ssh(droplet.ip, "docker exec -u vyre vyre-vyre-1 vyre call system.info '{}' 2>/dev/null", 60000); try { ver = String(JSON.parse(r.stdout || "{}").version || ""); } catch { /* restarting */ } }
    assert.ok(/^0\.3\.[1-9]/.test(ver), `the box says ${ver || "nothing"}`);
    const s = await Promise.race([(async () => { await mac.reconnect(); return mac.callTool("update.status"); })(), new Promise((_, no) => setTimeout(() => no(new Error("no answer in 90 s")), 90_000))]);
    return `box ${ver}; app sees ${s.current}`;
  }, { needs: ["the app shows an update notice and asks for the update (Settings button)"] });
} finally {
  if (mac) mac.close();
  if (droplet && droplet.id) {
    report.hours = Math.max(1, Math.ceil((Date.now() - t0) / 3_600_000));
    report.costUsd = Math.round(report.hours * (droplet.price || 0.071) * 1000) / 1000;
    if (!keep) { try { await doApi("DELETE", `/droplets/${droplet.id}`); console.log(`destroyed droplet ${droplet.id}`); } catch (e) { console.log(`COULD NOT DESTROY droplet ${droplet.id}: ${/** @type {Error} */ (e).message}`); } }
  }
  if (keyId) { try { await doApi("DELETE", `/account/keys/${keyId}`); } catch { /* the key is the walk's own */ } }
  report.steps = run.results;
  fs.writeFileSync(path.join(out, "walk.json"), JSON.stringify(report, null, 2));
}
process.exit(run.finish());
