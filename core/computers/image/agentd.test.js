// @ts-check
// agentd's plans: what would run inside the computer, checked without a container. The properties that matter are the ones isolation depends on.

import "../../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { planCreate, planStartScreen, planStopScreen, planWipeHome, planRemove, asAgent, execute, tolerant, homeOf, socketOf } from "./agentd.js";

const U = { user: "ag20000", uid: 20000, display: 20 };
const B = { user: "ag20001", uid: 20001, display: 21 };
const flat = steps => steps.map(s => s.join(" "));
const WRAP = /^\/usr\/bin\/setpriv --reuid=(\d+) --regid=\1 --clear-groups --inh-caps=-all --ambient-caps=-all --bounding-set=-all --no-new-privs -- \/usr\/bin\/prlimit --as=\d+ --nproc=\d+ \/usr\/bin\/nice -n 5 \/usr\/bin\/env -i /;

test("a new agent's home and run folder were made at image build; adding one only checks them, as the agent, and changes no owner", () => {
  const steps = flat(planCreate(U));
  assert.ok(!steps.some(x => /useradd|groupadd|chown/.test(x)), "agentd never adds a user or chowns: it has no capability to");
  assert.ok(steps.every(x => x.startsWith("/usr/bin/setpriv --reuid=20000 --regid=20000")), "every step runs as the agent");
  assert.ok(steps.some(x => x.endsWith("/usr/bin/chmod 0700 /home/ag20000 /var/lib/vyre/agents/ag20000")));
});

test("every agent process runs through setpriv as that uid, with absolute paths: no groups, every capability set emptied, no new privileges, limited, and an environment built from nothing", () => {
  for (const argv of [...planStartScreen(U), ...planCreate(U), ...planStopScreen(U), ...planWipeHome(U), ...planRemove(U)]) {
    const s = argv.join(" ");
    assert.match(s, WRAP, s);
    assert.ok(argv[0].startsWith("/") && argv.every((a, i) => i === 0 || !/^(setpriv|prlimit|nice|env)$/.test(a)), "no binary is looked up by PATH");
  }
  const env = asAgent(U, {}, { DISPLAY: ":20" }).join(" ");
  assert.match(env, /\/usr\/bin\/env -i HOME=\/home\/ag20000 USER=ag20000 LOGNAME=ag20000 PATH=\/usr\/local\/bin:\/usr\/bin:\/bin LANG=C\.UTF-8 DISPLAY=:20$/);
});

test("the screen is its own display on a unix socket (no TCP port), the password is a file in the agent's own folder and never on the command line", () => {
  const [xvnc, wm, chrome] = planStartScreen(U);
  const s = xvnc.join(" ");
  assert.match(s, / \/usr\/bin\/Xvnc :20 /);
  assert.match(s, /-rfbport -1 -rfbunixpath \/var\/lib\/vyre\/agents\/ag20000\/vnc\.sock -rfbunixmode 0600/);
  assert.match(s, /-rfbauth \/var\/lib\/vyre\/agents\/ag20000\/vnc\.pass/);
  assert.equal(socketOf(U), "/var/lib/vyre/agents/ag20000/vnc.sock");
  assert.doesNotMatch(planStartScreen(U).flat().join(" "), /password=|-passwd/i);
  assert.match(wm.join(" "), /DISPLAY=:20 \/usr\/bin\/fluxbox$/);
  assert.match(chrome.join(" "), /--user-data-dir=\/home\/ag20000\/\.chrome/);
});

test("the long-running steps are marked in the plan, and the others are not", () => {
  const [xvnc, wm, chrome] = planStartScreen(U);
  for (const step of [xvnc, wm, chrome]) assert.equal(/** @type {any} */ (step).detach, true);
  for (const step of [...planStopScreen(U), ...planWipeHome(U), ...planCreate(U), ...planRemove(U)]) assert.equal(/** @type {any} */ (step).detach, undefined, step.join(" "));
});

test("two agents get two displays, sockets and profiles that never overlap", () => {
  const a = planStartScreen(U).flat().join(" "), b = planStartScreen(B).flat().join(" ");
  assert.match(a, /ag20000\/vnc\.sock/); assert.match(b, /ag20001\/vnc\.sock/);
  assert.doesNotMatch(a, /ag20001|:21 |=20001/); assert.doesNotMatch(b, /ag20000|:20 |=20000/);
});

test("sleeping signals as the agent, only its uid, and never its tmux server", () => {
  const steps = planStopScreen(U);
  assert.ok(steps.every(x => x.join(" ").startsWith("/usr/bin/setpriv --reuid=20000 ") && x.includes("/usr/bin/pkill") && x.includes("-u") && x.includes("20000") && x.includes("-x")));
  assert.deepEqual(steps.map(x => x[x.length - 1]), ["chromium", "fluxbox", "Xvnc"]);
  assert.ok(!steps.flat().includes("tmux"));
});

test("reset empties the home as the agent and keeps the folder and its mode; it names no other path", () => {
  const steps = planWipeHome(U);
  assert.deepEqual(steps.map(x => x.slice(x.indexOf("-i") + 1).filter(a => !/^[A-Z]+=/.test(a)).join(" ")), ["/usr/bin/pkill -KILL -u 20000", "/usr/bin/find /home/ag20000 -mindepth 1 -delete", "/usr/bin/chmod 0700 /home/ag20000"]);
});

test("remove empties exactly its home and run folder as the agent and leaves the image user", () => {
  const last = planRemove(U).pop() || [];
  assert.deepEqual(last.slice(last.indexOf("/usr/bin/find")), ["/usr/bin/find", "/home/ag20000", "/var/lib/vyre/agents/ag20000", "-mindepth", "1", "-delete"]);
});

test("a triple that is not exactly user ag<uid>, a uid the image made and that uid's display is refused before anything runs", () => {
  const bad = [{ ...U, user: "root" }, { ...U, user: "ag../x" }, { ...U, user: "ag a" }, { ...U, user: "ag20001" }, { ...U, uid: 1000 }, { ...U, uid: 20000.5 }, { ...U, uid: 20064, user: "ag20064", display: 84 },
    { ...U, display: 21 }, { ...U, display: 1 }, { ...U, display: 9999 }];
  for (const b of bad) {
    assert.throws(() => planCreate(b), /not one of the agent users|not an agent user name|is not the display/, JSON.stringify(b));
    assert.throws(() => planWipeHome(b), undefined, JSON.stringify(b));
    assert.throws(() => planStartScreen(b), undefined, JSON.stringify(b));
  }
  assert.doesNotThrow(() => planCreate({ user: "ag20063", uid: 20063, display: 83 }), "the last of the 64");
  assert.equal(homeOf("ag20000"), "/home/ag20000");
});

test("a step fails the plan unless it is one that may fail (stopping what is not running)", async () => {
  /** @type {string[]} */ const ran = [];
  const name = argv => argv[argv.length - 1].startsWith("/") ? argv[argv.length - 1] : argv.filter(a => a.startsWith("/usr/bin/") && !/setpriv|prlimit|nice|env/.test(a))[0];
  const run = async argv => { ran.push(name(argv)); if (argv.includes("/usr/bin/pkill")) throw new Error("nothing to kill"); };
  await execute(planWipeHome(U), run, { tolerate: tolerant });
  assert.equal(ran.length, 3);
  await assert.rejects(() => execute(planWipeHome(U), async argv => { if (argv.includes("/usr/bin/find")) throw new Error("disk"); }, { tolerate: tolerant }), /disk/);
});
