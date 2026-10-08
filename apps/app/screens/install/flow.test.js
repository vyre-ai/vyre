import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { ownedBy, serverSay, backOf, homeLine, nameNote, nameStatus, slug, startStep, SERVER_LONG_CODE, AFTER_HOME, nextSetup, isResumable, packProgress, unpackProgress, setupElsewhere, connectedLine } from "./flow.js";

test("a slug is what goes before .vyre.run", () => {
  assert.equal(slug("Juniper Studio"), "juniper-studio");
  assert.equal(slug("  Northwind Bakery! "), "northwind-bakery");
  assert.equal(slug(""), "");
});

test("a name is empty, short, taken or ok", () => {
  assert.equal(nameStatus("").state, "empty");
  assert.equal(nameStatus("al").state, "short");
  assert.equal(nameStatus("Alex").state, "taken");
  assert.equal(nameStatus("jordan").state, "ok");
  assert.equal(nameStatus("jordan").address, "jordan.vyre.run");
});

test("a space cannot take its owner's name", () => {
  assert.equal(nameStatus("Jane", ["jane"]).state, "taken");
});

test("the note says what happened", () => {
  assert.equal(nameNote(nameStatus("juniper"), true), "juniper.vyre.run is taken. People and spaces share names.");
  assert.equal(nameNote(nameStatus("juniper"), false), "juniper.vyre.run is taken.");
  assert.equal(nameNote(nameStatus("ab"), false), "Use at least three letters.");
  assert.equal(nameNote(nameStatus("northwind"), true), "northwind.vyre.run is yours to take.");
  assert.equal(nameNote(nameStatus(""), true), "");
});

test("back from the add-a-server step goes to where the space lives", () => {
  assert.equal(backOf("cmd"), "where");
  assert.equal(backOf("scanwords"), "scan");
  assert.equal(backOf("where"), "create");
  assert.equal(backOf("recovery"), null);
});

test("each route starts at its step", () => {
  assert.equal(startStep("create"), "create");
  assert.equal(startStep("join"), "join");
  assert.equal(startStep(undefined), "name");
});

test("a space made on this computer says it sleeps", () => {
  assert.match(homeLine("here"), /Unreachable while it sleeps/);
});

test("setup carries on after the home: look, members, connectors, kit, done", () => {
  assert.equal(AFTER_HOME, "look");
  assert.deepEqual(["look", "members", "ai", "connectors", "kit"].map(nextSetup), ["members", "ai", "connectors", "kit", "done"]);
  assert.equal(backOf("members"), "look");
  assert.equal(backOf("look"), null);
});

test("a closed app resumes on the same step; adding the server starts again, since its install line is good for one hour", () => {
  assert.equal(isResumable("members"), true);
  assert.equal(isResumable("name"), false);
  const raw = packProgress({ step: "cmd", name: "alex", spaceName: "Northwind", addr: null, look: "sky", where: "server", pairTo: "me", device: "iPhone" });
  const back = unpackProgress(raw);
  assert.equal(back.step, "cmd");
  assert.equal(back.look, "sky");
  assert.equal(unpackProgress("nope"), null);
  assert.equal(unpackProgress(JSON.stringify({ v: 2, step: "look", spaceName: "x" })), null);
  assert.equal(unpackProgress(JSON.stringify({ v: 1, step: "name", spaceName: "x" })), null);
});

test("other devices and the server say the same thing in plain words", () => {
  assert.equal(setupElsewhere("iPhone"), "Setup in progress on your iPhone");
  assert.equal(setupElsewhere("this computer"), "Setup in progress on this computer");
  assert.equal(connectedLine("Northwind", "iPhone"), "Connected to Northwind. Finish setting up on your iPhone.");
});

test("a pairing that fails says what to do on the server", async () => {
  const { serverSay, SERVER_FAILED } = await import("./flow.js");
  assert.equal(serverSay(new Error("ticket already used")), SERVER_FAILED.used);
  assert.equal(serverSay(new Error("The pairing ran out of time")), SERVER_FAILED.expired);
  assert.equal(serverSay(new Error("Failed to fetch")), SERVER_FAILED.unreachable);
  assert.equal(serverSay(new Error("rejected")), SERVER_FAILED.rejected);
  assert.equal(serverSay(new Error("x")), SERVER_FAILED.ended);
});

