// @ts-check
// dropbox-seam: Files > Linked reaches Dropbox as the calling person only, on a fixed host list, with no permanent delete, a 25 MB read cap, and no token in any error.
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { dropboxSeam, dropboxClient, strip, headerJson, NO_TOKEN, HOSTS, MAX_READ } from "./dropbox-seam.js";
import { dropboxProvider } from "./linked-dropbox.js";
import { fakeDropboxApi, dropboxFetch } from "./linked-dropbox-fake.js";

const TOKENS = /** @type {Record<string, string>} */ ({ "sl.ALEXTOKEN1234567890abcdef": "per_alex" });
const link = { id: "lnk_1", provider: "dropbox", source: { path: "/Client docs" } };
const code = (/** @type {Promise<any>} */ pr) => pr.then(() => null, e => e);

function rig(/** @type {{ fetch?: any, tokenFor?: (p: string) => Promise<string> }} */ o = {}) {
  const api = fakeDropboxApi();
  api.add({ path: "/Client docs", folder: true });
  api.add({ path: "/Client docs/notes.txt", text: "call Dana" });
  const f = dropboxFetch(api, TOKENS);
  const seam = dropboxSeam({ tokenFor: o.tokenFor || (async person => { const t = Object.keys(TOKENS).find(k => TOKENS[k] === person); if (!t) throw new Error("no item"); return t; }), fetch: o.fetch || f });
  return { api, f, seam };
}

test("end to end: the provider over the client over the seam over a fake Dropbox lists, reads, writes, renames and trashes", async () => {
  const { api, f, seam } = rig();
  const p = dropboxProvider({ client: dropboxClient(async input => { try { return { data: await seam.run(input.person, input) }; } catch (e) { return { error: /** @type {any} */ (e) }; } }) });
  const r = await p.list(link, "per_alex", {});
  assert.deepEqual(r.entries.map(e => e.path), ["notes.txt"]);
  assert.equal(Buffer.from((await p.read(link, "per_alex", r.entries[0])).bytes).toString(), "call Dana");
  const made = await p.write(link, "per_alex", "Sub/é ü.txt", Buffer.from("héllo"));
  assert.equal(Buffer.from((await p.read(link, "per_alex", { id: made.id })).bytes).toString(), "héllo", "non-ASCII names survive the header");
  await p.rename(link, "per_alex", r.entries[0], "renamed.txt");
  await p.delete(link, "per_alex", { id: made.id });
  assert.equal(api.nodes.get(made.id).path, "/Client docs/Vyre Trash/é ü.txt");
  assert.equal(api.permanentDeletes, 0);
  assert.ok(f.urls.length > 5 && f.urls.every(u => [`https://${HOSTS.rpc}/`, `https://${HOSTS.content}/`].some(h => u.startsWith(h))), "every request went to one of the two Dropbox hosts");
  assert.ok(f.urls.some(u => u.startsWith(`https://${HOSTS.content}/2/files/upload`)) && f.urls.some(u => u.startsWith(`https://${HOSTS.rpc}/2/files/list_folder`)));
});

test("a person with no Dropbox item gets the plain sentence, and nothing is sent", async () => {
  const { seam, f } = rig();
  for (const who of ["per_nobody", "per_other"]) {
    const e = await code(seam.run(who, { path: "/2/files/list_folder", args: { path: "/Client docs" } }));
    assert.equal(e.message, NO_TOKEN);
    assert.equal(e.code, "no_account");
  }
  assert.equal((await code(seam.run("x y", { path: "/2/files/list_folder", args: {} }))).message, NO_TOKEN, "a malformed person id is the same sentence");
  const empty = rig({ tokenFor: async () => "" });
  assert.equal((await code(empty.seam.run("per_alex", { path: "/2/files/list_folder", args: {} }))).message, NO_TOKEN);
  assert.equal(f.urls.length + empty.f.urls.length, 0, "no request left");
});

test("each call carries only that person's token; a dead token is a 401 answered, with no token in it", async () => {
  const { seam, f } = rig({ tokenFor: async () => "sl.NOTAREALTOKEN0000000000" });
  const r = await seam.run("per_alex", { path: "/2/files/list_folder", args: { path: "/Client docs" } });
  assert.equal(r.status, 401);
  assert.equal(f.inits[0].headers.Authorization, "Bearer sl.NOTAREALTOKEN0000000000");
  assert.doesNotMatch(JSON.stringify(r), /NOTAREAL/);
});

