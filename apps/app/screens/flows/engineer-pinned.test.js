// @ts-check
// The Flows page's @Engineer conversation is the pinned @Engineer chat (R031-94, 0.3.3 G25): the one Settings opens and the chats list shows, so what was said there is on the same page everywhere. Source-level, the
// screen needs a renderer; the real-daemon walk is team/0.3.3/proof/G25/.
import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const src = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "RealEngineer.tsx"), "utf8");

test("the Engineer page opens the pinned chat and never a thread of its own", () => {
  assert.match(src, /ensurePersistent\("engineer"\)/, "it asks for the pinned Engineer chat");
  assert.match(src, /<ChatScreen sessionId=\{chat\}/, "the chat shown is that one");
  assert.doesNotMatch(src, /sessionId=\{agent\.thread\}/, "not the agent's own thread");
});
