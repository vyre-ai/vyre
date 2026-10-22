// What the owner hit live in a chat with the Engineer (20 Oct), kept from coming back: the shared-chat notice in the opening, one Threads (the tab), the /new and /threads help only in the
// slash menu, and the agent said by its name as a person reads it.
import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const read = (/** @type {string} */ p) => fs.readFileSync(new URL(p, import.meta.url), "utf8");

test("who reads a shared agent chat is a calm, centred notice in the chat's opening, in the message column", () => {
  const s = read("./ChatScreen.tsx");
  const head = s.slice(s.indexOf("head={<View"), s.indexOf("jumpTo={jump}"));
  assert.match(head, /engineerChat \? <Text size="caption" tone="label" style=\{\{ textAlign: "center"/, "inside the opening, centred");
  const outside = s.slice(0, s.indexOf("head={<View"));
  assert.doesNotMatch(outside, /Everyone who can use the Engineer reads this chat/, "not a loose line under the header");
});

test("the agent panel has one Threads: the tab; the quick actions are Pin, Find and Mute", () => {
  const s = read("./ChatPanel.tsx");
  const hero = s.slice(s.indexOf("const hero = ("), s.indexOf("const drilled ="));
  assert.doesNotMatch(hero, /label=\{kind === "flow" \? "Runs" : "Threads"\}/);
  assert.match(hero, /label=\{p\.pinned \? "Pinned" : "Pin"\}/);
  assert.match(hero, /label="Find"/);
  assert.match(hero, /label=\{p\.muted \? "Muted" : "Mute"\}/);
});

test("/new and /threads are the slash menu's help, not a line under the composer that never goes away", () => {
  const s = read("./ChatComposer.tsx");
  assert.match(s, /\{p\.agentName && working \? <Text/, "only while the agent works (what Enter and Tab do then)");
  assert.match(s, /trig\?\.kind === "command" \? \(p\.agentName \? agentHint\(p\.agentName, false\)/, "the idle help is the command menu's footer");
});

test("an agent chat is said by the agent's name as a person reads it: header, opening, composer, panel, its computer", () => {
  const screen = read("./ChatScreen.tsx");
  assert.match(screen, /const agentTitle = kind === "agent" && agentNames\[0\] \? agentWords\(agentNames\[0\]\) : "";/);
  assert.match(screen, /<ChatHeader title=\{agentTitle \|\| head\.title\} sub=\{agentTitle \? threadSub\(head\.title, agentNames\[0\]\) : undefined\}/);
  assert.match(screen, /agentName=\{kind === "agent" && agentNames\[0\] \? agentWords\(agentNames\[0\]\) : undefined\}/);
  assert.match(read("./ChatPanel.tsx"), /agentWords\(agents\[0\]\.name\)/);
  assert.match(read("./ComputerTab.tsx"), /<AgentComputerPane name=\{agentWords\(who\)\}/);
});

test("Open in Vyre Files goes to the agent's own folder: the Files page reads ?agent= and opens that place", () => {
  assert.match(read("../../screens/chats/WhoPane.tsx"), /go\(`\/u\/files\?agent=\$\{encodeURIComponent\(name\)\}`/);
  const files = read("../../screens/drive/FilesManager.web.tsx");
  assert.match(files, /const \{ agent, folder \} = useLocalSearchParams<\{ agent\?: string; folder\?: string \}>\(\);/);
  assert.match(files, /agentPlace\(r\?\.agents, String\(agent\)\)/);
});
