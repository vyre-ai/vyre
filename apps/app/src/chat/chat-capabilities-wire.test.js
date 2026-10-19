// @ts-check
// Item (9): real chat surfaces use design-library capability components (composer, messages, panel, tools).
import "../../../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));

test("ChatScreen wires capability chrome, planner note, and composer menu shortcuts", () => {
  const src = fs.readFileSync(path.join(root, "ChatScreen.tsx"), "utf8");
  assert.match(src, /useChatCapabilityChrome/);
  assert.match(src, /LaterPlannerBar/);
  assert.match(src, /BackgroundTasksCard|caps\.ui/);
  assert.match(src, /onMenuCapability/);
  assert.match(src, /onLocalCommand/);
  assert.match(src, /openRewind|rewindTo/);
  assert.match(src, /openSecondOpinion/);
  assert.match(src, /onMemory=\{.*\/u\/memory/);
  assert.match(src, /onExport=.*\/export/);
  assert.match(src, /onRoll=.*\/roll/);
  assert.match(src, /later\.noteFromSend/);
});

test("ChatPanel and ChatToolsSheet expose panel capability rows and fallback tool pages", () => {
  const panel = fs.readFileSync(path.join(root, "ChatPanel.tsx"), "utf8");
  const tools = fs.readFileSync(path.join(root, "../../screens/chat-tools/ChatToolsSheet.tsx"), "utf8");
  assert.match(panel, /PanelCapabilityRows/);
  assert.match(panel, /onContext=\{.*onPage\("context"\)/);
  assert.match(panel, /TasksPage|onPage\("tasks"\)/);
  assert.match(tools, /PanelCapabilityRows/);
  assert.match(tools, /go\("context"\)/);
  assert.match(tools, /go\("tasks"\)/);
  assert.match(tools, /go\("transcript"\)/);
});

test("MessageBar exposes rewind and second opinion actions", () => {
  const bar = fs.readFileSync(path.join(root, "MessageBar.tsx"), "utf8");
  assert.match(bar, /onRewindTo/);
  assert.match(bar, /onSecondOpinion/);
  const menu = fs.readFileSync(path.join(root, "message-menu-model.js"), "utf8"); // the labels live in the menu's model, which the bar draws
  assert.match(bar, /messageMenu/);
  assert.match(menu, /Rewind to here/);
  assert.match(menu, /Second opinion/);
});

test("chat UX wiring: rewind forks first, actions follow the driver's caps, a failed reply offers Try again, Retry sits on answers, Tab queues", () => {
  const chrome = fs.readFileSync(path.join(root, "ChatCapabilityChrome.tsx"), "utf8");
  const rewind = chrome.slice(chrome.indexOf("const doRewind"), chrome.indexOf("const doOpinion"));
  assert.ok(rewind.indexOf('branch("")') > 0 && rewind.indexOf('branch("")') < rewind.indexOf("/rewind "), "the later messages are forked before going back");
  assert.match(chrome, /secondOpinionTargets\(faces, opinionAuthor, provRows\)/, "second opinion offers connected accounts");
  const screen = fs.readFileSync(path.join(root, "ChatScreen.tsx"), "utf8");
  assert.match(screen, /setMay\(threadMay\(d\?\.thread\)\)/, "caps come from threads.get");
  assert.match(screen, /\.\.\.\(may\.rewind \? \{\s*onEditMessage[\s\S]*onRetryMessage[\s\S]*onRewindTo[\s\S]*\} : \{\}\)/, "Edit, Retry and Rewind only when the driver can go back");
  assert.match(screen, /\(forkAsThread\.current \? may\.fork : may\.branch\) \? \{ onBranchFrom/, "Fork only when the driver can fork");
  assert.match(screen, /onTryAgain:/);
  const rows = fs.readFileSync(path.join(root, "ChatRows.tsx"), "utf8");
  assert.match(rows, /it\.retry[\s\S]{0,400}label="Try again"/);
  const bar = fs.readFileSync(path.join(root, "MessageBar.tsx"), "utf8");
  assert.match(bar, /!mine && uuid && done && ctx\.onRetryMessage \? ctx\.askedBefore/, "Retry on an answer retries the person's message before it");
  assert.match(bar, /id === "copy-text"/);
  const composer = fs.readFileSync(path.join(root, "ChatComposer.tsx"), "utf8");
  assert.match(composer, /tabQueues\(ev,[\s\S]{0,120}send\("queue"\)/);
  assert.match(composer, /whileWorking\(mode, !!p\.phone\)\.placeholder/);
  assert.match(composer, /whileWorking\(mode, !!p\.phone\)\.button/);
});

test("ChatCapabilityChrome uses design-library sheets and cards", () => {
  const chrome = fs.readFileSync(path.join(root, "ChatCapabilityChrome.tsx"), "utf8");
  assert.match(chrome, /@vyre\/ui/);
  assert.match(chrome, /RewindSheet/);
  assert.match(chrome, /SecondOpinionSheet/);
  assert.match(chrome, /BackgroundTasksCard/);
  assert.match(chrome, /LaterPlannerNote/);
  assert.match(chrome, /stream\.second-opinion/);
});
