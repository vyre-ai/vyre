// @ts-check
// Files through the forward: a Drive file sent by reference (a plain body or a multipart form), a download saved straight into the Drive, per-route size, content-type and Drive
// path limits, outward sends held with the files named and pinned to their versions, streams that never sit whole in memory, and no credential value anywhere.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { open, migrate } from "../store/index.js";
import { Vault, MIGRATIONS } from "./vault.js";
import * as saidTools from "./said.js";
import { register } from "./request.js";
import { SCRATCH } from "../../test/scratch.mjs";
import { startSealer } from "../../kernel/seal/client.js";
import { person } from "../../kernel/seal/testing.js";
import { leasedForward, normalizeRoute } from "../../kernel/seal/uses.js";
import { Pool } from "../../kernel/storage/pool.js";
import { Drive, driveFiles } from "../../kernel/storage/drive.js";
import { memoryBackend } from "../../kernel/storage/backends.js";

const MB = 1 << 20, SESSION = "sess1", fake = l => `fixture-${l}-${crypto.randomBytes(12).toString("hex")}`;
const sha = b => crypto.createHash("sha256").update(b).digest("hex");

async function mk(t, routeOver = {}, { filesFor = null } = {}) {
  const home = fs.mkdtempSync(path.join(SCRATCH, "vyre-fwdf-")), db = open(path.join(home, "vyre.db"));
  migrate(db, "vault", MIGRATIONS);
  const v = new Vault({ db, dir: path.join(home, "vault"), config: { name: "harlow-box", vault: { keystore: "file" } }, emit: () => {}, log: () => {} });
  const pool = new Pool({ dir: path.join(home, "pool"), key: Buffer.alloc(32, 5), chunk: MB }); pool.addNode({ id: "home", backend: memoryBackend(), home: true, offered: 500 * MB }); pool.addNode({ id: "nas", backend: memoryBackend(), offered: 500 * MB });
  const drive = new Drive(pool), files = driveFiles(drive);
  t.after(() => { db.close(); fs.rmSync(home, { recursive: true, force: true }); });
  let clock = 1_800_000_000_000; const net = { calls: /** @type {any[]} */ ([]), reply: /** @type {(c: any) => any} */ (() => ({ status: 200, headers: { "content-type": "application/json" }, chunks: [Buffer.from("{}")] })) };
  const lookup = async () => [{ address: "93.184.216.10", family: 4 }];
  // The fake stream transport consumes the request body as a stream (counting chunks and hashing) and answers with a scripted stream.
  const streamTransport = async r => {
    const rec = { host: r.url.hostname, path: r.url.pathname, method: r.method, headers: r.headers, length: r.length, chunks: 0, bytes: 0, hash: crypto.createHash("sha256"), raw: /** @type {Buffer[]} */ ([]), maxChunk: 0 };
    if (r.body) for await (const c of r.body) { rec.chunks++; rec.bytes += c.length; rec.maxChunk = Math.max(rec.maxChunk, c.length); rec.hash.update(c); if (rec.bytes < 4 * MB) rec.raw.push(Buffer.from(c)); }
    net.calls.push(rec); const rep = net.reply(rec); let aborted = false;
    return { status: rep.status, headers: rep.headers, stream: (async function* () { for (const c of rep.chunks) { if (aborted) return; yield c; } })(), abort: () => { aborted = true; } };
  };
  const gateItems = new Map();
  const gate = async (tool, input) => tool === "gate.offer" ? { data: {} } : tool === "gate.request" ? (() => { const id = `task_${gateItems.size + 1}`; gateItems.set(id, { via: "vault-api", by: "per_alex", draft: input.content, final: input.content }); return { data: { id, state: "held", message: "waiting for a person" } }; })()
    : tool === "gate.get" ? { data: { ...gateItems.get(input.id), state: "sending" } } : { error: { code: "no_such_tool", message: tool } };
  const tools = new Map(), tool = (n, c, d, i, run) => tools.set(n, { run }), internal = (n, d, i, run) => tools.set(n, { run });
  const said = saidTools.register({ vault: v, internal });
  register({ vault: v, tool, internal, call: gate, said, deps: { lookup, streamTransport, now: () => clock, ...(filesFor ? { filesFor: s => filesFor(s, files) } : { files }) } });
  const run = (name, input, caller = "cli") => tools.get(name).run(input, { caller });
  // The REAL sealing process holds the lease and a REAL kernel chain stands for the person. SHIM(gateway-forward): `leasedForward` is composed here, the kernel's gateway has no `leases.forward` yet.
  const sealer = startSealer({ dir: fs.mkdtempSync(path.join(SCRATCH, "vyre-fwdfs-")), timeoutMs: 8000, dev: true }); t.after(() => sealer.close());
  const who = person("per_alex"), lease = await sealer.lease.issue({ chain: who, device: "dev_mac", allowed: true }), leases = { revoke: () => sealer.lease.revoke({ chain: who, member: "per_alex", device: "dev_mac" }) };
  const routes = new Map([[SESSION, [normalizeRoute({ route: "api.hellosign.test", ref: "dropsign", allow: [{ method: "GET", path: "/v3/*" }, { method: "POST", path: "/v3/*" }], contentTypes: ["application/pdf", "multipart/form-data", "application/json"],
    drive: { read: ["clients/jane/*"], write: ["inbox/*"] }, ...routeOver })]]]);
  const S = fake("dropsign");
  await v.put({ name: "dropsign", kind: "api-credential", fields: { config: JSON.stringify({ auth: { type: "bearer" }, hosts: ["api.hellosign.test"], endpoints: [{ method: "POST", path: "/v3/signature_request/send", kind: "send" }, { method: "GET", path: "/v3/*", kind: "read" }] }), secret: S } }, "cli");
  const go = leasedForward({ chain: who, leaseOf: s => (s === SESSION ? lease.id : null), check: ({ id }) => sealer.lease.check({ chain: who, id }), routesOf: s => routes.get(s) ?? [],
    forward: async () => { throw new Error("not this path"); }, forwardFile: i => run("vault.forward.file", { credential: i.ref, method: i.method, url: `https://${i.route}${i.path}`, query: i.query, headers: i.headers, allow_headers: i.allow_headers, upload: i.upload, saveTo: i.saveTo, stream: i.stream, limits: i.limits, drive: i.drive, session: SESSION }, "kernel:leases") });
  const call = (o) => go({ session: SESSION, route: "api.hellosign.test", method: "GET", ...o });
  const audits = () => JSON.stringify(db.prepare("SELECT * FROM vault_audit").all());
  return { v, net, drive, pool, run, call, S, gateItems, audits, files, leases, lease, tick: ms => { clock += ms; } };
}
const approve = (m, id) => m.run("vault.api.send", { id }, "module:gate");

