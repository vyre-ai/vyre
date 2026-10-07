// @ts-check
// computerd carries its own copy of the guard (it is copied alone into the image), so this keeps
// the two in step: the same DENY list, the same verdict on the same paths, and the provider
// talking to the real /fs handler rather than the fake one.

import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { Readable } from "node:stream";
import * as glass from "./guard.js";
import * as computerd from "../computers/image/computerd/fs.js";
import { ComputerProvider } from "./providers/computer.js";
import { SCRATCH } from "../../test/scratch.mjs";

const PATHS = [
  "", ".", "notes.txt", "a/b/c.md", ".ssh", "x/.SSH/known_hosts", ".config/gcloud/creds", ".config/app.json", ".env", ".env.local",
  ".envrc.example", "tls.key", "tls.key.txt", "id_ed25519", "service-account-prod.json", "Login Data", "a/secrets/b", "my-secrets-plan.md",
  "/etc/passwd", "../x", "a/../b", "a\\..\\b", "~/x", "C:\\x", "a\0b", ".vyre-trash/x", ".vyre-upload-1",
];

/** What a guard says about a path: its segments, or "refused". */
const verdict = fn => p => { try { return fn(p); } catch { return "refused"; } };

test("fs parity: computerd's DENY list and rules equal core/glass/guard.js", () => {
  assert.deepEqual([...computerd.DENY], [...glass.DENY], "DENY in computerd/fs.js must equal core/glass/guard.js");
  assert.equal(computerd.TRASH, glass.TRASH);
  assert.equal(computerd.UPLOAD_PREFIX, glass.UPLOAD_PREFIX);
  assert.equal(computerd.MAX_ENTRIES, glass.MAX_ENTRIES);
  for (const p of PATHS) {
    assert.deepEqual(verdict(computerd.checkRel)(p), verdict(glass.checkRel)(p), `checkRel ${JSON.stringify(p)}`);
    const segs = p.split("/");
    assert.equal(computerd.hidden(segs[segs.length - 1], segs.slice(0, -1)), glass.hidden(segs[segs.length - 1], segs.slice(0, -1)), `hidden ${JSON.stringify(p)}`);
    assert.deepEqual(verdict(computerd.checkName)(p), verdict(glass.checkName)(p), `checkName ${JSON.stringify(p)}`);
  }
});

test("fs parity: the computer provider round-trips through the real computerd handler", async t => {
  const dir = fs.mkdtempSync(path.join(SCRATCH, "vyre-parity-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, "todo.txt"), "buy milk\n");
  fs.mkdirSync(path.join(dir, ".ssh"));
  const token = "parity-token";
  const handle = computerd.createFs({ root: dir });
  const server = http.createServer((req, res) => {
    if (req.headers.authorization !== `Bearer ${token}`) { res.writeHead(401); res.end("{}"); return; }
    handle(req, res, new URL(req.url || "/", "http://computerd"));
  });
  await new Promise(r => server.listen(0, "127.0.0.1", () => r(undefined)));
  t.after(() => new Promise(r => { server.closeAllConnections(); server.close(() => r(undefined)); }));
  const url = `http://127.0.0.1:${/** @type {any} */ (server.address()).port}`;
  const p = new ComputerProvider("kit", async tool => tool === "computers.helper" ? { data: { url, token } } : { error: { code: "no_such_tool", message: tool } });

  assert.deepEqual((await p.list("")).entries.map(e => e.name), ["todo.txt"]);
  await p.mkdir("work");
  assert.deepEqual(await p.write("work/a.txt", Readable.from([Buffer.from("hello")]), { size: 5 }), { size: 5 });
  const r = await p.read("work/a.txt", "bytes=1-3");
  let body = "";
  for await (const c of r.stream) body += c;
  assert.equal(body, "ell");
  assert.equal(r.partial, true);
  await assert.rejects(p.write("work/a.txt", Readable.from([Buffer.from("x")]), { size: 1 }), (/** @type {any} */ e) => e.code === "exists");
  await p.move("work/a.txt", "work/b.txt");
  assert.equal((await p.stat("work/b.txt")).size, 5);
  assert.match((await p.trash("work/b.txt")).to, /^\.vyre-trash\//);
  await assert.rejects(p.list(".ssh"), /private place/);
});
