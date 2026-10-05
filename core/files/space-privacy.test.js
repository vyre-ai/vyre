// @ts-check
// A chat's files are its participants' only (kernel/core/folders.js), and the Space Drive's search and shared links are two read paths that must not widen that. The Drive is the kernel's real gateway with
// its folder guard, so every refusal here is the kernel's own; these tests pin that the two paths ask it, and add nothing of their own. A person who is not in the chat and holds the exact path, the exact
// name or the exact link gets absence.
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createKernel } from "../../kernel/index.js";
import { canonical, sha256 } from "../../kernel/core/canonical.js";
import { migrate, open } from "../store/index.js";
import { registerSpaceDrive } from "./space-drive.js";
import { registerSpaceLinks, LINK_MIGRATIONS, LINK_PATH } from "./space-links.js";

const SPACE = "spc_aaaaaaaaaaaa", OWNER = "per_owner", BOB = "per_bob", CAROL = "per_carol", ADA = "per_ada", DAN = "per_dan";
const proof = (/** @type {string} */ action, /** @type {any} */ input, /** @type {string} */ resource) => ({ op: `grant.${action.split(".")[1]}`, fields: { resource, input_hash: sha256(canonical({ action, input })) }, n: Math.random() });
const used = new Set();
const presence = { check: async (/** @type {any} */ { chain, op, fields, proof: p }) => (chain && p && p.op === op && canonical(p.fields) === canonical(fields) && !used.has(p.n) && (used.add(p.n), true) ? null : "wrong_payload") };
const enc = (/** @type {string} */ s) => new TextEncoder().encode(s);

function fakeDrive() {
  const files = new Map();
  return { files,
    async put(/** @type {string} */ p, /** @type {Uint8Array} */ bytes, /** @type {any} */ { by }) { const f = files.get(p) || []; f.push({ ver: f.length + 1, bytes, by }); files.set(p, f); return { version: f.length }; },
    async get(/** @type {string} */ p, /** @type {any} */ { version } = {}) { const f = files.get(p); if (!f) throw Object.assign(new Error("nf"), { code: "not_found" }); return f[(version ?? f.length) - 1].bytes; },
    stat(/** @type {string} */ p) { const f = files.get(p); if (!f) throw Object.assign(new Error("nf"), { code: "not_found" }); return { version: f.length, size: f[f.length - 1].bytes.length }; },
    list(/** @type {string} */ prefix) { return [...files.keys()].filter(k => k.startsWith(prefix)).map(p => ({ path: p, size: files.get(p).at(-1).bytes.length })); },
    history(/** @type {string} */ p) { return (files.get(p) || []).map((/** @type {any} */ v) => ({ ver: v.ver, by: v.by })); },
    async delete(/** @type {string} */ p) { files.delete(p); return { deleted: true }; },
    async restore() { return { version: 1 }; }, async prune() { return { pruned: 0 }; }, async backup() { return { id: "b1" }; }, backups() { return []; }, async restoreBackup() { return {}; }, async pruneBackups() { return {}; },
  };
}