test("upload by Drive reference: held with the file named, nothing sent until approved, then streamed in chunks with the exact bytes and the key added at the home", async t => {
  const m = await mk(t), pdf = crypto.randomBytes(3 * MB + 17); await m.drive.put("clients/jane/retainer.pdf", pdf, { by: "per_alex" });
  const held = await m.call({ method: "POST", path: "/v3/signature_request/send", upload: { drive: { path: "clients/jane/retainer.pdf", contentType: "application/pdf" } } });
  assert.ok(held.held); assert.match(held.summary, /retainer\.pdf \(3\.0 MB\)/); assert.equal(m.net.calls.length, 0, "nothing went out while it waits"); assert.equal(JSON.stringify(held).includes(m.S), false);
  // The file is changed after it was held: the approved send is the version the person saw.
  await m.drive.put("clients/jane/retainer.pdf", crypto.randomBytes(1000), { by: "per_alex", base: 1 });
  m.net.reply = () => ({ status: 200, headers: { "content-type": "application/json" }, chunks: [Buffer.from('{"signature_request_id":"sr1"}')] });
  const out = await approve(m, held.held); assert.equal(out.status, 200);
  const c = m.net.calls[0]; assert.equal(c.hash.digest("hex"), sha(pdf), "exactly the held version's bytes"); assert.equal(c.length, pdf.length); assert.ok(c.chunks >= 3 && c.maxChunk <= MB, `streamed in chunks of at most 1 MB: ${c.chunks} chunks, largest ${c.maxChunk}`);
  assert.equal(c.headers["content-type"], "application/pdf"); assert.equal(c.headers.authorization, `Bearer ${m.S}`);
  assert.equal(JSON.stringify(out).includes(m.S), false); assert.equal(m.audits().includes(m.S), false);
  // A held record whose hash is tampered with is refused.
  const h2 = await m.call({ method: "POST", path: "/v3/signature_request/send", upload: { drive: { path: "clients/jane/retainer.pdf", version: 2, contentType: "application/pdf" } } });
  m.gateItems.get(h2.held).final = { ...m.gateItems.get(h2.held).final, hash: "0".repeat(64) }; await assert.rejects(approve(m, h2.held), /changed after it was held|card was not made/);
});

