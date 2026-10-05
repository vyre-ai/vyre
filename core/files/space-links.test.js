// @ts-check
// Shared links to a Drive file (core/files/space-links.js): the copy is taken under the caller's own chain, expires, is revoked by deleting the copy, and the read route answers one way for
// every bad code. The Drive is a fake gateway that records what it is asked; the store is a real in-memory sqlite.
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { migrate, open } from "../store/index.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { registerSpaceLinks, mimeOf, MAX_DAYS, LINK_PATH } from "./space-links.js";

const SPACE = "spc_abcdefghijkl";
const person = { hops: [{ actor: { kind: "person", id: "per_alex", space: SPACE } }] };
const DAY = 86_400_000;

function rig({ chain = person, drive = true } = {}) {
  const db = open(path.join(fs.mkdtempSync(path.join(os.tmpdir(), "links-")), "vyre.db"));
  const files = /** @type {Map<string, Buffer>} */ (new Map([["Clients/A/retainer.pdf", Buffer.from("v1 bytes")], ["Clients/A/page.html", Buffer.from("<script>x</script>")]]));
  const calls = /** @type {any[]} */ ([]);
  const gd = { async get(/** @type {any} */ c, /** @type {string} */ p, /** @type {any} */ o) { calls.push(["get", c, p, o]); const b = files.get(p); if (!b) throw Object.assign(new Error("the drive could not do that"), { code: "not_found" }); return new Uint8Array(b); } };
  const tools = /** @type {Map<string, any>} */ (new Map()), routes = /** @type {Map<string, any>} */ (new Map());
  const clock = { t: 1_800_000_000_000 };
  const ctx = {
    tool: (/** @type {string} */ n, /** @type {any} */ d) => tools.set(n, d), route: (/** @type {string} */ n, /** @type {any} */ f, /** @type {any} */ o) => routes.set(n, { f, o }),
    store: { db, migrate: (/** @type {string[]} */ steps) => migrate(db, "files", steps) },
    kernel: { space: SPACE, owner: "per_alex", for: async () => ({ gateway: drive ? { drive: gd } : {}, surfaces: {} }), chainIn: async () => { if (!chain) throw Object.assign(new Error("x"), { code: "denied" }); return chain; }, proofFrom: () => undefined },
  };
  registerSpaceLinks(ctx, { now: () => clock.t });
  const run = (/** @type {string} */ n, /** @type {any} */ i, /** @type {any} */ meta = {}) => tools.get(n).run(i, meta);
  /** @param {string} q @param {string} [method] */
  const get = (q, method = "GET") => new Promise((resolve) => {
    const res = { status: 0, headers: /** @type {any} */ ({}), body: /** @type {any} */ (undefined), writeHead(/** @type {number} */ s, /** @type {any} */ h) { this.status = s; this.headers = h; }, end(/** @type {any} */ b) { this.body = b; resolve(this); } };
    routes.get("s").f({ method }, res, { caller: "anonymous", url: new URL(`http://vyred${LINK_PATH}${q}`) });
  });
  return { run, get, files, calls, tools, routes, clock, db };
}
const code = (/** @type {Promise<any>} */ p) => p.then(() => null, e => e.code);

test("create takes a copy under the caller's own chain and answers a code, a url and an expiry; the tools are the person's, outward, with presence", async () => {
  const r = rig();
  assert.deepEqual([...r.tools.keys()].sort(), ["files.drive.link.create", "files.drive.link.list", "files.drive.link.revoke"]);
  assert.ok(r.tools.get("files.drive.link.create").presence, "a person's own create carries presence");
  assert.match(await r.tools.get("files.drive.link.create").presence.summary({ path: "Clients/A/retainer.pdf" }), /Share Clients\/A\/retainer\.pdf with a link/);
  const l = await r.run("files.drive.link.create", { path: "Clients/A/retainer.pdf" });
  assert.match(l.code, /^[A-Za-z0-9_-]{22}$/);
  assert.equal(l.url, `${LINK_PATH}?c=${l.code}`);
  assert.equal(l.name, "retainer.pdf"); assert.equal(l.size, 8);
  assert.equal(l.expires, r.clock.t + 7 * DAY);
  assert.equal(r.calls[0][1], person, "the call's own chain");
  assert.deepEqual(r.calls[0][3], { version: null, maxBytes: 8 * 1024 * 1024 });
  const two = await r.run("files.drive.link.create", { path: "Clients/A/retainer.pdf", version: 2, days: 1 });
  assert.notEqual(two.code, l.code);
  assert.equal(two.expires, r.clock.t + DAY);
  assert.equal(r.calls[1][3].version, 2);
});