/** The kernel with a chat of BOB and CAROL (and the assistant kit), and the two tool sets over its real gateway; `as(chain)` is who the next call is from. */
async function rig() {
  const drive = fakeDrive();
  const k = await createKernel({ space: SPACE, owner: OWNER, owner_uid: 501, key: Buffer.alloc(32, 7), presence, drive });
  const owner = k.chains.fromFacts({ kind: "device", device_key_id: "d-o", person: OWNER, path: "direct", session: "s" });
  const dev = (/** @type {string} */ person, /** @type {string} */ id) => k.chains.fromFacts({ kind: "device", device_key_id: id, person, path: "direct" });
  const g = k.gateway.grants;
  for (const [p, role] of [[BOB, "member"], [CAROL, "member"], [ADA, "admin"], [DAN, "member"]]) { const r = { person: p, role }; await g.setRole(owner, r, { presence: proof("grants.role", r, `vyre://${SPACE}/member/${p}`) }); }
  const kit = { kind: "agent", id: "kit", space: SPACE };
  await g.addActor(owner, kit, { presence: proof("grants.role", { actor: kit }, `vyre://${SPACE}/member/kit`) });
  const bob = dev(BOB, "d-b"), carol = dev(CAROL, "d-c"), ada = dev(ADA, "d-a"), dan = dev(DAN, "d-d");
  const chat = await g.chats.create(bob, { people: [CAROL], assistants: ["kit"] });
  const dir = `Projects/p1/chat/${chat.id}`, made = `Projects/p1/made/${chat.id}`;
  const D = k.gateway.drive;
  await D.put(bob, `${dir}/retainer-notes.txt`, enc("the client's SSN is 123"));
  await D.put(carol, `${made}/retainer-draft.txt`, enc("draft"));
  await D.put(owner, "Clients/A/retainer-plan.txt", enc("plan"));

  const db = open(path.join(fs.mkdtempSync(path.join(os.tmpdir(), "privacy-")), "vyre.db"));
  /** @type {{ chain: any, list: any }} */ const cur = { chain: owner, list: [{ chat: chat.id, location: `Projects/p1/chat/${chat.id}/` }] };
  const tools = /** @type {Map<string, any>} */ (new Map()), routes = /** @type {Map<string, any>} */ (new Map());
  const ctx = {
    tool: (/** @type {string} */ n, /** @type {any} */ d) => tools.set(n, d), route: (/** @type {string} */ n, /** @type {any} */ f) => routes.set(n, f),
    store: { db, migrate: (/** @type {string[]} */ steps) => migrate(db, "files", steps) },
    // what chats.mine would answer (rows with `chat` and `location`); a test can list a chat the caller is NOT in to show the Drive's own check still refuses the read
    call: async () => ({}),
    kernel: { space: SPACE, owner: OWNER, for: async () => ({ gateway: k.gateway, surfaces: {} }), chainIn: async () => cur.chain, proofFrom: () => undefined,
      // the kernel's chats.mine(chain), stood in for here by the listed rows kept where the kernel's own chat read says the caller is in the chat (the live test uses the real one)
      chats: { mine: async (/** @type {any} */ chain) => (cur.list || []).filter((/** @type {any} */ x) => { try { g.chats.read(chain, x && x.chat); return true; } catch { return false; } }) } },
  };
  registerSpaceDrive(ctx);
  registerSpaceLinks(ctx);
  migrate(db, "files", LINK_MIGRATIONS);
  const as = (/** @type {any} */ chain) => { cur.chain = chain; };
  const run = (/** @type {string} */ n, /** @type {any} */ i) => tools.get(n).run(i, {});
  const code = (/** @type {Promise<any>} */ p) => p.then(() => null, e => e.code);
  const open_ = (/** @type {string} */ c) => new Promise((resolve) => {
    const res = { status: 0, body: /** @type {any} */ (undefined), writeHead(/** @type {number} */ s) { this.status = s; }, end(/** @type {any} */ b) { this.body = b; resolve({ status: this.status, body: b }); } };
    routes.get("s")({ method: "GET" }, res, { url: new URL(`http://vyred${LINK_PATH}?c=${c}`) });
  });
  const listing = (/** @type {any} */ l) => { cur.list = l; };
  return { k, g, D, drive, db, owner, bob, carol, ada, dan, dir, made, chat, as, run, code, open: open_, listing };
}

const paths = (/** @type {any} */ r) => r.results.map((/** @type {any} */ x) => x.path);

