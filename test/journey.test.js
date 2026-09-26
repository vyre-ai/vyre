// @ts-check
// The install journey end to end (ADR 0008): a fresh Mac and a fresh Linux server, both temp homes
// on this machine (test/journey/rig.js), with fake ssh, docker, tailscale, claude and browser.
// The vyred on each side is real, and so are `vyre box add`, `vyre up`, the installer, the host
// wrapper and the onboarding page. Scenarios 1, 2 and 6 share one pair of machines, in order.
//
// Where the product does not yet do what ADR 0008 says, the check stays here as a todo subtest
// naming the gap, so it turns green (and says so) the day the product catches up.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { makeRig, browser, until, TARGET, TS_NAME } from "./journey/rig.js";
import { ending } from "../core/cli/ending.js";

/** @type {Awaited<ReturnType<typeof makeRig>> | null} */
let shared = null;
/** Set when install-box.sh cannot run as shipped, so later scenarios say why they lay the stack. */
let installerBlocked = "";
const INSTALL_RUN = /^(-o \S+ )*\S+@\S+ env .*sh \/\S+ --yes$/;

test.after(async () => { if (shared) await shared.close(); });

const tail = f => { try { return fs.readFileSync(f, "utf8").split("\n").slice(-30).join("\n"); } catch { return "(nothing)"; } };

/** The installer's own failure line, when the box add output says it stopped. */
const installerWhy = out => (out.match(/^.*(No such file|not a checksum list|has no line for|checksum mismatch|curl: \(\d+\)).*$/m) || [""])[0].trim();