test("a multipart form of text fields and Drive files is built as a stream, with its exact length, and held like any send", async t => {
  const m = await mk(t), doc = crypto.randomBytes(2 * MB + 5), cover = Buffer.from("cover letter"); await m.drive.put("clients/jane/a.pdf", doc); await m.drive.put("clients/jane/b.pdf", cover);
  const held = await m.call({ method: "POST", path: "/v3/signature_request/send", upload: { multipart: [{ name: "title", value: "Retainer" }, { name: "file[0]", filename: "a.pdf", contentType: "application/pdf", drive: { path: "clients/jane/a.pdf" } }, { name: "file[1]", filename: "b.pdf", contentType: "application/pdf", drive: { path: "clients/jane/b.pdf" } }] } });
  assert.match(held.summary, /a\.pdf.*b\.pdf/); assert.equal(m.net.calls.length, 0);
  await approve(m, held.held); const c = m.net.calls[0], body = Buffer.concat(c.raw);
  assert.match(c.headers["content-type"], /^multipart\/form-data; boundary=vyre[0-9a-f]{24}$/); assert.equal(c.length, c.bytes, "the declared length is the real length");
  assert.ok(body.includes(Buffer.from('name="title"\r\n\r\nRetainer')) && body.includes(Buffer.from('filename="a.pdf"')) && body.includes(Buffer.from("Content-Type: application/pdf")));
  for (const bad of [{ name: 'x"y', value: "1" }, { name: "f", filename: "a\r\nb.pdf", contentType: "application/pdf", drive: { path: "clients/jane/a.pdf" } }]) await assert.rejects(m.call({ method: "POST", path: "/v3/signature_request/send", upload: { multipart: [bad] } }), /plain name/);
});

test("a download is saved straight into the Drive in chunks and answered with a reference; over the cap it stops and leaves nothing", async t => {
  const m = await mk(t), file = crypto.randomBytes(5 * MB + 3), pieces = []; for (let o = 0; o < file.length; o += 400_000) pieces.push(file.subarray(o, o + 400_000));
  m.net.reply = () => ({ status: 200, headers: { "content-type": "application/pdf", "content-length": String(file.length) }, chunks: pieces });
  const out = await m.call({ path: "/v3/signature_request/files/sr1", saveTo: "inbox/sr1.pdf" });
  assert.equal(out.status, 200); assert.deepEqual(out.saved, { path: "inbox/sr1.pdf", version: 1, size: file.length, sha256: sha(file) }); assert.equal(out.body, undefined, "no bytes come back on the forward");
  assert.deepEqual(Buffer.concat([]).length, 0); assert.deepEqual(await m.drive.get("inbox/sr1.pdf"), file);
  // Over a route's own cap: stopped, nothing saved, no orphan chunks.
  const small = await mk(t, { maxBytes: 2 * MB }); small.net.reply = () => ({ status: 200, headers: { "content-type": "application/pdf" }, chunks: pieces });
  const before = Object.keys(small.pool.ix.chunks).length; await assert.rejects(small.call({ path: "/v3/x", saveTo: "inbox/big.pdf" }), { code: "too_large" });
  assert.equal(Object.keys(small.pool.ix.chunks).length, before, "a stopped save leaves no chunks"); assert.deepEqual(small.drive.list(), []);
  small.net.reply = () => ({ status: 200, headers: { "content-type": "application/pdf", "content-length": String(10 * MB) }, chunks: [Buffer.from("x")] }); await assert.rejects(small.call({ path: "/v3/x", saveTo: "inbox/big.pdf" }), { code: "too_large" });
  const sizeCap = await mk(t, { maxBytes: 1 * MB }); await sizeCap.drive.put("clients/jane/big.pdf", crypto.randomBytes(2 * MB));
  await assert.rejects(sizeCap.call({ method: "POST", path: "/v3/signature_request/send", upload: { drive: { path: "clients/jane/big.pdf", contentType: "application/pdf" } } }), { code: "too_large" });
});