test("search: a file, a name or a path in a chat the caller is not in never comes back, even for the exact words; a file outside any chat does", async () => {
  const r = await rig();
  for (const [who, name] of [[r.owner, "the owner"], [r.ada, "an admin"]]) {
    r.as(who);
    for (const q of ["retainer-notes", "retainer-notes.txt", `${r.dir}/retainer-notes.txt`, r.chat.id, "retainer-draft", "made", "chat"]) {
      const res = await r.run("files.drive.space.search", { q });
      assert.deepEqual(paths(res).filter((/** @type {string} */ p) => p.startsWith("Projects/")), [], `${name} searching "${q}" finds nothing of the chat`);
    }
    const ok = await r.run("files.drive.space.search", { q: "retainer" });
    assert.ok(paths(ok).includes("Clients/A/retainer-plan.txt"), `${name} still finds a file outside any chat`);
    assert.equal(paths(ok).some((/** @type {string} */ p) => p.includes(r.chat.id)), false, "and no chat path among the rest");
  }
  // a person in the project with no Drive grant of their own gets no listing at all, never a partial one
  r.as(r.dan);
  assert.deepEqual(paths(await r.run("files.drive.space.search", { q: "retainer" })), []);
  assert.deepEqual(paths(await r.run("files.drive.space.search", { q: "retainer-notes" })), []);
});

test("search answers names and sizes only: no snippet, no content, nothing beyond path, name, size and time", async () => {
  const r = await rig();
  r.as(r.owner);
  const res = await r.run("files.drive.space.search", { q: "retainer" });
  assert.equal(JSON.stringify(res).includes("SSN"), false, "a word from inside a file is never searched or returned");
  assert.deepEqual(await r.run("files.drive.space.search", { q: "123" }).then((x) => x.results), [], "the file's contents are not matched");
  for (const x of res.results) assert.deepEqual(Object.keys(x).filter((k) => !["path", "name", "size", "mtime"].includes(k)), []);
});

test("search: the input is checked, and a chat's files do not count toward the limit", async () => {
  const r = await rig();
  r.as(r.owner);
  assert.equal(await r.code(r.run("files.drive.space.search", { q: "a" })), "bad_input", "one letter is not a search");
  assert.equal(await r.code(r.run("files.drive.space.search", { q: "retainer", limit: 0 })), "bad_input");
  const many = await r.run("files.drive.space.search", { q: "retainer", limit: 1 });
  assert.equal(many.results.length, 1);
  assert.equal(many.more, false, "one visible match and a limit of one is not more: the chat's files never counted");
});

test("shared links: a chat's file is never made a public link, by a participant or by anyone else, and the refusal for an outsider is the same as for a missing file", async () => {
  const r = await rig();
  const file = `${r.dir}/retainer-notes.txt`;
  // an outsider holding the exact path: the kernel refuses the read before anything else is learned
  for (const [who, name] of [[r.owner, "the owner"], [r.ada, "an admin"], [r.dan, "a project member"]]) {
    r.as(who);
    assert.equal(await r.code(r.run("files.drive.link.create", { path: file })), "not_found", `${name} gets absence`);
    assert.equal(await r.code(r.run("files.drive.link.create", { path: `${r.dir}/nothing-here.txt` })), "not_found", `${name}: the same for a file that is not there`);
  }
  // a participant can read it but may not publish it: a link opens for anyone who holds the code
  for (const who of [r.bob, r.carol]) {
    r.as(who);
    assert.equal(await r.code(r.run("files.drive.link.create", { path: file })), "denied");
    assert.equal(await r.code(r.run("files.drive.link.create", { path: `Projects/p1/made/${r.chat.id}/retainer-draft.txt` })), "denied", "nor the chat's made folder");
  }
  assert.equal(r.db.prepare("SELECT COUNT(*) AS n FROM files_links").get().n, 0, "no copy of a chat's file was ever taken");
  // a file outside any chat still works for someone who may read it
  r.as(r.owner);
  const ok = await r.run("files.drive.link.create", { path: "Clients/A/retainer-plan.txt" });
  assert.equal((await r.open(ok.code)).status, 200);
});

