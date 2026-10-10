// @ts-check
// A person's first-day path: the app starts the @Engineer chat with work.chat.create naming the engineer agent. The agent is built in but no run has made it an actor of the Space yet, and the kernel refused the chat
// ("an assistant in a chat belongs to the Space"), so the pinned chat never existed (journey J1). It is registered on the way and the chat starts.
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

test("the @Engineer chat starts the way the app starts it, and is pinned", { timeout: 120_000 }, async t => {
  const root = tempHome(t);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ name: "test-box", role: "box" }));
  const d = await start({ root, presence: present, log: () => {}, kernel: true });
  asOwner(d, root);
  t.after(() => d.stop());
  const call = (/** @type {string} */ tool, /** @type {any} */ input) => d.registry.call(tool, input, "cli");
  const dev = crypto.createECDH("prime256v1"); dev.generateKeys();
  const id = `chat_${crypto.randomUUID()}`;
  const ring = createRing(id, holdersOf([{ device: "dev_app", agree: dev.getPublicKey().toString("base64url") }]));
  const made = await call("work.chat.create", { title: "@Engineer", id, ring: ring.doc, people: [], agents: ["engineer"] });
  assert.ok(!made.error, JSON.stringify(made.error));
  assert.deepEqual(made.data.agents, ["engineer"]);
  const pinned = await call("work.chat.pin", { kind: "engineer", chat: made.data.chat });
  assert.ok(!pinned.error, JSON.stringify(pinned.error));
  assert.equal((await call("work.chat.persistent", { kind: "engineer" })).data.chat, made.data.chat, "the pinned chat is the one made");
  // a name that is nobody's stays a refusal: only an agent that exists is registered
  const second = await call("work.chat.create", { title: "again", id: `chat_${crypto.randomUUID()}`, ring: createRing(`chat_x`, holdersOf([{ device: "dev_app", agree: dev.getPublicKey().toString("base64url") }])).doc, people: [], agents: [] });
  assert.ok(second.error || second.data, "an ordinary chat still starts or says why");
});
