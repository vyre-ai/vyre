// @ts-check
// agentd's plans: what would run inside the computer, checked without a container. The properties that matter are the ones isolation depends on.

import "../../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { planCreate, planStartScreen, planStopScreen, planWipeHome, planRemove, asAgent, execute, tolerant, homeOf, socketOf } from "./agentd.js";

const U = { user: "ag20000", uid: 20000, display: 20 };
const B = { user: "ag20001", uid: 20001, display: 21 };
const flat = steps => steps.map(s => s.join(" "));
const WRAP = /^\/usr\/bin\/setpriv --reuid=(\d+) --regid=\1 --clear-groups --inh-caps=-all --ambient-caps=-all --bounding-set=-all --no-new-privs -- \/usr\/bin\/prlimit --as=\d+ --nproc=\d+(?: --[a-z]+=\d+)* \/usr\/bin\/nice -n 5 \/usr\/bin\/env -i /;

test("a new agent's home and run folder were made at image build; adding one only checks them, as the agent, and changes no owner", () => {
  const steps = flat(planCreate(U));
  assert.ok(!steps.some(x => /useradd|groupadd|chown/.test(x)), "agentd never adds a user or chowns: it has no capability to");
  assert.ok(steps.every(x => x.startsWith("/usr/bin/setpriv --reuid=20000 --regid=20000") || x.startsWith("/usr/bin/setpriv --reuid=21000 --regid=21000")), "every step runs as the agent or as its browser uid, and as no one else");
  assert.ok(steps.some(x => x.startsWith("/usr/bin/setpriv --reuid=20000 ") && x.endsWith("/usr/bin/chmod 0700 /var/lib/vyre/agents/ag20000/home /var/lib/vyre/agents/ag20000")));
  assert.ok(steps.some(x => x.startsWith("/usr/bin/setpriv --reuid=21000 ") && x.endsWith("/usr/bin/chmod 0700 /var/lib/vyre/browsers/agb21000/profile /var/lib/vyre/browsers/agb21000")), "the browser's folders are the browser uid's");
});

test("every agent process runs through setpriv as that uid, with absolute paths: no groups, every capability set emptied, no new privileges, limited, and an environment built from nothing", () => {
  for (const argv of [...planStartScreen(U), ...planCreate(U), ...planStopScreen(U), ...planWipeHome(U), ...planRemove(U)]) {
    const s = argv.join(" ");
    assert.match(s, WRAP, s);
    assert.ok(argv[0].startsWith("/") && argv.every((a, i) => i === 0 || !/^(setpriv|prlimit|nice|env)$/.test(a)), "no binary is looked up by PATH");
  }
  const env = asAgent(U, {}, { DISPLAY: ":20" }).join(" ");
  assert.match(env, /\/usr\/bin\/env -i HOME=\/var\/lib\/vyre\/agents\/ag20000\/home USER=ag20000 LOGNAME=ag20000 PATH=\/usr\/local\/bin:\/usr\/bin:\/bin LANG=C\.UTF-8 DISPLAY=:20$/);
});

