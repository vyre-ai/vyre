import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { codeRoute, installLine, isBoxlessMac, MAC_SERVER, macServerSay, ADD_PHONE, BROWSER, EMPTY, WAITING, GAP, MAC_WHERE, NO_VYRE, PHONE_SAY, WEB_SAY, WELCOME, WHO, deviceKind, firstStep, gapOf, isPhone, isWho, pairSayFor, whoLine } from "./first-run.js";
import { backOf, nextSetup, packProgress, startStep, unpackProgress } from "./flow.js";
import { applyClaim, setupFrom } from "./real.js";

test("the device kind is the platform, and a Mac only inside the Mac app's window", () => {
  assert.equal(deviceKind("ios", false), "ios");
  assert.equal(deviceKind("android", true), "android");
  assert.equal(deviceKind("web", true), "mac");
  assert.equal(deviceKind("web", false), "web");
  assert.ok(isPhone("ios") && isPhone("android") && !isPhone("mac") && !isPhone("web"));
});

test("a browser that cannot claim starts at Open Vyre on your phone; everything else at the welcome", () => {
  assert.equal(firstStep("web", false), "browser");
  assert.equal(firstStep("web", true), "welcome");
  assert.equal(firstStep("ios", false), "welcome");
  assert.equal(firstStep("mac", true), "welcome");
});

test("the welcome is one line and two actions", () => {
  assert.equal(WELCOME.title, "Vyre");
  assert.equal(WELCOME.start, "Get started");
  assert.equal(WELCOME.have, "I already have Vyre");
  assert.equal(backOf("name", { welcome: true }), "welcome", "Get started goes to the reservation code");
  assert.equal(backOf("have", { welcome: true }), "welcome");
  assert.equal(backOf("name"), null);
  assert.equal(backOf("welcome"), null);
});

test("a browser's pairing goes back to its own screen, and the not-set-up screen goes back to it", () => {
  assert.equal(backOf("scanwords", { browser: true }), "browser");
  assert.equal(backOf("nosetup"), "browser");
  assert.equal(backOf("browser"), null);
});

test("a Mac chooses where Vyre runs before the space, and goes on without asking again", () => {
  assert.equal(backOf("create", { macFlow: true }), "macwhere");
  assert.equal(backOf("cmd", { macFlow: true }), "create");
  assert.equal(backOf("here", { macFlow: true }), "create");
  assert.equal(backOf("create"), "spaces");
  assert.equal(backOf("here"), "where");
});

test("the empty-state actions open the routes that exist", () => {
  assert.equal(startStep("phone"), "addphone");
  assert.equal(startStep("connect"), "scan");
  assert.equal(GAP.mac.route, "/u/install/phone");
  assert.equal(GAP.phone.route, "/u/install/connect");
  assert.equal(GAP.web.route, "/u/install/connect");
});

test("what is missing: a phone or browser with no Vyre, a Mac with no phone, and nothing once connected", () => {
  assert.equal(gapOf({ kind: "ios", paired: false, hasBox: false, devices: null }), GAP.phone);
  assert.equal(gapOf({ kind: "android", paired: false, hasBox: false, devices: null }), GAP.phone);
  assert.equal(gapOf({ kind: "web", paired: false, hasBox: false, devices: null }), GAP.web);
  assert.equal(gapOf({ kind: "ios", paired: true, hasBox: false, devices: null }), null);
  assert.equal(gapOf({ kind: "web", paired: false, hasBox: true, devices: null }), null);
  assert.equal(gapOf({ kind: "mac", paired: false, hasBox: true, devices: [{ device: "computer" }] }), GAP.mac);
  assert.equal(gapOf({ kind: "mac", paired: false, hasBox: true, devices: [{ device: "phone" }] }), null);
  assert.equal(gapOf({ kind: "mac", paired: false, hasBox: true, devices: [{ kind: "app" }] }), null, "the native app is the phone");
  assert.equal(gapOf({ kind: "mac", paired: false, hasBox: true, devices: [{ kind: "web" }] }), GAP.mac, "a browser cannot approve");
  assert.equal(gapOf({ kind: "mac", paired: false, hasBox: true, devices: null }), null, "an unread list is not a missing phone");
});

test("each landing screen has one line and one action, and none says server or install line", () => {
  for (const c of [...Object.values(EMPTY), ...Object.values(GAP), WAITING]) {
    assert.ok(c.title && c.line && c.action && (c.route === "refresh" || c.route.startsWith("/")));
    assert.doesNotMatch(`${c.title} ${c.line} ${c.action}`, /server|install line|terminal|command/i);
  }
});

