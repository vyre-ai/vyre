// @ts-check
// agentd's plans: what would run inside the computer, checked without a container. The properties that matter are the ones isolation depends on.

import "../../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { planCreate, planStartScreen, planStopScreen, planWipeHome, planRemove, asAgent, execute, tolerant, homeOf } from "./agentd.js";

const U = { user: "ag20000", uid: 20000, display: 20 };
const flat = steps => steps.map(s => s.join(" "));

test("a new agent's home and run folder were made at image build; adding one only checks them, as the agent, and changes no owner", () => {
  const steps = flat(planCreate(U));
  assert.ok(!steps.some(x => /useradd|groupadd|chown/.test(x)), "agentd never adds a user or chowns: it has no capability to");
  assert.ok(steps.every(x => x.startsWith("setpriv --reuid=20000 --regid=20000")), "every step runs as the agent");
  assert.ok(steps.some(x => x.endsWith("chmod 0700 /home/ag20000 /var/lib/vyre/agents/ag20000")));
});

test("every agent process runs through setpriv as that uid: no capabilities, no new privileges, no groups, limited", () => {
  for (const argv of planStartScreen(U)) {
    const s = argv.join(" ");
    assert.match(s, /^setpriv --reuid=20000 --regid=20000 --clear-groups --inh-caps=-all --no-new-privs -- prlimit --as=\d+ --nproc=\d+ nice -n 5 /);
  }
  assert.deepEqual(asAgent(U).slice(0, 2), ["setpriv", "--reuid=20000"]);
});

test("the screen is its own display and VNC port, the password is a file in the agent's own folder and never on the command line", () => {
  const [xvnc, wm, chrome] = planStartScreen(U);
  const s = xvnc.join(" ");
  assert.match(s, / Xvnc :20 /);
  assert.match(s, /-rfbport 5920 /);
  assert.match(s, /-rfbauth \/var\/lib\/vyre\/agents\/ag20000\/vnc\.pass/);
  assert.doesNotMatch(planStartScreen(U).flat().join(" "), /password=|-passwd/i);
  assert.match(wm.join(" "), /DISPLAY=:20 fluxbox/);
  assert.match(chrome.join(" "), /--user-data-dir=\/home\/ag20000\/\.chrome/);
});

test("two agents get two displays, ports and profiles that never overlap", () => {
  const B = { user: "ag20001", uid: 20001, display: 21 };
  const a = planStartScreen(U).flat().join(" "), b = planStartScreen(B).flat().join(" ");
  assert.match(a, /-rfbport 5920/); assert.match(b, /-rfbport 5921/);
  assert.doesNotMatch(a, /ag20001|:21|20001/); assert.doesNotMatch(b, /ag20000|:20 |20000/);
});

test("sleeping signals as the agent, only its uid, and never its tmux server", () => {
  const steps = planStopScreen(U);
  assert.ok(steps.every(x => x.join(" ").startsWith("setpriv --reuid=20000 ") && x.includes("pkill") && x.includes("-u") && x.includes("20000") && x.includes("-x")));
  assert.deepEqual(steps.map(x => x[x.length - 1]), ["chromium", "fluxbox", "Xvnc"]);
  assert.ok(!steps.flat().includes("tmux"));
});

test("reset empties the home as the agent and keeps the folder and its mode; it names no other path", () => {
  const steps = planWipeHome(U);
  assert.ok(steps.every(x => x.join(" ").startsWith("setpriv --reuid=20000 --regid=20000 --clear-groups")));
  assert.deepEqual(steps.map(x => x.slice(x.indexOf("nice") + 3).join(" ")), ["-n 5 pkill -KILL -u 20000", "-n 5 find /home/ag20000 -mindepth 1 -delete", "-n 5 chmod 0700 /home/ag20000"]);
});

test("remove empties exactly its home and run folder as the agent and leaves the image user", () => {
  const last = planRemove(U).pop() || [];
  assert.deepEqual(last.slice(last.indexOf("find")), ["find", "/home/ag20000", "/var/lib/vyre/agents/ag20000", "-mindepth", "1", "-delete"]);
});

test("a user name, uid or display outside the agent ranges is refused before anything runs", () => {
  for (const bad of [{ ...U, user: "root" }, { ...U, user: "ag../x" }, { ...U, user: "ag a" }, { ...U, uid: 1000 }, { ...U, uid: 20000.5 }, { ...U, display: 1 }, { ...U, display: 9999 }]) {
    assert.throws(() => planCreate(bad), /not an agent|below the agent range|not an agent display/, JSON.stringify(bad));
    assert.throws(() => planWipeHome(bad));
  }
  assert.equal(homeOf("ag20000"), "/home/ag20000");
});

test("a step fails the plan unless it is one that may fail (stopping what is not running)", async () => {
  /** @type {string[]} */ const ran = [];
  const name = argv => argv[argv.indexOf("nice") + 3];
  const run = async argv => { ran.push(name(argv)); if (name(argv) === "pkill") throw new Error("nothing to kill"); };
  await execute(planWipeHome(U), run, { tolerate: tolerant });
  assert.deepEqual(ran, ["pkill", "find", "chmod"]);
  await assert.rejects(() => execute(planWipeHome(U), async argv => { if (argv.includes("find")) throw new Error("disk"); }, { tolerate: tolerant }), /disk/);
});