test("the route's content types and Drive paths are enforced: a response type, a request type, a path outside the lists, and a file response with nowhere to go", async t => {
  const m = await mk(t); await m.drive.put("clients/jane/a.pdf", Buffer.from("x")); await m.drive.put("private/secret.pdf", Buffer.from("y"));
  m.net.reply = () => ({ status: 200, headers: { "content-type": "application/zip" }, chunks: [Buffer.from("PK")] }); await assert.rejects(m.call({ path: "/v3/x", saveTo: "inbox/a.zip" }), { code: "type_refused" });
  await assert.rejects(m.call({ method: "POST", path: "/v3/signature_request/send", upload: { drive: { path: "clients/jane/a.pdf", contentType: "application/x-msdownload" } } }), { code: "type_refused" });
  await assert.rejects(m.call({ method: "POST", path: "/v3/signature_request/send", upload: { drive: { path: "private/secret.pdf", contentType: "application/pdf" } } }), { code: "not_found" }, "a Drive path the route may not read");
  await assert.rejects(m.call({ path: "/v3/x", saveTo: "clients/jane/overwrite.pdf" }), { code: "not_found" }, "a Drive path the route may not write");
  // A file as a stream for an in-process caller: the same limits, nothing saved.
  m.net.reply = () => ({ status: 200, headers: { "content-type": "application/pdf" }, chunks: [Buffer.from("%PDF"), Buffer.from("-1.4")] });
  const st = await m.call({ path: "/v3/x", stream: true }); const got = []; for await (const c of st.stream) got.push(c); assert.equal(Buffer.concat(got).toString(), "%PDF-1.4");
  await assert.rejects(m.call({ path: "/v3/x", saveTo: "inbox/../etc" }), /plain name|not_found|Drive/);
});

test("no credential value passes: a token split across two chunks of a download is caught, withheld and not saved; an error answer is scrubbed", async t => {
  const m = await mk(t), half = Math.floor(m.S.length / 2);
  m.net.reply = () => ({ status: 200, headers: { "content-type": "application/pdf" }, chunks: [Buffer.concat([Buffer.from("%PDF-1.4 "), Buffer.from(m.S.slice(0, half))]), Buffer.concat([Buffer.from(m.S.slice(half)), Buffer.from(" end")])] });
  await assert.rejects(m.call({ path: "/v3/leak", saveTo: "inbox/leak.pdf" }), { code: "withheld" }); assert.deepEqual(m.drive.list(), [], "nothing was saved");
  m.net.reply = r => ({ status: 401, headers: { "content-type": "application/json" }, chunks: [Buffer.from(JSON.stringify({ error: `bad key ${r.headers.authorization}` }))] });
  const e = await m.call({ path: "/v3/x", saveTo: "inbox/e.pdf" }); assert.equal(e.status, 401); assert.equal(e.body.toString().includes(m.S), false); assert.equal(m.audits().includes(m.S), false);
});

test("FW-2: the Drive is reached as the lent member: the kernel's Drive door decides, and a route's Drive lists only narrow what it allows", async t => {
  const asked = [], member = ({ session }, files) => { asked.push(session); return { read: async (p, v) => { if (p.startsWith("clients/jane/private")) throw Object.assign(new Error("not_found"), { code: "not_found" }); return files.read(p, v); }, write: (p, src, o) => files.write(p, src, o) }; };
  const m = await mk(t, {}, { filesFor: member }); await m.drive.put("clients/jane/ok.pdf", Buffer.from("fine")); await m.drive.put("clients/jane/private.pdf", Buffer.from("not for this member"));
  const up = path => ({ method: "POST", path: "/v3/signature_request/send", upload: { drive: { path, contentType: "application/pdf" } } });
  assert.ok((await m.call(up("clients/jane/ok.pdf"))).held, "a file the member may read, on a path the route lists, is held for approval");
  await assert.rejects(m.call(up("clients/jane/private.pdf")), { code: "not_found" }); // the route lists the whole folder; the member's own door refuses this file
  assert.deepEqual([...new Set(asked)], [SESSION], "the Drive door was asked for this session's member every time");
  await assert.rejects(m.call(up("private/other.pdf")), { code: "not_found" }, "and a path the route does not list is refused before the door is asked");
});