test("a phone and a browser never read a server or an install line for a pairing", () => {
  const server = "Nothing was paired. The three words were not the same. Run the install line on your server again to get a new code.";
  assert.equal(pairSayFor(server, "ios"), PHONE_SAY.rejected);
  assert.equal(pairSayFor(server, "web"), PHONE_SAY.rejected);
  assert.equal(pairSayFor(server, "mac"), server, "the Mac is the device that runs the line");
  assert.equal(pairSayFor("Your phone cannot reach the server right now. Check that it is on and online, then try again. Nothing was paired.", "android"), PHONE_SAY.unreachable);
  assert.equal(pairSayFor("The pairing ran out of time, so nothing was paired. Run the install line on your server again to get a new code.", "ios"), PHONE_SAY.expired);
  for (const s of [...Object.values(PHONE_SAY), ...Object.values(WEB_SAY)]) assert.doesNotMatch(s, /server|install/i);
});

test("a browser that cannot reach the Vyre says This browser, a phone says Your phone", () => {
  const t = "Your phone cannot reach the server right now. Check that it is on and online, then try again. Nothing was paired.";
  assert.equal(pairSayFor(t, "web"), "This browser cannot reach your Vyre right now. Nothing was paired.");
  assert.equal(pairSayFor(t, "ios"), PHONE_SAY.unreachable);
  assert.doesNotMatch(WEB_SAY.spaceOffline, /phone/i);
});

test("the phone and browser screens name no command, and the Mac's server line stays the Mac's", () => {
  for (const s of [BROWSER.title, BROWSER.line, BROWSER.notSetTitle, BROWSER.notSetLine, NO_VYRE.line, NO_VYRE.share]) assert.doesNotMatch(s, /curl|\| sh/);
  assert.match(MAC_WHERE.serverLine, /one line/);
  assert.equal(ADD_PHONE.skip, "Skip");
});

test("who it is for: three answers, and a space for one person has nobody to invite", () => {
  assert.deepEqual(WHO.options.map(([id]) => id), ["team", "client", "personal"]);
  assert.ok(isWho("client") && !isWho("anyone"));
  assert.ok(whoLine("team").length > 0 && whoLine("nope") === "");
  assert.equal(nextSetup("look", "team"), "members");
  assert.equal(nextSetup("look", "client"), "members");
  assert.equal(nextSetup("look", "personal"), "ai");
  assert.equal(nextSetup("kit", "personal"), "done");
  assert.equal(nextSetup("look"), "members");
});

test("who it is for is kept with the progress and with what the box keeps", () => {
  const raw = packProgress({ step: "look", name: "alex", spaceName: "Juniper Studio", addr: null, look: "amber", where: "server", pairTo: "me", device: "phone", who: "personal" });
  assert.equal(unpackProgress(raw).who, "personal");
  assert.equal(unpackProgress(packProgress({ step: "look", name: "alex", spaceName: "Juniper Studio", addr: null, look: "amber", where: "server", pairTo: "me", device: "phone" })).who, "team");
  assert.equal(setupFrom({ step: "look", name: "Juniper Studio", addr: null, look: "amber", where: "server", connectors: [], kit: null, who: "client" }).picks.who, "client");
  assert.equal(applyClaim({ space: "s", setup: { step: "members", picks: { who: "personal" } } }).who, "personal");
  assert.equal(applyClaim({ space: "s", setup: { step: "members", picks: { who: "x" } } }).who, "team");
});

test("the Mac's boxless window types the server's code: the words follow the prototype, three wrong tries end it", () => {
  assert.ok(isBoxlessMac({ boxless: true }) && !isBoxlessMac({}) && !isBoxlessMac(null));
  assert.equal(MAC_SERVER.title, "Type the code your server shows");
  assert.equal(MAC_SERVER.ackTitle, "Type this on your server");
  assert.equal(MAC_SERVER.doneTitle, "Connected to your server");
  assert.deepEqual(macServerSay("wrong", 2), { title: "That code is not right", line: "Check the code on your server and type it again. 2 tries left.", over: false });
  assert.equal(macServerSay("wrong", 1).line.includes("1 try left"), true);
  assert.equal(macServerSay("wrong", 0).over, true);
  assert.deepEqual(macServerSay("expired", 3), { title: "That code ran out of time", line: "Run the line on your server again to get a new one.", over: true });
  assert.deepEqual(macServerSay("offline", 3), { title: "Your Mac cannot reach the server", line: "Check that it is on and online. Nothing was connected.", over: false });
});

