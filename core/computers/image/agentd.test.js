// @ts-check
// agentd's plans: what would run inside the computer, checked without a container. The properties that matter are the ones isolation depends on.

import "../../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { planCreate, planStartScreen, planStopScreen, planWipeHome, planRemove, asAgent, execute, tolerant, homeOf } from "./agentd.js";

const U = { user: "agads", uid: 20000, display: 20 };
const flat = steps => steps.map(s => s.join(" "));

test("a new agent's home is its own and private (0700, owned by its uid)", () => {
  const steps = flat(planCreate(U));
  assert.ok(steps.includes("chmod 0700 /home/agads /run/agents/agads"));
  assert.ok(steps.includes("chown 20000:20000 /home/agads /run/agents/agads"));
  assert.ok(steps.some(s => s.startsWith("useradd -M -u 20000 -g 20000") && !/-G /.test(s)), "no extra groups: it shares nothing with another agent");
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
  assert.match(s, /-rfbauth \/run\/agents\/agads\/vnc\.pass/);
  assert.doesNotMatch(planStartScreen(U).flat().join(" "), /password=|-passwd/i);
  assert.match(wm.join(" "), /DISPLAY=:20 fluxbox/);
  assert.match(chrome.join(" "), /--user-data-dir=\/home\/agads\/\.chrome/);
});

test("two agents get two displays, ports and profiles that never overlap", () => {
  const B = { user: "agkit", uid: 20001, display: 21 };
  const a = planStartScreen(U).flat().join(" "), b = planStartScreen(B).flat().join(" ");
  assert.match(a, /-rfbport 5920/); assert.match(b, /-rfbport 5921/);
  assert.doesNotMatch(a, /agkit|:21|20001/); assert.doesNotMatch(b, /agads|:20 |20000/);
});

test("sleeping signals only this agent's uid and never its tmux server", () => {
  const steps = planStopScreen(U);
  assert.ok(steps.every(s => s[0] === "pkill" && s.includes("-u") && s.includes("20000") && s.includes("-x")));
  assert.deepEqual(steps.map(s => s[s.length - 1]), ["chromium", "fluxbox", "Xvnc"]);
  assert.ok(!steps.flat().includes("tmux"));
});

test("reset empties the home and keeps the folder, its owner and its mode; it names no other path", () => {
  const steps = flat(planWipeHome(U));
  assert.deepEqual(steps, ["pkill -KILL -u 20000", "find /home/agads -mindepth 1 -delete", "chown 20000:20000 /home/agads", "chmod 0700 /home/agads"]);
});

test("remove deletes the user and exactly its home and run folder", () => {
  assert.deepEqual(flat(planRemove(U)), ["pkill -KILL -u 20000", "userdel agads", "rm -rf --one-file-system /home/agads /run/agents/agads"]);
});

test("a user name, uid or display outside the agent ranges is refused before anything runs", () => {
  for (const bad of [{ ...U, user: "root" }, { ...U, user: "ag../x" }, { ...U, user: "ag a" }, { ...U, uid: 1000 }, { ...U, uid: 20000.5 }, { ...U, display: 1 }, { ...U, display: 9999 }]) {
    assert.throws(() => planCreate(bad), /not an agent|below the agent range|not an agent display/, JSON.stringify(bad));
    assert.throws(() => planWipeHome(bad));
  }
  assert.equal(homeOf("agads"), "/home/agads");
});

test("a step fails the plan unless it is one that may fail (stopping what is not running)", async () => {
  /** @type {string[]} */ const ran = [];
  const run = async argv => { ran.push(argv[0]); if (argv[0] === "pkill") throw new Error("nothing to kill"); };
  await execute(planWipeHome(U), run, { tolerate: tolerant });
  assert.deepEqual(ran, ["pkill", "find", "chown", "chmod"]);
  await assert.rejects(() => execute(planWipeHome(U), async argv => { if (argv[0] === "find") throw new Error("disk"); }, { tolerate: tolerant }), /disk/);
});
