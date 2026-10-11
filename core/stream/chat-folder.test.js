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
  assert.equal(team, path.join(work, "chats", "spc_aaaaaaaaaaaa", "chat_1", "work"));
  assert.ok(fs.statSync(team).isDirectory());
  assert.equal(fs.statSync(team).mode & 0o070, 0o070, "the group the sessions share can use it");
  assert.equal(chatFolderFor({ root, role: "box", grp: "chat_2" }), path.join(work, "chats", "home", "chat_2", "work"), "a home chat has its own place beside the teams'");
  assert.equal(chatFolderFor({ root, role: "mac", grp: "chat_3" }), path.join(root, "chats", "chat_3", "work"), "off a box: the module's own folder, as before");
  process.env.VYRE_WORK_DIR = path.join(work, "missing");
  assert.equal(chatFolderFor({ root, role: "box", grp: "chat_4" }), path.join(root, "chats", "chat_4", "work"), "a box with no work folder keeps the module's own");
});