test("the install line is the release candidate's own only for a hyphenated version; a plain release and an unknown version get the stable one", () => {
  const STABLE = "curl -fsSL vyre.run/i | sh";
  const rc = (v) => `curl -fsSL https://github.com/vyre-ai/vyre/releases/download/v${v}/install-box.sh | VYRE_BOX_URL=https://github.com/vyre-ai/vyre/releases/download/v${v}/ sh`;
  assert.equal(installLine("0.3.0-rc.1"), rc("0.3.0-rc.1"));
  assert.equal(installLine(" 0.3.0-rc1 "), rc("0.3.0-rc1"));
  assert.equal(installLine("0.3.0"), STABLE);
  for (const v of [undefined, null, "", "latest", "0.3", "1.0.0; rm -rf /", "0.3.0-rc.1; ls", "-rc1"]) assert.equal(installLine(v), STABLE, String(v));
  assert.doesNotMatch(MAC_SERVER.help, /\d+ minutes/);
});

test("whose a server is: a browser reads it as the server said it, a phone as this Vyre", () => {
  const s = "This server belongs to walkercc.vyre.run. Ask them to add you to a space, or reset the server to start over.";
  assert.equal(pairSayFor(s, "web"), s);
  assert.equal(pairSayFor(s, "mac"), s);
  assert.equal(pairSayFor(s, "ios"), "This Vyre belongs to walkercc.vyre.run. Ask them to add you to a space, or reset it to start over.");
});

import { setupUnfinished, SETUP_BANNER } from "./first-run.js";
test("the setup banner shows only when the box says setup is not finished", () => {
  assert.equal(setupUnfinished({ finished: false }), true);
  assert.equal(setupUnfinished({ finished: true }), false);
  assert.equal(setupUnfinished(null), false);
  assert.equal(setupUnfinished({}), false);
  assert.equal(SETUP_BANNER.route, "/u/install/setup");
});

test("the short typed code is on in release and gated on RC.typedCode, so the kill switch hides every typed path", async () => {
  const { readFileSync } = await import("node:fs");
  const rc = readFileSync(new URL("../shell/rc.ts", import.meta.url), "utf8");
  assert.match(rc, /typedCode: flagNotOff\(process\.env\.EXPO_PUBLIC_VYRE_TYPED_CODE\)/, "on by default: only an explicit 0 turns it off, read by the exact literal Expo inlines");
  for (const f of ["../devices/TypeCode.tsx"]) {
    const src = readFileSync(new URL(f, import.meta.url), "utf8");
    assert.match(src, /export function TypeCode\(p: TypeCodeProps\) \{ return RC\.typedCode \?/, "the typed field renders nothing only while the kill switch is set");
    assert.match(src, /export function AckCode\(p: \{ offer: string; onDone: \(\) => void \}\) \{ return RC\.typedCode \?/, "so does the ack box");
  }
  assert.match(readFileSync(new URL("./MacServer.tsx", import.meta.url), "utf8"), /if \(!RC\.typedCode\)/, "and the Mac's typed-code window");
});

test("the words step after a long code uses the session's own kind: a real (watch) session shows the words and waits for the yes, never the typed-words form", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("./InstallScreen.tsx", import.meta.url), "utf8");
  const step = src.slice(src.indexOf('} else if (step === "scanwords") {'), src.indexOf('} else if (step === "recovery") {'));
  assert.match(step, /<PairServer session=\{session\}/);
  assert.doesNotMatch(step, /<PairWords/);
});

test("a phone's long code adds this device to the name (a browser too); a server's long code pairs this device to that server", () => {
  assert.equal(codeRoute({ kind: "ticket", for: "phone" }), "add-device");
  assert.equal(codeRoute({ kind: "ticket", for: "server" }), "pair-server");
  assert.equal(codeRoute({ kind: "offer" }), "pair-server");
  assert.equal(codeRoute(null), "pair-server");
});

test("Get started goes to the reservation code; there is no question, and My Cloud is the one card that adds a server", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("./InstallScreen.tsx", import.meta.url), "utf8");
  assert.match(src, /label=\{WELCOME\.start\} onPress=\{\(\) => setStep\("name"\)\}/, "Get started opens the code step");
  assert.doesNotMatch(src, /step === "question"|QUESTION|afterQuestion|ownServer/);
  assert.match(src, /step === "mycloud"[\s\S]*<MyCloudCard \/>/, "the My Cloud page is the card");
  assert.doesNotMatch(src, /step === "mcwords"|step === "srv1"|step === "vps"/, "no second way to pair a server");
  assert.match(src, /<AddServerCard onDone=\{\(\) => doMake\("server"\)\} \/>/, "a new space on no server runs the same add-a-server piece, then makes the space");
});

test("the paste check accepts every character the directory can put in a code", async () => {
  const { ALPHA32 } = await import("../../../../names/worker/ids.js");
  const { codeLooksRight } = await import("./first-run.js");
  for (const ch of ALPHA32) assert.equal(codeLooksRight(`vyre-${ch.repeat(4)}-${ch.repeat(4)}-${ch.repeat(4)}-${ch.repeat(4)}`), true, ch);
  assert.equal(codeLooksRight("VYRE-IIII-OOOO-0000-1111"), false);
});