test("the screen is the browser uid's: its own display on a unix socket (no TCP port), its password a file in the browser's folder, never on the command line; the agent gets only an untrusted cookie", () => {
  const [rm, trusted, mode, xvnc, untrusted, chmodU, wm, chrome] = planStartScreen(U);
  const s = xvnc.join(" ");
  assert.match(s, /^\/usr\/bin\/setpriv --reuid=21000 --regid=21000 /, "Xvnc runs as the browser uid, not the agent's");
  assert.match(s, / \/usr\/bin\/Xvnc :20 /);
  assert.match(s, /-rfbport -1 -rfbunixpath \/var\/lib\/vyre\/browsers\/agb21000\/vnc\.sock -rfbunixmode 0600/);
  assert.match(s, /-rfbauth \/var\/lib\/vyre\/browsers\/agb21000\/vnc\.pass/);
  assert.equal(socketOf(U), "/var/lib/vyre/browsers/agb21000/vnc.sock");
  assert.doesNotMatch(planStartScreen(U).flat().join(" "), /password=|-passwd/i);
  // the trusted cookie is the browser uid's and 0600; the one the agent reads is generated as UNTRUSTED by the running server
  assert.match(s, /-auth \/var\/lib\/vyre\/browsers\/agb21000\/xauth /);
  assert.match(mode.join(" "), /\/usr\/bin\/chmod 0600 \/var\/lib\/vyre\/browsers\/agb21000\/xauth$/);
  assert.match(trusted.join(" "), /^\/usr\/bin\/setpriv --reuid=21000 .* \/usr\/bin\/xauth -f \/var\/lib\/vyre\/browsers\/agb21000\/xauth source -$/);
  assert.match(String(/** @type {any} */ (trusted).input), /^add :20 \. [0-9a-f]{32}\n$/);
  assert.match(untrusted.join(" "), /^\/usr\/bin\/setpriv --reuid=21000 .* XAUTHORITY=\/var\/lib\/vyre\/browsers\/agb21000\/xauth \/usr\/bin\/xauth -f \/var\/lib\/vyre\/x\/ag20000\/xauth generate :20 \. untrusted$/);
  assert.ok(/** @type {any} */ (untrusted).retry.tries > 1, "it waits for the server to be up");
  assert.match(chmodU.join(" "), /\/usr\/bin\/chmod 0640 \/var\/lib\/vyre\/x\/ag20000\/xauth$/);
  assert.match(rm.join(" "), /\/usr\/bin\/rm -f \/var\/lib\/vyre\/browsers\/agb21000\/xauth \/var\/lib\/vyre\/x\/ag20000\/xauth \/var\/lib\/vyre\/browsers\/agb21000\/vnc\.sock$/);
  assert.match(wm.join(" "), /^\/usr\/bin\/setpriv --reuid=21000 .* DISPLAY=:20 XAUTHORITY=\/var\/lib\/vyre\/browsers\/agb21000\/xauth \/usr\/bin\/fluxbox$/, "the window manager is a trusted client of the browser uid");
  assert.match(chrome.join(" "), /^\/usr\/bin\/setpriv --reuid=21000 --regid=21000 .* \/usr\/bin\/python3 -I \/opt\/agentd\/agentd-chrome\.py$/, "Chrome is started by the holder as the agent's browser uid, with no argument and no debug port");
  assert.doesNotMatch(planStartScreen(U).flat().join(" "), /remote-debugging-port|--user-data-dir/, "no TCP debug port, and no flag to steer from outside the holder");
  // nothing of the screen runs as the agent
  assert.ok(planStartScreen(U).every(step => !step.join(" ").includes("--reuid=20000")), "no start step runs as the agent's own uid");
});

test("the long-running steps are marked in the plan, and the others are not", () => {
  const [, trusted, mode, xvnc, untrusted, chmodU, wm, chrome] = planStartScreen(U);
  for (const step of [xvnc, wm, chrome]) assert.equal(/** @type {any} */ (step).detach, true);
  for (const step of [trusted, mode, untrusted, chmodU]) assert.equal(/** @type {any} */ (step).detach, undefined);
  for (const step of [...planStopScreen(U), ...planWipeHome(U), ...planCreate(U), ...planRemove(U)]) assert.equal(/** @type {any} */ (step).detach, undefined, step.join(" "));
});

test("two agents get two displays, sockets and profiles that never overlap", () => {
  const a = planStartScreen(U).flat().join(" "), b = planStartScreen(B).flat().join(" ");
  assert.match(a, /agb21000\/vnc\.sock/); assert.match(b, /agb21001\/vnc\.sock/);
  assert.doesNotMatch(a, /ag20001|:21 |=20001/); assert.doesNotMatch(b, /ag20000|:20 |=20000/);
});

test("sleeping signals only the browser uid's processes (the browser, the window manager, the screen), as itself, and never the tmux server", () => {
  const steps = planStopScreen(U);
  assert.ok(steps.every(x => x.join(" ").startsWith("/usr/bin/setpriv --reuid=21000 ") && x.slice(-5, -1).join(" ") === "-TERM -u 21000 -x"), "the browser, the window manager and the screen are all the browser uid's");
  assert.deepEqual(steps.map(x => x[x.length - 1]), ["chromium", "fluxbox", "Xvnc"]);
  assert.ok(!steps.flat().includes("tmux"));
});

