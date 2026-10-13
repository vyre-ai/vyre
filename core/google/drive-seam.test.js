// @ts-check
// drive-seam: Files > Linked reaches Google Drive as the calling person only, and no error leaves with a token in it.
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { client } from "./api.js";
import { driveSeam, driveClient, strip, NO_ACCOUNT } from "./drive-seam.js";
import { googleDriveProvider } from "../files/linked-gdrive.js";
import { fakeDriveApi } from "../files/linked-gdrive-fake.js";

const OWNER = "per_owner", MEMBER = "per_mia", OTHER = "per_zed";
const own = { name: "home", email: "owner@firm.test", auth: { type: "oauth", item: "g-owner" } };
const firm = { name: "firm", email: "sa@firm.test", firm: true, domain: "firm.test", auth: { type: "service-account", item: "sa" } };
const members = { [MEMBER]: { id: MEMBER, email: "mia@firm.test", verified: true } };

function rig({ all = [own, firm], request = async (/** @type {any} */ _a, /** @type {any} */ _r) => ({ files: [] }) } = {}) {
  const calls = /** @type {any[]} */ ([]);
  const seam = driveSeam({ all: () => all, owner: () => OWNER, memberOf: id => /** @type {any} */ (members)[id], request: async (a, r) => { calls.push([a, r]); return request(a, r); } });
  return { seam, calls };
}
const code = (/** @type {Promise<any>} */ pr) => pr.then(() => null, e => e);

test("the owner runs as their own sign-in, never the firm key", async () => {
  const { seam, calls } = rig();
  await seam.run(OWNER, { path: "/drive/v3/files" });
  assert.equal(calls[0][0].name, "home");
  assert.equal(calls[0][1].scope, "drive.readonly");
});

test("a member runs as the firm key acting as their own work email, and a write asks for the drive scope", async () => {
  const { seam, calls } = rig();
  await seam.run(MEMBER, { method: "PATCH", path: "/drive/v3/files/abc123", body: { name: "x" } });
  assert.equal(calls[0][0].auth.subject, "mia@firm.test");
  assert.equal(calls[0][0].member, MEMBER);
  assert.equal(calls[0][1].scope, "drive");
});

test("a member with no account gets the plain sentence, and never the owner's account", async () => {
  const { seam, calls } = rig();
  for (const who of [OTHER, "x y", ""]) assert.equal((await code(seam.run(who, { path: "/drive/v3/files" }))).message, NO_ACCOUNT);
  const noKey = rig({ all: [own] });
  assert.equal((await code(noKey.seam.run(MEMBER, { path: "/drive/v3/files" }))).message, NO_ACCOUNT);
  assert.equal(noKey.calls.length + calls.length, 0, "nothing was sent to Google");
  const noOwn = rig({ all: [firm] });
  assert.equal((await code(noOwn.seam.run(OWNER, { path: "/drive/v3/files" }))).message, NO_ACCOUNT, "the firm key is not the owner's mailbox");
});

test("only Drive files, changes and uploads pass", async () => {
  const { seam } = rig();
  for (const path of ["/gmail/v1/users/me/messages", "/drive/v3/files/../about", "/drive/v3/about", "/calendar/v3/calendars/primary/events"]) assert.equal((await code(seam.run(OWNER, { path }))).code, "bad_input", path);
  assert.equal((await code(seam.run(OWNER, { method: "PUT", path: "/drive/v3/files" }))).code, "bad_input");
  assert.equal((await code(seam.run(OWNER, { method: "DELETE", path: "/drive/v3/files/abc123" }))).code, "bad_input", "a permanent delete is never offered; the provider trashes");
});