test("shared links are checked on every open: a link that points into a chat's folders serves nothing to whoever holds the code", async () => {
  const r = await rig();
  r.as(r.owner);
  const ok = await r.run("files.drive.link.create", { path: "Clients/A/retainer-plan.txt" });
  assert.equal((await r.open(ok.code)).status, 200, "a good link opens");
  // an older link, or one whose path came to lie in a chat's folders, with its copy still stored
  r.db.prepare("UPDATE files_links SET path = ? WHERE code = ?").run(`${r.dir}/retainer-notes.txt`, ok.code);
  const gone = await r.open(ok.code);
  assert.equal(gone.status, 404, "the exact link, held by a non-member, is refused");
  assert.match(String(gone.body), /this link does not work/, "the same words as a wrong or expired code");
  assert.equal(r.db.prepare("SELECT opens FROM files_links WHERE code = ?").get(ok.code).opens, 1, "the refused open was not counted");
  r.as(r.owner);
  assert.equal((await r.run("files.drive.link.list", {})).links.length, 1, "the owner still sees it in the list, to stop it");
});

test("participant search: a person finds file names in the chats they are in, each folder read under their own chain, and the chat is named", async () => {
  const r = await rig();
  for (const who of [r.bob, r.carol]) {
    r.as(who);
    const res = await r.run("files.drive.space.search", { q: "retainer" });
    assert.deepEqual(paths(res).sort(), [`${r.made}/retainer-draft.txt`, `${r.dir}/retainer-notes.txt`].sort(), "both of the chat's folders");
    assert.ok(res.results.every((/** @type {any} */ x) => x.chat === r.chat.id), "each hit names its chat");
    assert.equal(JSON.stringify(res).includes("SSN"), false, "names only, never a word from inside");
    assert.deepEqual(paths(await r.run("files.drive.space.search", { q: "nothing-like-this" })), []);
  }
});

test("participant search: a list that names a chat the caller is not in adds nothing, since the read is the caller's own; a person who left finds nothing the next call", async () => {
  const r = await rig();
  for (const [who, name] of [[r.owner, "the owner"], [r.ada, "an admin"], [r.dan, "a project member"]]) {
    r.as(who);
    r.listing([{ chat: r.chat.id, location: `Projects/p1/chat/${r.chat.id}/` }]); // a bogus list: the chat module would never say this, the kernel must not care
    const res = await r.run("files.drive.space.search", { q: "retainer" });
    assert.deepEqual(paths(res).filter((/** @type {string} */ p) => p.includes(r.chat.id)), [], `${name} is told no file of the chat even when the list names it`);
    assert.equal(res.results.some((/** @type {any} */ x) => x.chat), false);
  }
  r.listing([{ chat: r.chat.id, location: `Projects/p1/chat/${r.chat.id}/` }]);
  r.as(r.bob);
  assert.equal((await r.run("files.drive.space.search", { q: "retainer-notes" })).results.length, 1, "in the chat: found");
  await r.g.chats.change(r.carol, r.chat.id, { remove_people: [BOB] });
  assert.deepEqual((await r.run("files.drive.space.search", { q: "retainer-notes" })).results, [], "left the chat: gone on the next call, whatever the list says");
});

test("participant search: a malformed row, a row for another chat id or a path off the chat folders is skipped, and the Drive root is still searched", async () => {
  const r = await rig();
  r.as(r.owner);
  r.listing([{ chat: "../../etc", location: "Projects/p1/chat/../../etc/" }, { chat: r.chat.id, location: "Projects/../x/chat/" + r.chat.id + "/" }, { chat: r.chat.id, location: `Clients/A/` }, null, "x",
    { chat: "chat_other1234", location: `Projects/p1/chat/${r.chat.id}/` }, { chat: r.chat.id }]);
  const res = await r.run("files.drive.space.search", { q: "retainer" });
  assert.ok(paths(res).includes("Clients/A/retainer-plan.txt"), "the root is still searched");
  assert.deepEqual(paths(res).filter((/** @type {string} */ p) => p.startsWith("Projects/")), [], "none of those rows led anywhere");
});
