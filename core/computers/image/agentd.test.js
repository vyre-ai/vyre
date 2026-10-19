// @ts-check
// agentd's plans: what would run inside the computer, checked without a container. The properties that matter are the ones isolation depends on.

import "../../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { planCreate, planStartScreen, planStopScreen, planWipeHome, planRemove, planFolders, FOLDERS, asAgent, execute, tolerant, homeOf, socketOf } from "./agentd.js";

const U = { user: "ag20000", uid: 20000, display: 20 };
const B = { user: "ag20001", uid: 20001, display: 21 };
const flat = steps => steps.map(s => s.join(" "));
const WRAP = /^\/usr\/bin\/setpriv --reuid=(\d+) --regid=\1 --clear-groups --inh-caps=-all --ambient-caps=-all --bounding-set=-all --no-new-privs -- \/usr\/bin\/prlimit (?:--as|--data)=\d+ --nproc=\d+(?: --[a-z]+=\d+)* \/usr\/bin\/nice -n 5 \/usr\/bin\/env -i /;

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
  assert.match(s, / \+extension SECURITY/, "the untrusted cookie the agent gets is a SECURITY extension authority: without the extension there is none");
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
  assert.match(wm.join(" "), /^\/usr\/bin\/setpriv --reuid=21000 .* DISPLAY=:20 XAUTHORITY=\/var\/lib\/vyre\/browsers\/agb21000\/xauth \/usr\/bin\/fluxbox -rc \/etc\/vyre-desk\/fluxbox\/init$/, "the window manager is a trusted client of the browser uid, with the desk's own settings");
  assert.match(chrome.join(" "), /^\/usr\/bin\/setpriv --reuid=21000 --regid=21000 .* \/usr\/bin\/python3 -I \/opt\/agentd\/agentd-chrome\.py$/, "Chrome is started by the holder as the agent's browser uid, with no argument and no debug port");
  assert.doesNotMatch(planStartScreen(U).flat().join(" "), /remote-debugging-port|--user-data-dir/, "no TCP debug port, and no flag to steer from outside the holder");
  // what runs as the agent on its screen: its dock (with its untrusted cookie) and its folders, nothing of the screen itself
  const asAgentSteps = planStartScreen(U).filter(step => step.join(" ").includes("--reuid=20000"));
  assert.ok(asAgentSteps.every(step => /\/opt\/agentd\/agentd-dock\.py$|\/usr\/bin\/mkdir -p |\/usr\/bin\/ln -s -T /.test(step.join(" "))), "only the dock and the folders run as the agent");
  for (const step of [xvnc, wm, chrome]) assert.ok(!step.join(" ").includes("--reuid=20000"), "the screen, its window manager and Chrome are never the agent's");
});

