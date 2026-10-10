// @ts-check
// The daemon asks a chat's name for the list of what runs on a person's computer (contracts/lent-spawn.md titles): any chat id, only a module may ask, at most 120 characters.
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { start } from "../daemon/index.js";
import { tempHome, present, asOwner } from "../../test/helpers.js";
import { createRing, holdersOf } from "../../lib/chat-keys.js";

process.env.VYRE_SEAL_DEV = "1";
process.env.VYRE_KERNEL_PATH_RULE = "1";

test("work.chat.title answers a chat's name to a module, cut at 120 characters, and refuses a person's surface", { timeout: 120_000 }, async t => {
  const root = tempHome(t);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ name: "test-box", role: "box" }));
  const d = await start({ root, presence: present, log: () => {}, kernel: true });
  asOwner(d, root);
  t.after(() => d.stop());
  const dev = crypto.createECDH("prime256v1"); dev.generateKeys();
  const id = `chat_${crypto.randomUUID()}`;
  const ring = createRing(id, holdersOf([{ device: "dev_app", agree: dev.getPublicKey().toString("base64url") }]));
  const long = "Harlow intake ".repeat(20);
  const made = await d.registry.call("work.chat.create", { title: long, id, ring: ring.doc, people: [], agents: [] }, "cli");
  assert.ok(!made.error, JSON.stringify(made.error));
  const asked = await d.registry.call("work.chat.title", { chat: id }, "module:vyred");
  assert.ok(!asked.error, JSON.stringify(asked.error));
  assert.equal(asked.data.title, long.slice(0, 120));
  assert.equal((await d.registry.call("work.chat.title", { chat: "chat_nobody" }, "module:vyred")).data.title, "", "a chat nobody made has no name");
  assert.ok((await d.registry.call("work.chat.title", { chat: id }, "cli")).error, "a person's surface does not ask this");
});
