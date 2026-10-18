import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Where a session runs is "My Computer" or "Space's Cloud" in the UI (the 0.6 calm UI spec), never "This Mac" or "the server". The files that say where a chat runs are pinned here; a Mac as hardware ("This Mac has no
// Secure Enclave key") and a server that did not answer are not places a session runs, and stay as they are.
const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const FILES = ["screens/runner/runner-model.js", "screens/chat-tools/fork-move.js", "src/chat/ChatComposer.tsx", "src/chat/ChatPanel.tsx", "src/chat/AboutSheet.tsx"];

test("the files that say where a chat runs use My Computer and Space's Cloud, not This Mac or the server", () => {
  for (const f of FILES) {
    const text = fs.readFileSync(path.join(APP, f), "utf8").split("\n").filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
    assert.doesNotMatch(text.replace(/The server did not answer/g, ""), /\b[Tt]his Mac\b|\b[Tt]he server\b/, f);
    assert.match(text, /My Computer|Space's Cloud/, `${f} says where in the new words`);
  }
});