test("reset empties the home as the agent and the browser's profile as the browser uid; each keeps its folder and mode, and no other path is named", () => {
  const steps = planWipeHome(U).map(x => x.slice(x.indexOf("-i") + 1).filter(a => !/^[A-Z]+=/.test(a)).join(" "));
  assert.deepEqual(steps, ["/usr/bin/pkill -KILL -u 20000", "/usr/bin/pkill -KILL -u 21000", "/usr/bin/find /var/lib/vyre/agents/ag20000/home -mindepth 1 -delete", "/usr/bin/chmod 0700 /var/lib/vyre/agents/ag20000/home",
    "/usr/bin/find /var/lib/vyre/browsers/agb21000 -mindepth 1 -delete", "/usr/bin/mkdir /var/lib/vyre/browsers/agb21000/profile", "/usr/bin/chmod 0700 /var/lib/vyre/browsers/agb21000/profile /var/lib/vyre/browsers/agb21000"]);
});

test("remove empties its run folder, its browser's folder and its downloads, each as the uid that owns them, and makes the folders again for the next agent", () => {
  const steps = planRemove(U).map(x => x.slice(x.indexOf("-i") + 1).filter(a => !/^[A-Z]+=/.test(a)).join(" "));
  assert.deepEqual(steps, ["/usr/bin/pkill -KILL -u 20000", "/usr/bin/pkill -KILL -u 21000", "/usr/bin/find /var/lib/vyre/agents/ag20000 -mindepth 1 -delete", "/usr/bin/mkdir /var/lib/vyre/agents/ag20000/home",
    "/usr/bin/chmod 0700 /var/lib/vyre/agents/ag20000/home /var/lib/vyre/agents/ag20000", "/usr/bin/find /var/lib/vyre/browsers/agb21000 /var/lib/vyre/downloads/ag20000 -mindepth 1 -delete",
    "/usr/bin/mkdir /var/lib/vyre/browsers/agb21000/profile", "/usr/bin/chmod 0700 /var/lib/vyre/browsers/agb21000/profile /var/lib/vyre/browsers/agb21000"]);
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
  assert.equal(homeOf("ag20000"), "/var/lib/vyre/agents/ag20000/home");
});

test("a step fails the plan unless it is one that may fail (stopping what is not running)", async () => {
  /** @type {string[]} */ const ran = [];
  const name = argv => argv[argv.length - 1].startsWith("/") ? argv[argv.length - 1] : argv.filter(a => a.startsWith("/usr/bin/") && !/setpriv|prlimit|nice|env/.test(a))[0];
  const run = async argv => { ran.push(name(argv)); if (argv.includes("/usr/bin/pkill")) throw new Error("nothing to kill"); };
  await execute(planWipeHome(U), run, { tolerate: tolerant });
  assert.equal(ran.length, 3);
  await assert.rejects(() => execute(planWipeHome(U), async argv => { if (argv.includes("/usr/bin/find")) throw new Error("disk"); }, { tolerate: tolerant }), /disk/);
});

test("sleep keeps the Chrome profile: stopping only signals processes, the profile is under the agent's home, and only a reset or a removal empties that home", () => {
  const holder = fs.readFileSync(new URL("./agentd-chrome.py", import.meta.url), "utf8");
  assert.match(holder, /PROFILE = BASE \+ "\/profile"/);
  assert.match(holder, /BASE = "\/var\/lib\/vyre\/browsers\/agb%d" % uid/);
  assert.match(holder, /"--user-data-dir=" \+ PROFILE/);
  assert.match(holder, /--restore-last-session/, "the tabs and their logins come back when Chrome does");
  assert.ok(planStopScreen(U).every(x => x.includes("/usr/bin/pkill") && !x.includes("-delete") && !x.includes("/usr/bin/find")), "sleeping deletes nothing");
  assert.ok(planWipeHome(U).some(x => x.includes("-delete") && x.includes("/var/lib/vyre/browsers/agb21000")), "only a reset empties the browser profile");
  assert.ok(planRemove(U).some(x => x.includes("-delete")));
});