test("an error carrying a bearer token or an access_token comes out stripped and cut to 300", async () => {
  assert.equal(strip("failed with Bearer ya29.secret and more"), "failed with [removed] and more");
  assert.doesNotMatch(strip('{"access_token":"ya29.abc","x":1}'), /ya29/);
  assert.doesNotMatch(strip("Authorization: Bearer ya29.abc"), /ya29/);
  assert.equal(strip("a".repeat(500)).length, 300);
  const leak = Object.assign(new Error("refused Bearer x123 access_token=ya29.zzz " + "p".repeat(400)), { status: 500 });
  const { seam } = rig({ request: async () => { throw leak; } });
  const r = /** @type {any} */ (await seam.run(OWNER, { path: "/drive/v3/files" }));
  assert.equal(r.status, 500);
  assert.doesNotMatch(r.message, /x123|ya29/);
  assert.ok(r.message.length <= 300);
  const thrown = Object.assign(new Error("Bearer x123 down"), { code: "network" });
  const t = rig({ request: async () => { throw thrown; } });
  const e = await code(t.seam.run(OWNER, { path: "/drive/v3/files" }));
  assert.doesNotMatch(e.message, /x123/);
  const c = driveClient(async () => ({ error: { code: "failed", message: "boom Bearer x123" } }));
  assert.doesNotMatch((await code(c.request(OWNER, { path: "/drive/v3/files" }))).message, /x123/);
});

test("the linked Drive provider works end to end through the real seam, as each person's own account", async () => {
  const api = fakeDriveApi();
  api.add({ id: "ROOT", name: "Docs", folder: true });
  api.add({ id: "NOTE", name: "notes.txt", parent: "ROOT", text: "call Dana" });
  api.add({ id: "SECRET", name: "owner.txt", parent: "ROOT", text: "owner only" });
  api.hide("mia@firm.test", "SECRET");
  const { seam } = rig({ request: (a, r) => api.request(a.auth.subject || a.email, { ...r, raw: !!r.raw, body: r.body }) });
  // what registerLinked is given in core/files/index.js, with the tool call replaced by the seam itself
  const p = googleDriveProvider({ client: driveClient(async input => { try { return { data: await seam.run(input.person, input) }; } catch (e) { const err = /** @type {any} */ (e); return { error: { code: err.code, message: err.message } }; } }) });
  const link = { id: "l1", provider: "gdrive", source: { folder: "ROOT" } };
  const mine = await p.list(link, OWNER, {});
  assert.deepEqual(mine.entries.map((/** @type {any} */ e) => e.path).sort(), ["notes.txt", "owner.txt"]);
  const hers = await p.list(link, MEMBER, {});
  assert.deepEqual(hers.entries.map((/** @type {any} */ e) => e.path), ["notes.txt"], "Mia sees what her own account sees");
  const read = await p.read(link, MEMBER, hers.entries[0]);
  assert.equal(Buffer.from(read.bytes).toString(), "call Dana");
  const w = await p.write(link, MEMBER, "new.txt", new TextEncoder().encode("hello"), {});
  assert.ok(w.id);
  assert.equal((await code(p.list(link, OTHER, {}))).message, NO_ACCOUNT);
});

test("the Google client sends bytes as they are and hands a file back as bytes", async () => {
  const sent = /** @type {any[]} */ ([]);
  const creds = /** @type {any} */ ({ headers: async () => ({ authorization: "Bearer t" }), invalidate() {}, scrub: (/** @type {string} */ t) => t });
  const f = /** @type {any} */ (async (/** @type {any} */ url, /** @type {any} */ init) => { sent.push([String(url), init.method, init.headers["content-type"], init.body]); return new Response(init.method === "GET" ? new Uint8Array([0, 255, 7]) : "{\"id\":\"a\"}", { status: 200 }); });
  const { request } = client({ creds, fetch: f });
  const acct = { name: "a", email: "a@x.test", auth: /** @type {any} */ ({}) };
  const up = await request(acct, { api: "drive", scope: "drive", method: "PATCH", path: "/upload/drive/v3/files/abc12", body: new Uint8Array([1, 2, 3]) });
  assert.equal(up.id, "a");
  assert.equal(sent[0][2], "application/octet-stream");
  assert.deepEqual([...sent[0][3]], [1, 2, 3]);
  const got = await request(acct, { api: "drive", scope: "drive.readonly", path: "/drive/v3/files/abc12", raw: /** @type {any} */ ("bytes") });
  assert.deepEqual([...got.bytes], [0, 255, 7]);
});
