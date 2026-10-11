// @ts-check
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { tempHome } from "../../test/helpers.js";
import { chatFolderFor } from "./chat-folder.js";

test("a chat's folder is under the shared work folder on a box (where the spawner starts sessions), per Space, and open to the sessions' group; elsewhere under the module's own folder", t => {
  const root = tempHome(t), work = tempHome(t);
  const saved = process.env.VYRE_WORK_DIR;
  process.env.VYRE_WORK_DIR = work;
  t.after(() => { if (saved === undefined) delete process.env.VYRE_WORK_DIR; else process.env.VYRE_WORK_DIR = saved; });
  const team = chatFolderFor({ root, role: "box", space: "spc_aaaaaaaaaaaa", grp: "chat_1" });
  const home = chatFolderFor({ root, role: "box", grp: "chat_2" });
  assert.equal(path.dirname(path.dirname(team)), path.join(work, "chats", "spc_aaaaaaaaaaaa"));
  assert.equal(path.basename(team), "work");
  assert.ok(fs.statSync(team).isDirectory());
  assert.equal(fs.statSync(team).mode & 0o070, 0o070, "the group the sessions share can use the chat's own folder, as before");
  assert.equal(path.dirname(path.dirname(home)), path.join(work, "chats", "home"), "a home chat has its own place beside the teams'");
  // containment: the parents can be walked through by the group but not listed, and the chat's name is not its id
  for (const d of [path.join(work, "chats"), path.join(work, "chats", "spc_aaaaaaaaaaaa")]) assert.equal(fs.statSync(d).mode & 0o070, 0o010, `${d}: search-only for the group`);
  assert.ok(!team.includes("chat_1"), "the folder name does not carry the chat id");
  assert.equal(chatFolderFor({ root, role: "box", space: "spc_aaaaaaaaaaaa", grp: "chat_1" }), team, "the same chat finds the same folder");
  assert.notEqual(team, chatFolderFor({ root, role: "box", space: "spc_aaaaaaaaaaaa", grp: "chat_9" }));
  const other = tempHome(t);
  assert.notEqual(path.basename(path.dirname(team)), path.basename(path.dirname(chatFolderFor({ root: other, role: "box", space: "spc_aaaaaaaaaaaa", grp: "chat_1" }))), "the name needs the key: another stream folder gives another name");
  assert.equal(fs.statSync(path.join(root, "chat-folder.key")).mode & 0o077, 0, "the key is the stream's alone");
  assert.equal(chatFolderFor({ root, role: "mac", grp: "chat_3" }), path.join(root, "chats", "chat_3", "work"), "off a box: the module's own folder, as before");
  process.env.VYRE_WORK_DIR = path.join(work, "missing");
  assert.equal(chatFolderFor({ root, role: "box", grp: "chat_4" }), path.join(root, "chats", "chat_4", "work"), "a box with no work folder keeps the module's own");
});
