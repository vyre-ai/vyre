// @ts-check
// The Chat record on a Basic device (no server): the kernel's own SQLite store holds it, `chat-record` is on the Basic allow list, and the SAME writer (core/work/hub.js, through the kernel's records
// handle) makes, mirrors and lists a chat there as on a Cloud space.
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SCRATCH } from "../../test/scratch.mjs";
import { bootKernel } from "../../kernel/boot.js";
import { basicAllow, BASIC_REFUSAL } from "../../records/basic-types.js";
import { CHAT } from "../../records/core-types.js";
import { createHub } from "./hub.js";

const SPACE = "spc_aaaaaaaaaaaa", OWNER = "per_owner";
// the Project a Basic device keeps: the same fields the hub writes, with no link to a contact (there are no contacts on Basic)
const PROJECT = { name: "project", label: "Project", fields: [{ name: "name", kind: "text", label: "Name" }, { name: "slug", kind: "text", label: "Short name" }, { name: "status", kind: "choice", label: "Status", options: ["active", "archived", "moved"] }, { name: "drive_path", kind: "text", label: "Drive folder" }, { name: "memory_scope", kind: "text", label: "Memory scope" }] };

test("a Basic device writes and lists a chat through the same hub writer: made from the kernel's chat.created, mirrored on chat.changed, filled by a run, and listed with its fields", async () => {
  const db = new DatabaseSync(path.join(fs.mkdtempSync(path.join(SCRATCH, "vyre-basic-chat-")), "kernel.db"));
  const k = await bootKernel({ db, space: SPACE, owner: OWNER, owner_uid: 501, key: Buffer.alloc(32, 9), presenceCheck: async () => null, basic: { allow: basicAllow(), refusal: BASIC_REFUSAL } });
  const owner = k.chains.fromFacts({ kind: "device", device_key_id: "d-owner", person: OWNER, path: "direct", session: "s1" });
  await k.gateway.records.define(owner, { add_types: [PROJECT, CHAT] });
  const hub = createHub({ kernel: { space: SPACE, owner: OWNER, serviceChain: () => owner, records: k.gateway.records }, call: async () => ({ data: null }) });
  await hub.onChatCreated({ data: { chat: { id: "chat_basic1", people: [OWNER], assistants: [] } } });
  await hub.onChatChanged({ data: { id: "chat_basic1", people: [OWNER, "per_friend"], assistants: ["kit"] } });
  await hub.onStarted({ chat: "chat_basic1", name: "Docket", project: null });
  const listed = (await k.gateway.records.query(owner, "chat-record", { page: { limit: 10 } })).rows;
  assert.equal(listed.length, 1, "one chat, listed on the Basic store");
  const d = listed[0].data;
  assert.deepEqual([d.chat, d.title, d.people, d.agents, d.status], ["chat_basic1", "Docket", `${OWNER},per_friend`, "kit", "working"]);
  assert.ok(d.project && d.location.endsWith("/chat/chat_basic1/"), "filed in General, with its folder");
  // still the one record after a restart of the writer
  const again = createHub({ kernel: { space: SPACE, owner: OWNER, serviceChain: () => owner, records: k.gateway.records }, call: async () => ({ data: null }) });
  assert.equal((await again.chatRecord("chat_basic1")).data.title, "Docket");
});