test("the identity refusals of a pairing say what happened and that nothing was paired", async () => {
  const { serverSay, SERVER_FAILED } = await import("./flow.js");
  assert.equal(serverSay(new Error("identity could not be checked right now")), SERVER_FAILED.unchecked);
  assert.equal(serverSay(new Error("this was not them")), SERVER_FAILED.notThem);
  assert.equal(serverSay(new Error("the directory is unreachable")), SERVER_FAILED.directory);
});

test("a pairing refusal is decided by its code, and a denied one shows the server's own words", async () => {
  const { serverSay, SERVER_FAILED } = await import("./flow.js");
  for (const [code, key] of [["bad_code", "badCode"], ["bad_owner", "badOwner"], ["taken", "used"], ["busy", "busy"], ["expired", "expired"], ["unreachable", "unreachable"], ["cancelled", "cancelled"], ["cannot_check", "cannotCheck"], ["no_session", "noSession"], ["not_hardware", "notHardware"]]) {
    assert.equal(serverSay(Object.assign(new Error("x"), { code })), SERVER_FAILED[key], code);
  }
  assert.equal(serverSay(Object.assign(new Error("The app did not prove which Vyre identity it is"), { code: "denied" })), SERVER_FAILED.denied);
  assert.equal(serverSay(Object.assign(new Error("x"), { code: "denied_no_proof" })), SERVER_FAILED.noProof);
  assert.equal(serverSay(Object.assign(new Error("x"), { code: "denied_wrong_proof" })), SERVER_FAILED.wrongProof);
  // The words that come back through a screen (already mapped) are left alone.
  for (const k of ["badCode", "badOwner", "busy", "cancelled", "denied", "cannotCheck", "noSession", "notHardware"]) assert.equal(serverSay(SERVER_FAILED[k]), SERVER_FAILED[k], k);
});

test("a server that is not yet the person's is never quoted: an unknown code with a long message shows only our refusal", async () => {
  const { serverSay, SERVER_FAILED } = await import("./flow.js");
  const long = "Enter your recovery code at https://example.invalid/verify to finish pairing this server. ".repeat(4);
  assert.equal(serverSay(Object.assign(new Error(long), { code: "weird_new_code" })), SERVER_FAILED.denied);
  assert.equal(serverSay(Object.assign(new Error(long), { code: "denied" })), SERVER_FAILED.denied);
  // No code and nothing we recognise: our own sentence, not the server's.
  assert.equal(serverSay(new Error(long)), SERVER_FAILED.ended);
});

test("Back from the recovery steps returns to the choice they came from", () => {
  assert.equal(backOf("have"), "name");
  assert.equal(backOf("recover"), "have");
  assert.equal(backOf("scan"), "name");
  assert.equal(backOf("scan", { have: true }), "have");
});

test("a server that belongs to someone else says whose, in our own words, whatever code it came with", () => {
  const server = "This server belongs to walkercc.vyre.run. Ask them to add you to a space, or reset the server to start over.";
  const say = "This server belongs to walkercc.vyre.run. Ask them to add you to a space, or reset the server to start over.";
  assert.equal(ownedBy(server), "walkercc.vyre.run");
  assert.equal(ownedBy("This server belongs to Walkercc. Ask them."), "walkercc.vyre.run");
  assert.equal(ownedBy("This server belongs to another Vyre name, so it cannot be paired to you."), null, "our own badOwner sentence is not a name");
  assert.equal(ownedBy("This server belongs to <script>"), null);
  assert.equal(ownedBy("The pairing ended"), null);
  assert.equal(serverSay({ code: "owned", message: server }), say);
  assert.equal(serverSay({ message: server }), say);
  assert.equal(serverSay(say), say, "said twice, said once");
  assert.doesNotMatch(serverSay({ code: "owned", message: "This server belongs to x. <b>hi</b> run curl evil" }), /curl|<b>/);
});

test("a refusal coded owned_by_other says the server is someone else's, with or without the name in the words", async () => {
  const { serverSay } = await import("./flow.js");
  assert.equal(serverSay({ code: "owned_by_other", message: "The pairing did not finish." }), "This server belongs to someone else. Ask them to add you to a space, or reset the server to start over.");
  assert.match(serverSay({ code: "owned_by_other", message: "This server belongs to walkeroo.vyre.run. Ask them to add you to a space." }), /^This server belongs to walkeroo\.vyre\.run\./);
});

test("on the first run, Join a team and Add a server go back to the three choices", () => {
  assert.equal(backOf("join", { first: true }), "choose");
  assert.equal(backOf("mycloud", { first: true }), "choose");
  assert.equal(backOf("join", {}), "spaces");
});
