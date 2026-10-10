// @ts-check
// The chat's files over a fake kernel: stored under the person's chain in the chat's folder as <id>-<name>, listed by name, read by id, and not found for a chat the person is not in.
import "../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { put, list, find, read, materialise, folderOf } from "./attachments-store.js";
import { parseStored } from "./attachments.js";
import { SCRATCH } from "../test/scratch.mjs";

/** A kernel with one chat folder; `deny` is a chain that is not in the chat. */
function fakeKernel() {
  /** @type {Map<string, Uint8Array>} */ const files = new Map();
  const mine = { id: "me" }, deny = { id: "stranger" };
  const guard = (/** @type {any} */ chain) => { if (chain !== mine) throw Object.assign(new Error("no"), { code: "not_allowed" }); };
  return {
    mine, deny, files,
    records: { query: async (/** @type {any} */ chain, /** @type {string} */ type, /** @type {any} */ spec) => ({ rows: type === "chat-record" && spec.filter.value === "chat_1" ? [{ data: { drive: "Projects/harlow", chat: "chat_1" } }] : [] }) },
    drive: {
      put: async (/** @type {any} */ chain, /** @type {string} */ p, /** @type {Uint8Array} */ b) => { guard(chain); files.set(p, b); },
      list: async (/** @type {any} */ chain, /** @type {string} */ folder) => { guard(chain); return [...files].filter(([p]) => p.startsWith(`${folder}/`)).map(([p, b]) => ({ path: p, size: b.length })); },
      get: async (/** @type {any} */ chain, /** @type {string} */ p) => { guard(chain); const b = files.get(p); if (!b) throw Object.assign(new Error("none"), { code: "not_found" }); return b; },
    },
  };
}
const pdf = Buffer.from("%PDF-1.4\n%%EOF\n");

test("a file is stored in the chat's folder as <id>-<name>, listed by its own name, and read back by id", async () => {
  const k = fakeKernel();
  const a = await put(k, k.mine, "chat_1", { name: "offer letter.pdf", bytes: new Uint8Array(pdf) });
  assert.match(a.id, /^att_[A-Za-z0-9_-]{22}$/);
  assert.deepEqual([a.name, a.mime, a.bytes], ["offer letter.pdf", "application/pdf", pdf.length]);
  const [stored] = [...k.files.keys()];
  assert.equal(stored, `Projects/harlow/chat/chat_1/${a.id}-offer letter.pdf`);
  assert.deepEqual(parseStored(path.basename(stored)), { id: a.id, name: "offer letter.pdf" });
  assert.deepEqual((await list(k, k.mine, "chat_1")).map(x => [x.id, x.name, x.mime, x.bytes]), [[a.id, "offer letter.pdf", "application/pdf", pdf.length]]);
  k.files.set("Projects/harlow/chat/chat_1/typed by hand.txt", new Uint8Array(1));
  assert.equal((await list(k, k.mine, "chat_1")).length, 1, "a file not added through attachments is not an attachment");
  assert.ok((await read(k, k.mine, "chat_1", a.id)).equals(pdf));
});

test("a stranger, an unknown id and a chat with no folder find nothing", async () => {
  const k = fakeKernel();
  const a = await put(k, k.mine, "chat_1", { name: "a.txt", bytes: new Uint8Array([1, 2]) });
  await assert.rejects(put(k, k.deny, "chat_1", { name: "b.txt", bytes: new Uint8Array([1]) }), { code: "denied" });
  assert.deepEqual(await list(k, k.deny, "chat_1"), []);
  await assert.rejects(find(k, k.mine, "chat_1", "att_nope000000000000000"), { code: "not_found" });
  await assert.rejects(read(k, k.deny, "chat_1", a.id), { code: "not_found" });
  await assert.rejects(folderOf(k, k.mine, "chat_2"), { code: "unavailable" });
  await assert.rejects(put(k, k.mine, "chat_1", { name: "x.txt", bytes: new Uint8Array(0) }), { code: "bad_input" });
  await assert.rejects(put(k, k.mine, "chat_1", { name: "big.png", bytes: new Uint8Array(5 * 1024 * 1024 + 1) }), { code: "bad_input" });
  await assert.rejects(put(k, k.mine, "chat_1", { name: "big.pdf", bytes: new Uint8Array(8 * 1024 * 1024 + 1) }), { code: "bad_input" });
});

test("a file is put where a model reads it: 0600, in a folder that ignores itself", async t => {
  const k = fakeKernel();
  const a = await put(k, k.mine, "chat_1", { name: "ledger.csv", bytes: new TextEncoder().encode("a,b\n1,2\n") });
  const cwd = fs.mkdtempSync(path.join(SCRATCH, "vyre-att-")); t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const file = await materialise(k, k.mine, "chat_1", cwd, a);
  assert.equal(file, path.join(cwd, ".vyre", "attachments", `${a.id}-ledger.csv`));
  assert.equal(fs.readFileSync(file, "utf8"), "a,b\n1,2\n");
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(fs.readFileSync(path.join(cwd, ".vyre", "attachments", ".gitignore"), "utf8"), "*\n");
  await assert.rejects(materialise(k, k.deny, "chat_1", cwd, a), { code: "not_found" });
});