test("the desk: a wallpaper made and set by the screen's owner, a dock that runs as the agent with its untrusted cookie, and every step after Chrome may fail without costing the screen", () => {
  const steps = planStartScreen(U);
  const after = steps.slice(steps.findIndex(s => s.join(" ").includes("agentd-chrome.py")) + 1);
  const wall = after.find(s => s.includes("/usr/bin/convert")), set = after.find(s => s.includes("/usr/bin/display")), dock = after.find(s => s.join(" ").includes("agentd-dock.py"));
  assert.ok(wall && set && dock);
  assert.match(wall.join(" "), /^\/usr\/bin\/setpriv --reuid=21000 .* \/usr\/bin\/convert -size 1440x900 xc:#0E0D0C \( \/usr\/share\/vyre-desk\/mark\.png -resize 112x112 \) -gravity center -composite PNG24:\/var\/lib\/vyre\/browsers\/agb21000\/wallpaper\.png$/);
  assert.equal(/** @type {any} */ (wall).tolerate, true, "a wallpaper that cannot be made costs the picture only");
  assert.match(set.join(" "), /^\/usr\/bin\/setpriv --reuid=21000 .* DISPLAY=:20 XAUTHORITY=\/var\/lib\/vyre\/browsers\/agb21000\/xauth \/usr\/bin\/display -window root \/var\/lib\/vyre\/browsers\/agb21000\/wallpaper\.png$/);
  assert.match(dock.join(" "), /^\/usr\/bin\/setpriv --reuid=20000 --regid=20000 .* DISPLAY=:20 XAUTHORITY=\/var\/lib\/vyre\/x\/ag20000\/xauth \/usr\/bin\/python3 -I \/opt\/agentd\/agentd-dock\.py$/, "the dock is the agent's, with the untrusted cookie only");
  assert.doesNotMatch(dock.join(" "), /browsers\/agb21000\/xauth/, "never the screen's trusted cookie");
  for (const s of [set, dock]) assert.equal(/** @type {any} */ (s).detach, true);
  assert.ok(after.every(s => /** @type {any} */ (s).detach === true || tolerant(s)), "nothing after Chrome can fail the screen's start");
  // a size from config is used only when it is WIDTHxHEIGHT
  assert.match(planStartScreen(U, { size: "1920x1080" }).flat().join(" "), /-geometry 1920x1080 .* -size 1920x1080 /);
  assert.match(planStartScreen(U, { size: "1920x1080; rm -rf /" }).flat().join(" "), /-geometry 1440x900 .* -size 1440x900 /);
});

test("the agent's folder: Inbox, Work, Done, Scripts and Notes made when missing, Downloads a link to Chrome's download folder, as the agent, never replacing what is there", () => {
  assert.deepEqual([...FOLDERS], ["Inbox", "Work", "Done", "Downloads", "Scripts", "Notes"]);
  const [mk, ln] = planFolders(U);
  const H = "/var/lib/vyre/agents/ag20000/home";
  assert.match(mk.join(" "), new RegExp(`^/usr/bin/setpriv --reuid=20000 .* /usr/bin/mkdir -p ${H}/Inbox ${H}/Work ${H}/Done ${H}/Scripts ${H}/Notes$`));
  assert.match(ln.join(" "), new RegExp(`^/usr/bin/setpriv --reuid=20000 .* /usr/bin/ln -s -T /var/lib/vyre/downloads/ag20000 ${H}/Downloads$`), "-T: an existing Downloads (a file or a folder) is never entered or replaced");
  assert.ok(!planFolders(U).flat().some(a => a === "-f" || a === "-n" || a === "--force"), "nothing is forced over what the agent already has");
  for (const s of planFolders(U)) assert.ok(tolerant(s), "a name that is already taken never fails the plan");
  // made on first use, when the home is emptied, and on every wake (a home made before this had none)
  for (const plan of [planCreate(U), planWipeHome(U), planStartScreen(U)]) assert.ok(plan.some(s => s.includes("/usr/bin/ln") && s.includes(`${H}/Downloads`)));
  assert.ok(!planRemove(U).some(s => s.includes("/usr/bin/ln")), "a removed agent's place is left empty for the next one");
  assert.doesNotMatch(planFolders(B).flat().join(" "), /ag20000/, "another agent's folders name only its own uid");
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

test("sleeping signals only the dock as the agent and the screen's processes as the browser uid (the browser, the window manager, the screen), each as itself, and never the tmux server", () => {
  const [dock, ...steps] = planStopScreen(U);
  assert.match(dock.join(" "), /^\/usr\/bin\/setpriv --reuid=20000 .* \/usr\/bin\/pkill -TERM -u 20000 -f \^\/usr\/bin\/python3 -I \/opt\/agentd\/agentd-dock\.py\$$/, "the agent's uid ends its own dock and nothing else");
  assert.ok(steps.every(x => x.join(" ").startsWith("/usr/bin/setpriv --reuid=21000 ")), "every other step is the browser uid's");
  const signals = steps.filter(x => x.includes("/usr/bin/pkill") && !x.includes("-f"));
  assert.ok(signals.every(x => x.slice(-5, -1).join(" ") === "-TERM -u 21000 -x"), "the browser, the window manager and the screen are all the browser uid's");
  assert.deepEqual(signals.map(x => x[x.length - 1]), ["chromium", "fluxbox", "Xvnc"]);
  assert.ok(steps[0].includes("-f") && steps[1].includes("/usr/bin/sleep"), "the holder first, then the wait for Chrome's clean close");
  assert.ok(![dock, ...steps].flat().includes("tmux"));
});

test("reset empties the home as the agent and the browser's profile as the browser uid; each keeps its folder and mode, and no other path is named", () => {
  const steps = planWipeHome(U).map(x => x.slice(x.indexOf("-i") + 1).filter(a => !/^[A-Z]+=/.test(a)).join(" "));
  assert.deepEqual(steps, ["/usr/bin/pkill -KILL -u 20000", "/usr/bin/pkill -KILL -u 21000", "/usr/bin/find /var/lib/vyre/agents/ag20000/home -mindepth 1 -delete", "/usr/bin/chmod 0700 /var/lib/vyre/agents/ag20000/home",
    "/usr/bin/find /var/lib/vyre/browsers/agb21000 /var/lib/vyre/downloads/ag20000 -mindepth 1 -delete", "/usr/bin/mkdir /var/lib/vyre/browsers/agb21000/profile", "/usr/bin/chmod 0700 /var/lib/vyre/browsers/agb21000/profile /var/lib/vyre/browsers/agb21000",
    "/usr/bin/mkdir -p /var/lib/vyre/agents/ag20000/home/Inbox /var/lib/vyre/agents/ag20000/home/Work /var/lib/vyre/agents/ag20000/home/Done /var/lib/vyre/agents/ag20000/home/Scripts /var/lib/vyre/agents/ag20000/home/Notes",
    "/usr/bin/ln -s -T /var/lib/vyre/downloads/ag20000 /var/lib/vyre/agents/ag20000/home/Downloads"]);
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
  assert.equal(ran.length, planWipeHome(U).length, "every step ran: the stops that fail are tolerated");
  await assert.rejects(() => execute(planWipeHome(U), async argv => { if (argv.includes("/usr/bin/find")) throw new Error("disk"); }, { tolerate: tolerant }), /disk/);
});

test("Chrome alone has no address-space cap (it dies at start under RLIMIT_AS); every other agent process keeps the finite one", () => {
  const steps = planStartScreen(U).map(s => s.join(" "));
  const chrome = steps.filter(s => s.includes("agentd-chrome.py"));
  assert.equal(chrome.length, 1);
  assert.match(chrome[0], /prlimit --data=3221225472 --nproc=512 /, "no address-space cap, a 3 GiB cap on committed memory instead, the process cap stays");
  assert.ok(steps.filter(s => !s.includes("agentd-chrome.py")).every(s => /prlimit --as=3221225472 /.test(s)), "the screen, the window manager and the helpers keep 3 GiB");
  assert.doesNotMatch(asAgent(U, { memoryMb: 0 }).join(" "), /unlimited|--data/, "a zero from config is never read as no cap");
  assert.match(asAgent(U, { noAddressCap: true }).join(" "), /--data=/, "the option exists only for the Chrome holder's call: nothing else in agentd.js sets it");
  assert.equal((fs.readFileSync(new URL("./agentd.js", import.meta.url), "utf8").match(/noAddressCap: true/g) || []).length, 1);
});

test("sleep keeps the Chrome profile: stopping only signals processes, the profile is under the agent's home, and only a reset or a removal empties that home", () => {
  const holder = fs.readFileSync(new URL("./agentd-chrome.py", import.meta.url), "utf8");
  assert.match(holder, /PROFILE = BASE \+ "\/profile"/);
  assert.match(holder, /BASE = "\/var\/lib\/vyre\/browsers\/agb%d" % uid/);
  assert.match(holder, /"--user-data-dir=" \+ PROFILE/);
  assert.match(holder, /--restore-last-session/, "the tabs and their logins come back when Chrome does");
  assert.ok(planStopScreen(U).every(x => (x.includes("/usr/bin/pkill") || x.includes("/usr/bin/sleep")) && !x.includes("-delete") && !x.includes("/usr/bin/find")), "sleeping deletes nothing");
  assert.match(planStopScreen(U)[1].join(" "), /pkill -TERM -u 21000 -f \^\/usr\/bin\/python3 -I \/opt\/agentd\/agentd-chrome\.py\$/, "Chrome's holder is asked first, so Chrome closes itself and writes its profile");
  assert.match(fs.readFileSync(new URL("./agentd-chrome.py", import.meta.url), "utf8"), /Browser\.close/);
  assert.ok(planWipeHome(U).some(x => x.includes("-delete") && x.includes("/var/lib/vyre/browsers/agb21000")), "only a reset empties the browser profile");
  assert.ok(planRemove(U).some(x => x.includes("-delete")));
});