test("journey 1, door A: box add installs, the browser onboards, the Mac ends ready", async t => {
  const rig = shared = await makeRig();
  let run = rig.mac(["box", "add", TARGET, "--yes"]);
  // On a failure, say what the Mac printed and what the box's vyred logged.
  let ok = false;
  t.after(() => {
    if (ok) return;
    t.diagnostic(`box add printed:\n${run.output()}`);
    t.diagnostic(`the box's vyred:\n${tail(path.join(rig.root, "srv", "vyred.out"))}`);
  });
  // The Mac waits with the link open in the browser, or stops early if the installer failed.
  let first = await Promise.race([until(() => rig.opened()[0], Boolean, 40_000, "box add to open the browser"), run.done]);
  if (typeof first !== "string") {
    const why = installerWhy(first.out);
    assert.match(first.out, /the installer stopped/, `box add stopped before the browser:\n${first.out}`);
    installerBlocked = `scripts/install-box.sh cannot install from ${rig.env.server.VYRE_BOX_URL}: ${why}`;
    t.todo(installerBlocked);
    t.diagnostic(installerBlocked);
    assert.ok(!fs.existsSync(path.join(rig.env.server.VYRE_DIR, "compose.yml")), "a failed install left no half stack");
    rig.layStack();
    run = rig.mac(["box", "add", TARGET, "--yes"]);
    first = await Promise.race([until(() => rig.opened()[0], Boolean, 40_000, "box add to open the browser"), run.done]);
    assert.equal(typeof first, "string", `box add stopped on the laid stack:\n${/** @type {any} */ (first).out}`);
  }
  const url = /** @type {string} */ (first);
  assert.match(url, new RegExp(`^http://127\\.0\\.0\\.1:${rig.onboardPort}/onboard\\?t=[A-Za-z0-9_-]{40,}$`), "the box's own onboarding port, same number on the Mac");
  assert.ok(rig.ssh().some(l => l.includes(`-O forward -L ${rig.onboardPort}:127.0.0.1:${rig.onboardPort} ${TARGET}`)), "the tunnel rides the held connection");

  // ---- the browser ----
  const b = await browser(url);
  assert.equal(b.status, 302);
  assert.match(b.location, /^\/onboard#s=/);
  const you = await b.tool("onboard.you", { name: "Alex", assistant: "Juno" });
  assert.equal(you.state, "done");

  // Claude: the subscription sign-in under a pty when there is one, else an API key.
  if (rig.python3) {
    const started = await b.tool("onboard.claude", { mode: "setup-token" });
    assert.match(String(started.url), /^https:\/\/claude\.com\/cai\/oauth\/authorize\?/);
    const signed = await b.tool("onboard.claude", { mode: "setup-token", code: "good-code" });
    assert.equal(signed.signedIn, true);
    assert.equal(signed.via, "setup-token");
  } else {
    t.diagnostic("no python3 for the pty relay: Claude signs in with an API key instead");
    const signed = await b.tool("onboard.claude", { mode: "api-key", key: "sk-ant-api03-" + "x".repeat(40) });
    assert.equal(signed.signedIn, true);
  }

  // Tailscale: Connect shows the login link; the person signs in; the step sees Running.
  const connect = await b.tool("onboard.tailscale", { action: "connect" });
  assert.equal(connect.state, "needs-login", JSON.stringify(connect));
  assert.match(String(connect.loginUrl), /^https:\/\/login\.tailscale\.com\/a\//);
  rig.boxSignedIn();
  await until(() => b.tool("onboard.tailscale", { action: "status" }), s => s.state === "connected", 25_000, "Tailscale to connect");

  // The address: ts.net by default. The fake tailnet puts the node on 127.0.0.1, so the real
  // tailnet listener binds here, with the certificate `tailscale cert` hands back.
  let address = null;
  if (rig.cert && !process.env.JOURNEY_SKIP_NAME) {
    const reserve = await b.tool("onboard.name", { action: "reserve" });
    assert.equal(reserve.via, "ts.net");
    const served = await until(() => b.tool("onboard.name", { action: "status" }), s => s.state === "done" || s.state === "blocked", 30_000, "the address to serve");
    assert.equal(served.state, "done", JSON.stringify(served));
    address = served.url;
    assert.equal(address, `https://${TS_NAME}:${rig.tailnetPort}`);
  } else {
    t.diagnostic(rig.cert ? "JOURNEY_SKIP_NAME: the address step is skipped" : "no openssl to make a certificate: the address step is skipped");
    await b.tool("onboard.skip", { step: "name" });
  }
  // History: a fresh box has no sessions, so the step is already done and indexes nothing.
  const status = await b.tool("onboard.status");
  assert.equal(status.steps.history, "done");
  const fin = await b.tool("onboard.finish");
  assert.ok(fin.finished);
  assert.equal(fin.owner, "alex@example.com", "the login that signed the box in owns it");

  // ---- the Mac ----
  const { code, out } = await run.done;
  assert.equal(code, 0, out);
  assert.match(out, new RegExp(`reaching ${TARGET}`));
  assert.match(out, /Docker Compose 2\.29\.0/);
  if (!installerBlocked) {
    assert.match(out, new RegExp(`Vyre will, on ${TARGET}:`));
    assert.match(out, /the stack goes in /, "the installer's own output is shown");
    assert.equal(rig.ssh().filter(l => INSTALL_RUN.test(l)).length, 1, "the installer ran once, with --yes");
  }
  assert.match(out, /Finish in your browser\. I'll wait here\./);
  for (const label of ["You", "Claude Code", "Tailscale", "Your history"]) assert.match(out, new RegExp(`^  ${label}\\s+done$`, "m"), label);
  assert.equal(out.match(/^ {2}Claude Code\s+done$/gm)?.length, 1, "each step is said once");
  assert.ok(rig.ssh().some(l => / -O cancel -L /.test(l)), "the tunnel is closed at the end");

  const c = rig.macConfig();
  assert.equal(c.box?.ssh, TARGET);
  if (address) {
    assert.match(out, /^ {2}Your address\s+done$/m);
    assert.ok(out.includes(ending({ address, assistant: "Juno" }).join("\n")), out);
    assert.equal(c.network?.box, address);
  } else {
    // ADR 0008 section 6: the ending is the same everywhere; with the address pending it says so.
    assert.ok(out.includes(ending({ address: null, assistant: "Juno" }).join("\n")), out);
  }
  ok = true;
});

test("journey 2, door A resumed: box add again skips the install and finishes", async t => {
  const rig = shared;
  if (!rig) { t.skip("journey 1 did not set the machines up"); return; }
  const before = rig.ssh().length, opened = rig.opened().length;
  const { code, out } = await rig.mac(["box", "add", TARGET], { timeout: 40_000 }).done;
  assert.equal(code, 0, out);
  assert.match(out, new RegExp(`Vyre is already on ${TARGET}; carrying on from where it stands\\.`));
  const calls = rig.ssh().slice(before);
  assert.ok(!calls.some(l => INSTALL_RUN.test(l)), `no second installer run:\n${calls.join("\n")}`);
  assert.ok(!calls.some(l => / cat > /.test(l)), "the installer was not even copied over");
  assert.doesNotMatch(out, /Go ahead\?|nothing changed/, "a resume asks nothing");
  assert.match(out, /^ {2}Vyre is ready\.$/m);

  await t.test("a finished box does not send the person back to the onboarding page", { todo: "onboard.link keys on network.ownerSeen, not onboard.finished: core/onboard/index.js:269 mints a fresh link after finish, so box add (core/cli/commands/box.js:281) opens a tunnel and the browser again" }, () => {
    assert.equal(rig.opened().length, opened, "no second browser open");
    assert.doesNotMatch(out, /Finish in your browser/);
  });
});

test("journey 3, door A refused: no --yes and no terminal prints the plan and touches nothing", async () => {
  const rig = await makeRig();
  try {
    const { code, out } = await rig.mac(["box", "add", TARGET], { timeout: 30_000 }).done;
    assert.equal(code, 1, out);
    assert.match(out, new RegExp(`Vyre will, on ${TARGET}:`));
    assert.match(out, /use the Docker already there \(Compose 2\.29\.0\)/);
    assert.match(out, new RegExp(`create ${rig.env.server.VYRE_DIR.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} and put Vyre's stack in it`));
    assert.match(out, /add \/usr\/local\/bin\/vyre/);
    assert.match(out, /nothing changed\. Run it in a terminal to answer, or add --yes\./);
    assert.equal(fs.existsSync(rig.env.server.VYRE_DIR), false, "no stack folder");
    assert.equal(fs.existsSync(rig.env.server.VYRE_WRAPPER), false, "no wrapper");
    assert.ok(!rig.ssh().some(l => / cat > /.test(l) || INSTALL_RUN.test(l)), "the installer never went over");
    assert.deepEqual(rig.docker().filter(l => !/^(compose version|info)\b/.test(l)), [], "docker was only asked, never told");
    assert.equal(rig.opened().length, 0);
  } finally { await rig.close(); }
});

test("journey 4, door B: the installer on the server prints the link and the ssh line; the Mac looks for the box", async t => {
  const rig = await makeRig();
  try {
    // ---- on the server, in its own shell over SSH ----
    let r = await rig.server(`sh ${JSON.stringify(rig.installer)} --yes`, { timeout: 40_000 }).done;
    if (r.code !== 0) {
      const why = installerWhy(r.out) || r.out.trim().split("\n").pop();
      t.todo(`scripts/install-box.sh cannot install from ${rig.env.server.VYRE_BOX_URL}: ${why}`);
      rig.layStack();
      // What the installer's last step runs.
      r = await rig.server(`env VYRE_DIR=${rig.env.server.VYRE_DIR} ${rig.env.server.VYRE_WRAPPER} up`, { timeout: 40_000 }).done;
    }
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /Open this link to set up Vyre/);
    assert.match(r.out, new RegExp(`^ {4}http://127\\.0\\.0\\.1:${rig.onboardPort}/onboard\\?t=\\S+$`, "m"));
    assert.match(r.out, /This box is headless\. On your own computer, run this first, then open the link there:/);
    assert.match(r.out, new RegExp(`^ {4}ssh -N -L ${rig.onboardPort}:127\\.0\\.0\\.1:${rig.onboardPort} alex@203\\.0\\.113\\.4$`, "m"), "the host's account, not the container's");
    assert.ok(rig.docker().includes("compose up -d"), "the wrapper started the stack");

    // ---- later, on the Mac: the box has joined the tailnet ----
    rig.boxSignedIn();
    const m = await rig.mac(["up", "--json"], { timeout: 30_000 }).done;
    assert.equal(m.code, 0, m.out);
    const j = JSON.parse(m.out.trim().split("\n").pop() || "");
    assert.equal(j.role, "local");
    // The peer is found, but its ts.net name does not resolve here and it has no answering TLS:
    // the probe fails and nothing is saved, so the Mac falls back to "no box yet".
    assert.equal(j.box, null);
    assert.equal(j.ready, false);
    assert.equal(rig.macConfig().network?.box, undefined, "nothing unconfirmed is saved");
    assert.ok(fs.readFileSync(rig.log.tailscale, "utf8").includes("mac status --json"), "it read the Mac's tailnet");

    await t.test("--json says a Vyre peer was seen but did not answer", { todo: "core/cli/commands/up.js:115 discover() drops peers whose probe fails, and up.js:202 prints box:null with no candidates or reason, so a caller cannot tell 'no box' from 'box unreachable'" }, () => {
      assert.match(JSON.stringify(j), new RegExp(TS_NAME.replace(/\./g, "\\.")));
    });
  } finally { await rig.close(); }
});

test("journey 5, door A on a signed-out Mac: box add stops before touching the server", async () => {
  const rig = await makeRig({ mac: "signed-out" });
  try {
    const { code, out } = await rig.mac(["box", "add", TARGET, "--yes"], { timeout: 20_000 }).done;
    assert.equal(code, 1, out);
    assert.match(out, /Tailscale is signed out: open Tailscale and sign in/);
    assert.deepEqual(rig.ssh(), [], "ssh never ran");
    assert.equal(fs.existsSync(rig.env.server.VYRE_DIR), false);
  } finally { await rig.close(); }
});

test("journey 6, after onboarding: vyre up --json on the server", async t => {
  const rig = shared;
  if (!rig) { t.skip("journey 1 did not set the machines up"); return; }
  const wrapper = `env VYRE_DIR=${rig.env.server.VYRE_DIR} ${rig.env.server.VYRE_WRAPPER}`;
  const upJson = async () => {
    const r = await rig.server(`${wrapper} up --json`, { timeout: 40_000 }).done;
    assert.equal(r.code, 0, r.out);
    return JSON.parse(r.out.trim().split("\n").pop() || "");
  };
  const address = rig.boxConfig().network?.address || null;
  const after = await upJson();
  assert.equal(after.role, "box");
  assert.equal(after.address, address);

  await t.test("right after onboard.finish, url is null", { todo: "core/onboard/index.js:269 returns url null only once network.ownerSeen is set (the owner reached the tailnet listener); a finished onboarding still mints a link" }, () => {
    assert.equal(after.url, null);
  });

  // The owner reaching the box over the tailnet is what closes the door today. That needs a
  // tailnet source address, which this machine cannot fake, so write what it would have saved.
  assert.equal((await rig.server(`cd ${rig.env.server.VYRE_DIR} && docker compose stop`, { timeout: 20_000 }).done).code, 0);
  const cfg = rig.boxConfig();
  fs.writeFileSync(path.join(rig.env.container.VYRE_HOME, "config.json"), JSON.stringify({ ...cfg, network: { ...cfg.network, ownerSeen: new Date().toISOString() } }));
  const seen = await upJson();
  assert.equal(seen.url, null);
  assert.equal(seen.port, null);
  assert.equal(seen.ssh, null);
  assert.equal(seen.address, address);
  assert.equal(typeof seen.ready, "boolean");

  await t.test("ready is true when the box serves its address", { todo: "core/cli/commands/up.js:216 probes the box's own address from inside the box; its tailnet listener refuses a caller from this box itself (core/names/identity.js, 'from this box itself'), and with --accept-dns=false the container may not resolve its ts.net name, so ready can never be true on a box" }, () => {
    assert.equal(seen.ready, true);
  });
});
