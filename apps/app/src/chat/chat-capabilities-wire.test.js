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
  assert.match(bar, /Rewind to here/);
  assert.match(bar, /Second opinion/);
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
