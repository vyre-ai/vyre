// The installer's pairing step (scripts/install-box.sh pair_server) says what `vyre up` says (core/cli/pair-words.js): every sentence's fixed parts are in the script, and the typed-code step calls the
// daemon's own tools (wink.code.status, wink.server.confirm). The words are launch's: they come from one file.
import "../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { PAIR_WORDS } from "../core/cli/pair-words.js";

const script = fs.readFileSync(new URL("../scripts/install-box.sh", import.meta.url), "utf8");

test("every sentence the terminal says while pairing is in the installer, word for word (the parts between the filled-in values)", () => {
  for (const [key, sentence] of Object.entries(PAIR_WORDS)) {
    for (const part of String(sentence).split(/\{\w+\}/).map(x => x.trim()).filter(x => x.length > 3)) assert.ok(script.includes(part), `${key}: "${part}"`);
  }
});

test("the typed-code step reads wink.code.status and sends the typed ack to wink.server.confirm, and asks for it with the prompt", () => {
  assert.ok(script.includes("wink.code.status") && script.includes("wink.server.confirm"));
  assert.ok(script.includes("Type the code your app shows: "));
  assert.ok(script.includes("code_expires") && script.includes("code_tries"), "the life and the tries come from the server's answer");
});