test("the read route serves the copy as a download, counts the open, and a later edit is not shown", async () => {
  const r = rig();
  const l = await r.run("files.drive.link.create", { path: "Clients/A/retainer.pdf" });
  r.files.set("Clients/A/retainer.pdf", Buffer.from("edited later"));
  const got = /** @type {any} */ (await r.get(`?c=${l.code}`));
  assert.equal(got.status, 200);
  assert.equal(Buffer.from(got.body).toString(), "v1 bytes");
  assert.equal(got.headers["content-type"], "application/pdf");
  assert.match(got.headers["content-disposition"], /^attachment; filename="retainer\.pdf"$/);
  assert.equal(got.headers["cache-control"], "no-store");
  assert.equal(got.headers["x-content-type-options"], "nosniff");
  assert.equal(got.headers["content-security-policy"], "sandbox");
  const head = /** @type {any} */ (await r.get(`?c=${l.code}`, "HEAD"));
  assert.equal(head.body, undefined);
  const list = await r.run("files.drive.link.list", {});
  assert.equal(list.links[0].opens, 2);
  assert.equal(list.links[0].active, true);
  assert.ok(!JSON.stringify(list).includes("v1 bytes") && !("bytes" in list.links[0]), "the list never carries the bytes");
});

test("a page is bytes, not a page: html is an octet-stream download", async () => {
  const r = rig();
  const l = await r.run("files.drive.link.create", { path: "Clients/A/page.html" });
  const got = /** @type {any} */ (await r.get(`?c=${l.code}`));
  assert.equal(got.headers["content-type"], "application/octet-stream");
  assert.equal(mimeOf("a.svg"), "application/octet-stream");
  assert.equal(mimeOf("noext"), "application/octet-stream");
  assert.equal(mimeOf("A.PNG"), "image/png");
});

test("an expired, revoked, wrong or malformed code gets the same answer", async () => {
  const r = rig();
  const a = await r.run("files.drive.link.create", { path: "Clients/A/retainer.pdf", days: 1 });
  const b = await r.run("files.drive.link.create", { path: "Clients/A/retainer.pdf" });
  const bad = /** @type {any[]} */ ([]);
  r.clock.t += 2 * DAY;
  bad.push(await r.get(`?c=${a.code}`));
  assert.equal((await r.run("files.drive.link.list", {})).links.find((/** @type {any} */ x) => x.code === a.code).active, false, "expired reads as not active");
  assert.deepEqual(await r.run("files.drive.link.revoke", { code: b.code }), { revoked: true });
  bad.push(await r.get(`?c=${b.code}`), await r.get(`?c=${"A".repeat(22)}`), await r.get("?c=short"), await r.get(""), await r.get(`?c=${b.code}%00`));
  for (const x of bad) { assert.equal(x.status, 404); assert.equal(x.body, bad[0].body, "one body for all of them"); }
  const row = r.db.prepare("SELECT bytes FROM files_links WHERE code = ?").get(b.code);
  assert.equal(/** @type {any} */ (row).bytes, null, "revoking deletes the copy");
  assert.equal(await code(r.run("files.drive.link.revoke", { code: b.code })), "not_found", "twice is not found");
  assert.equal(await code(r.run("files.drive.link.revoke", { code: "nope" })), "bad_input");
});

test("paths, versions and days are checked before the Drive is touched; a missing file and a Space with no Drive say so", async () => {
  const r = rig();
  for (const p of ["../x", "/abs", "a//b", ""]) assert.equal(await code(r.run("files.drive.link.create", { path: p })), "bad_input", p);
  assert.equal(await code(r.run("files.drive.link.create", { path: "a/b", version: 0 })), "bad_input");
  for (const days of [0, -1, MAX_DAYS + 1, 1.5, "7"]) assert.equal(await code(r.run("files.drive.link.create", { path: "Clients/A/retainer.pdf", days })), "bad_input", String(days));
  assert.equal(r.calls.length, 0, "nothing reached the Drive");
  assert.equal(await code(r.run("files.drive.link.create", { path: "Clients/A/nope.pdf" })), "not_found");
  assert.equal(await code(rig({ drive: false }).run("files.drive.link.create", { path: "a/b" })), "unavailable");
  assert.deepEqual((await r.run("files.drive.link.list", {})).links, [], "a refused create stores nothing");
});

test("a call that proved no person is refused by all three tools", async () => {
  const none = rig({ chain: /** @type {any} */ (null) });
  for (const [n, i] of [["files.drive.link.create", { path: "a/b" }], ["files.drive.link.list", {}], ["files.drive.link.revoke", { code: "A".repeat(22) }]]) assert.equal(await code(none.run(/** @type {string} */ (n), i)), "denied", /** @type {string} */ (n));
});

test("the file is too large to share", async () => {
  const r = rig();
  r.files.set("big", Buffer.alloc(8 * 1024 * 1024 + 1));
  assert.equal(await code(r.run("files.drive.link.create", { path: "big" })), "too_large");
});
