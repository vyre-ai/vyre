// @ts-check
import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { newKey } from "../../../../lib/databox.js";
import { decryptUserMessage, sealUserMessage } from "./private-text.js";

test("decryptUserMessage opens a vyre-chat-v1 payload with the opener's key", async () => {
  const kid = "dev:alice#1";
  const key = newKey();
  const enc = sealUserMessage(kid, key, "meet at noon");
  const plain = await decryptUserMessage(enc, async (k) => (k === kid ? key : null));
  assert.equal(plain, "meet at noon");
  assert.equal(await decryptUserMessage(enc, async () => null), null);
});
