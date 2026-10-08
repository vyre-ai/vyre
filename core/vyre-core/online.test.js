// @ts-check
// core/vyre-core/online.js: the Mac server's always-online rules, on any host (the commands are a seam).
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { POWER, parsePmset, powerDrift, pmsetArgs, ensurePower, fileVault, FILEVAULT_NOTICE, authRestartSupported, plannedRestartCommand, bootCheck, bootProblem } from "./online.js";

const PMSET_G = (o = {}) => `System-wide power settings:\nCurrently in use:\n standby              1\n Sleep On Power Button 1\n autorestart          ${o.autorestart ?? 0}\n powernap             ${o.powernap ?? 1}\n networkoversleep     0\n disksleep            ${o.disksleep ?? 10}\n sleep                ${o.sleep ?? 1} (sleep prevented by powerd)\n ttyskeepawake        1\n displaysleep         10\n womp                 ${o.womp ?? 0}\n`;

test("pmset -g is read for the five settings, the first number after the name, and nothing else", () => {
  assert.deepEqual(parsePmset(PMSET_G()), { autorestart: "0", powernap: "1", disksleep: "10", sleep: "1", womp: "0" });
  assert.deepEqual(parsePmset(""), {});
  assert.equal(parsePmset(" displaysleep 10\n standby 1").displaysleep, undefined, "the display may sleep: it is not one of ours");
});

test("drift is what differs; a setting the Mac does not show is not drift", () => {
  assert.deepEqual(powerDrift(parsePmset(PMSET_G())).map(d => d.key).sort(), ["autorestart", "disksleep", "powernap", "sleep", "womp"]);
  assert.deepEqual(powerDrift(parsePmset(PMSET_G(POWER))), []);
  assert.deepEqual(powerDrift({ autorestart: "1", sleep: "0" }), []);
  assert.deepEqual(pmsetArgs(), ["-a", "autorestart", "1", "sleep", "0", "disksleep", "0", "womp", "1", "powernap", "0"]);
});

test("ensurePower sets what drifted once, reads again, and says what is still wrong", () => {
  let state = {}; const calls = [];
  const run = (cmd, args) => { calls.push(args.join(" ")); if (args[0] === "-g") return PMSET_G(state); if (args[0] === "-a") { state = { ...POWER }; return ""; } return ""; };
  const r = ensurePower(run);
  assert.deepEqual(r, { changed: true, drift: [] });
  assert.equal(calls.filter(c => c.startsWith("-a")).length, 1);
  assert.deepEqual(ensurePower(run), { changed: false, drift: [] }, "a second run changes nothing");
  // a Mac that refuses (an MDM profile): the drift is reported, not hidden
  const stubborn = (cmd, args) => (args[0] === "-g" ? PMSET_G({ ...POWER, sleep: 1 }) : "");
  assert.deepEqual(ensurePower(stubborn).drift.map(d => d.key), ["sleep"]);
});

test("FileVault: on, off, and unknown are three answers, and unknown is never read as off", () => {
  assert.equal(fileVault(() => "FileVault is On.\n"), "on");
  assert.equal(fileVault(() => "FileVault is Off.\n"), "off");
  assert.equal(fileVault(() => { throw new Error("no fdesetup"); }), "unknown");
  assert.equal(fileVault(() => "something else"), "unknown");
  assert.match(FILEVAULT_NOTICE, /FileVault is on\. After a power cut or a restart this Mac will wait for someone to type the password, and Vyre will be offline until then\. For a server, turn FileVault off in System Settings, Privacy and Security, then run this line again\. To keep FileVault anyway, run the line with VYRE_ACCEPT_FILEVAULT=1\./);
});

test("a planned restart uses authrestart only when FileVault is on and it is supported", () => {
  const mk = (fv, sup) => (cmd, args) => (args[0] === "status" ? `FileVault is ${fv}.` : args[0] === "supportsauthrestart" ? String(sup) : "");
  assert.deepEqual(plannedRestartCommand(mk("On", true)), { cmd: "/usr/bin/fdesetup", args: ["authrestart"] });
  assert.equal(plannedRestartCommand(mk("On", false)).cmd, "/sbin/shutdown");
  assert.equal(plannedRestartCommand(mk("Off", true)).cmd, "/sbin/shutdown");
  assert.equal(authRestartSupported(() => "true\n"), true);
  assert.equal(authRestartSupported(() => { throw new Error("x"); }), false);
});

test("the boot test needs the daemon loaded, RunAtLoad and a KeepAlive", () => {
  const ok = { RunAtLoad: true, KeepAlive: true };
  const run = (loaded, plist) => (cmd, args) => { if (cmd.endsWith("launchctl")) { if (!loaded) throw new Error("not loaded"); return ""; } return plist === undefined ? "not json" : JSON.stringify(plist); };
  assert.deepEqual(bootCheck(run(true, ok), "com.vyre.vyred", "/p"), { label: "com.vyre.vyred", loaded: true, runAtLoad: true, keepAlive: true });
  assert.equal(bootCheck(run(true, { RunAtLoad: true, KeepAlive: { SuccessfulExit: false } }), "x", "/p").keepAlive, true, "a KeepAlive rule counts");
  assert.match(bootProblem(bootCheck(run(false, ok), "com.vyre.vyred", "/p")), /not loaded/);
  assert.match(bootProblem(bootCheck(run(true, { KeepAlive: true }), "com.vyre.vyred", "/p")), /does not start at boot/);
  assert.match(bootProblem(bootCheck(run(true, { RunAtLoad: true }), "com.vyre.vyred", "/p")), /not restarted/);
  // plutil cannot read it: the dict the installer wrote decides
  assert.equal(bootProblem(bootCheck(run(true, undefined), "x", "/p", ok)), "");
  assert.equal(bootProblem(bootCheck(() => "", "x", "/p", ok)), "");
});