test("an error carrying the token, a bearer token or an access_token comes out stripped and cut to 300", async () => {
  const t = "sl.SECRETSECRETSECRET1234567890";
  assert.doesNotMatch(strip(`failed for ${t} and Bearer ${t}`, t), /SECRET/);
  assert.doesNotMatch(strip('{"access_token":"abcdef123456","x":1}'), /abcdef123456/);
  assert.doesNotMatch(strip("Authorization: Bearer sl.abcdefghijklmnopqrstuv"), /abcdefghijkl/);
  assert.equal(strip("a".repeat(500)).length, 300);
  const echo = rig({ fetch: async (/** @type {string} */ _u, /** @type {any} */ init) => new Response(JSON.stringify({ error_summary: `rejected ${init.headers.Authorization} ${"p".repeat(400)}` }), { status: 400 }) });
  const r = await echo.seam.run("per_alex", { path: "/2/files/get_metadata", args: { path: "/x" } });
  assert.equal(r.status, 400);
  assert.ok(String(r.message).length <= 300);
  assert.doesNotMatch(String(r.message), /ALEXTOKEN/);
  const boom = rig({ fetch: async (/** @type {string} */ _u, /** @type {any} */ init) => { throw new Error(`socket hang up while sending ${init.headers.Authorization}`); } });
  const e = await code(boom.seam.run("per_alex", { path: "/2/files/get_metadata", args: { path: "/x" } }));
  assert.doesNotMatch(e.message, /ALEXTOKEN/);
  assert.equal(e.code, "unavailable");
  // and through the client the tool's caller sees
  const c = dropboxClient(async () => ({ error: { code: "failed", message: `bad Bearer ${t}` } }));
  assert.doesNotMatch((await code(c.request("per_alex", { path: "/2/files/list_folder" }))).message, /SECRET/);
});

test("a permanent delete is never offered, however it is spelled", async () => {
  const { seam, f, api } = rig();
  for (const path of ["/2/files/delete_v2", "/2/files/delete", "/2/files/permanently_delete", "/2/files/delete_batch", "/2/files/DELETE_V2"]) {
    const e = await code(seam.run("per_alex", { path, args: { path: "/Client docs/notes.txt" } }));
    assert.equal(e.code, "denied", path);
    assert.match(e.message, /Vyre Trash/);
  }
  assert.equal(f.urls.length, 0);
  assert.equal(api.permanentDeletes, 0);
  assert.ok([...api.nodes.values()].every(n => !n.deleted));
});

test("only the fixed Dropbox file calls pass, and a host or URL in the input is never followed", async () => {
  const { seam, f } = rig();
  for (const path of ["https://evil.example/2/files/list_folder", "//evil.example/2/files/list_folder", "/2/users/get_current_account", "/2/files/list_folder/../../sharing/list_shared_links", "/2/sharing/create_shared_link_with_settings", "/2/files/list_folder?x=1", "", "/2/files/download/extra"]) {
    assert.equal((await code(seam.run("per_alex", { path, args: {} }))).code, "bad_input", path);
  }
  await seam.run("per_alex", /** @type {any} */ ({ path: "/2/files/get_metadata", args: { path: "/Client docs" }, host: "evil.example", url: "https://evil.example/x" }));
  assert.ok(f.urls.length === 1 && f.urls[0] === `https://${HOSTS.rpc}/2/files/get_metadata`, f.urls.join());
  assert.equal(f.inits[0].redirect, "error", "a redirect is refused, so the token cannot follow one");
  assert.deepEqual(Object.values(HOSTS).sort(), ["api.dropboxapi.com", "content.dropboxapi.com"]);
});

test("a read stops at 25 MB, by the declared length and by the bytes that arrive", async () => {
  const big = (/** @type {Record<string, string>} */ h, /** @type {number} */ n) => async () => new Response(new Uint8Array(n), { status: 200, headers: { "dropbox-api-result": "{}", ...h } });
  const declared = rig({ fetch: async () => new Response("x", { status: 200, headers: { "content-length": String(MAX_READ + 1), "dropbox-api-result": "{}" } }) });
  assert.equal((await code(declared.seam.run("per_alex", { path: "/2/files/download", args: { path: "id:x" } }))).code, "too_large");
  const streamed = rig({ fetch: big({}, MAX_READ + 10) });
  const e = await code(streamed.seam.run("per_alex", { path: "/2/files/download", args: { path: "id:x" } }));
  assert.equal(e.code, "too_large");
  assert.match(e.message, /25 MB/);
  const ok = rig({ fetch: big({}, 1024) });
  assert.equal((await ok.seam.run("per_alex", { path: "/2/files/download", args: { path: "id:x" } })).status, 200);
  const up = rig();
  assert.equal((await code(up.seam.run("per_alex", { path: "/2/files/upload", args: { path: "/Client docs/x" }, bodyB64: Buffer.alloc(26 * 1024 * 1024).toString("base64") }))).code, "too_large");
  assert.equal(up.f.urls.length, 0, "an oversize upload is never sent");
});

test("header JSON is plain ASCII", () => {
  assert.equal(headerJson({ path: "/é/日本.txt" }), '{"path":"/\\u00e9/\\u65e5\\u672c.txt"}');
  assert.match(headerJson({ a: "ok" }), /^[\x20-\x7e]*$/);
});
