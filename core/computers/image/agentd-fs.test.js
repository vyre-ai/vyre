// @ts-check
// agentd-fs: one file operation in an agent's home, as Vyre Files asks for it through the relay. The helper is served on a temp home here (the image runs it as the agent's uid on its real home):
// the round trip of every operation, path confinement (.., absolute paths, a symlink out of the home, the Downloads link read-only), a short write leaving nothing behind, and the relay's side:
// an fs ticket carries one checked operation, is told it as its first line, and starts the helper as that agent with no capability.

import "../../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { PassThrough } from "node:stream";
import { spawn } from "node:child_process";
import { serveFs, HOME_OF, DOWNLOADS_OF } from "./agentd-fs.js";
import { validateFs, FS_OPS, FS_WRITE_MAX } from "./agentd.js";
import { Tickets, createRelay, FS } from "./agentd-relay.js";
import { SCRATCH } from "../../../test/scratch.mjs";

const U = { user: "ag20003", uid: 20003, display: 23 };
const T1 = "f".repeat(32);

/** A home with the agent's tidy folders, a Downloads link to a folder outside it, a secret, and a link that leads out. */
function world(t) {
  const top = fs.mkdtempSync(path.join(SCRATCH, "agentd-fs-"));
  t.after(() => fs.rmSync(top, { recursive: true, force: true }));
  const home = path.join(top, "agents", "ag20003", "home"), downloads = path.join(top, "downloads", "ag20003"), other = path.join(top, "agents", "ag20004", "home");
  for (const d of [home, downloads, other]) fs.mkdirSync(d, { recursive: true });
  for (const f of ["Inbox", "Work", "Done", "Scripts", "Notes"]) fs.mkdirSync(path.join(home, f));
  fs.symlinkSync(downloads, path.join(home, "Downloads"));
  fs.writeFileSync(path.join(downloads, "report.pdf"), "pdf-bytes");
  fs.writeFileSync(path.join(home, "Work", "plan.md"), "# plan\n");
  fs.mkdirSync(path.join(home, ".ssh")); fs.writeFileSync(path.join(home, ".ssh", "id_ed25519"), "secret");
  fs.writeFileSync(path.join(other, "theirs.txt"), "not yours");
  fs.symlinkSync(other, path.join(home, "to-other"));
  fs.symlinkSync("/etc", path.join(home, "to-etc"));
  return { home, downloads, other };
}

/** One operation through the helper: the request line, then the body; the answer's header line and bytes. @returns {Promise<{ status: number, headers: any, body: Buffer, json: any }>} */
async function call(w, spec, body = Buffer.alloc(0)) {
  const input = new PassThrough(), output = new PassThrough();
  const chunks = []; output.on("data", c => chunks.push(c));
  input.end(Buffer.concat([Buffer.from(JSON.stringify(spec) + "\n"), body]));
  await serveFs({ root: w.home, downloads: w.downloads, input, output });
  const all = Buffer.concat(chunks), nl = all.indexOf(10);
  const head = JSON.parse(all.subarray(0, nl).toString("utf8")), rest = all.subarray(nl + 1);
  let json = null; try { json = JSON.parse(rest.toString("utf8")); } catch {}
  return { status: head.status, headers: head.headers, body: rest, json };
}

test("the home and the downloads folder come from the uid alone", () => {
  assert.equal(HOME_OF(20003), "/var/lib/vyre/agents/ag20003/home");
  assert.equal(DOWNLOADS_OF(20003), "/var/lib/vyre/downloads/ag20003");
  const src = fs.readFileSync(new URL("./agentd-fs.js", import.meta.url), "utf8");
  assert.match(src, /uid < 20000 \|\| uid > 20063/, "only an agent's own uid runs it");
  assert.match(src, /serveFs\(\{ root: HOME_OF\(uid\), downloads: DOWNLOADS_OF\(uid\)/, "the folders follow from the uid, never from the request");
  assert.doesNotMatch(src, /process\.env/, "nothing from the environment names a folder");
  assert.match(src, /from "\.\/computerd\/fs\.js"/, "the routes are computerd's own, the ones Glass Files uses");
});

test("list, stat, read, write, mkdir, move and trash round-trip in the agent's home", async t => {
  const w = world(t);
  const top = await call(w, { op: "list", path: "" });
  assert.equal(top.status, 200);
  const names = top.json.entries.map(e => e.name);
  for (const n of ["Inbox", "Work", "Done", "Scripts", "Notes", "Downloads"]) assert.ok(names.includes(n), n);
  assert.ok(!names.includes(".ssh"), "a private name is never listed");
  assert.deepEqual(top.json.entries.find(e => e.name === "Downloads"), { name: "Downloads", kind: "dir", size: null, mtime: null, readOnly: true }, "Downloads is shown as the folder it is, read-only, never by its target");

  const put = await call(w, { op: "write", path: "Inbox/note.txt", size: 5, overwrite: false }, Buffer.from("hello"));
  assert.equal(put.status, 200, JSON.stringify(put.json));
  assert.equal(fs.readFileSync(path.join(w.home, "Inbox", "note.txt"), "utf8"), "hello");
  assert.equal((await call(w, { op: "write", path: "Inbox/note.txt", size: 2, overwrite: false }, Buffer.from("no"))).status, 409, "an existing file is not replaced unless asked");
  assert.equal((await call(w, { op: "write", path: "Inbox/note.txt", size: 3, overwrite: true }, Buffer.from("bye"))).status, 200);
  const got = await call(w, { op: "read", path: "Inbox/note.txt" });
  assert.equal(got.status, 200); assert.equal(got.body.toString(), "bye");
  const part = await call(w, { op: "read", path: "Work/plan.md", range: "bytes=0-1" });
  assert.equal(part.status, 206); assert.equal(part.body.toString(), "# ");
  const st = await call(w, { op: "stat", path: "Work/plan.md" });
  assert.equal(st.json.kind, "file"); assert.equal(st.json.size, 7);
  assert.equal((await call(w, { op: "mkdir", path: "Work/drafts" })).status, 200);
  assert.ok(fs.statSync(path.join(w.home, "Work", "drafts")).isDirectory());
  assert.equal((await call(w, { op: "move", from: "Inbox/note.txt", to: "Work/drafts/note.txt" })).status, 200);
  assert.ok(fs.existsSync(path.join(w.home, "Work", "drafts", "note.txt")) && !fs.existsSync(path.join(w.home, "Inbox", "note.txt")));
  const gone = await call(w, { op: "trash", path: "Work/drafts/note.txt" });
  assert.equal(gone.status, 200); assert.match(gone.json.to, /^\.vyre-trash\//, "a delete is a move to the home's trash, never an unlink");
  assert.ok(!fs.existsSync(path.join(w.home, "Work", "drafts", "note.txt")));
  assert.ok(!(await call(w, { op: "list", path: "" })).json.entries.some(e => e.name === ".vyre-trash"), "the trash is not listed");
  const dl = await call(w, { op: "read", path: "Downloads/report.pdf" });
  assert.equal(dl.status, 200); assert.equal(dl.body.toString(), "pdf-bytes", "a download reads through the Downloads folder");
});

test("paths stay in the home: .., absolute paths, a link out of it and the private names are refused, and nothing outside is touched", async t => {
  const w = world(t);
  for (const p of ["../ag20004/home/theirs.txt", "Work/../../ag20004/home/theirs.txt", "/etc/passwd", "~/x", "C:/x"]) {
    const r = await call(w, { op: "read", path: p });
    assert.equal(r.status, 400, p); assert.equal(r.json.error.code, "bad_path", p);
    assert.doesNotMatch(r.body.toString(), /agents\/ag20003|SCRATCH|\/tmp\//, "a refusal never carries an absolute path");
  }
  for (const p of ["to-other/theirs.txt", "to-etc/passwd"]) assert.equal((await call(w, { op: "read", path: p })).status, 403, `${p}: a link out of the home is refused`);
  assert.equal((await call(w, { op: "list", path: "to-other" })).status, 403, "and so is listing through it");
  assert.equal((await call(w, { op: "write", path: "to-other/planted.txt", size: 1 }, Buffer.from("x"))).status, 403, "a write through a link out of the home is refused");
  assert.ok(!fs.existsSync(path.join(w.other, "planted.txt")), "nothing landed in another agent's home");
  assert.equal((await call(w, { op: "move", from: "Work/plan.md", to: "to-other/plan.md" })).status, 403, "a move out through a link is refused");
  assert.ok(fs.existsSync(path.join(w.home, "Work", "plan.md")));
  assert.equal((await call(w, { op: "read", path: ".ssh/id_ed25519" })).status, 403, "a private name is never opened");
  assert.equal((await call(w, { op: "write", path: "Downloads/x.txt", size: 1 }, Buffer.from("x"))).status, 403, "Downloads is read-only");
  assert.equal((await call(w, { op: "trash", path: "Downloads/report.pdf" })).status, 403, "and nothing in it is deleted");
  assert.equal((await call(w, { op: "move", from: "Downloads/report.pdf", to: "Work/report.pdf" })).status, 403, "or moved out");
  assert.ok(fs.existsSync(path.join(w.downloads, "report.pdf")));
});

test("a write that sends fewer bytes than it said leaves nothing behind; a request that is not one is refused", async t => {
  const w = world(t);
  const short = await call(w, { op: "write", path: "Inbox/short.txt", size: 10 }, Buffer.from("abc"));
  assert.equal(short.status, 400); assert.equal(short.json.error.code, "wrong_size");
  assert.deepEqual(fs.readdirSync(path.join(w.home, "Inbox")), [], "no partial file and no upload temp is left");
  const extra = await call(w, { op: "write", path: "Inbox/exact.txt", size: 2 }, Buffer.from("abcdef"));
  assert.equal(extra.status, 200); assert.equal(fs.readFileSync(path.join(w.home, "Inbox", "exact.txt"), "utf8"), "ab", "bytes past the size are never read");
  assert.equal((await call(w, { op: "chmod", path: "Work" })).status, 400);
  const input = new PassThrough(), output = new PassThrough(); const chunks = []; output.on("data", c => chunks.push(c));
  input.end("not json\n");
  await serveFs({ root: w.home, input, output });
  assert.match(Buffer.concat(chunks).toString(), /^\{"status":400/);
});

test("validateFs: an operation, relative paths and a stated size, nothing else", () => {
  assert.deepEqual([...FS_OPS], ["list", "stat", "read", "write", "mkdir", "move", "trash"]);
  assert.deepEqual(validateFs({ op: "list" }), { op: "list", path: "" });
  assert.deepEqual(validateFs({ op: "write", path: "Inbox/a.txt", size: 3, overwrite: true, extra: 1 }), { op: "write", path: "Inbox/a.txt", size: 3, overwrite: true }, "only the known fields are kept");
  assert.deepEqual(validateFs({ op: "move", from: "a", to: "b" }), { op: "move", from: "a", to: "b" });
  for (const bad of [null, [], { op: "exec" }, { op: "read", path: "/etc/passwd" }, { op: "read", path: "../x" }, { op: "read", path: "a/../../x" }, { op: "read", path: "~/x" }, { op: "read", path: "a\0b" },
    { op: "read", path: "x".repeat(4097) }, { op: "write", path: "a" }, { op: "write", path: "a", size: -1 }, { op: "write", path: "a", size: FS_WRITE_MAX + 1 }, { op: "move", from: "a" }, { op: "read", path: "a", range: "rm -rf" }]) {
    assert.throws(() => validateFs(bad), undefined, JSON.stringify(bad)?.slice(0, 60));
  }
});

test("an fs ticket carries one checked operation; the relay starts the helper as that agent and tells it the operation first", async t => {
  const tickets = new Tickets();
  assert.throws(() => tickets.add(T1, U, "fs", null, null), /names what to run/, "a file ticket names its operation");
  assert.throws(() => tickets.add(T1, U, "fs", "work", { op: "list" }), /no terminal/);
  assert.throws(() => tickets.add(T1, U, "fs", null, { op: "read", path: "../../etc/passwd" }), /inside the agent's home/, "a path out of the home is refused before it is held");
  assert.throws(() => tickets.add(T1, U, "vnc", null, { op: "list" }), /names what to run/, "a screen ticket carries no operation");
  /** @type {string[][]} */ const spawned = [];
  /** @type {string[]} */ const told = [];
  const relay = createRelay({ tickets, peer: () => "127.0.0.1", helloMs: 300, spawn: argv => {
    spawned.push(argv);
    // the stand-in answers like the helper: a header line and a body, then it ends
    const child = spawn("/bin/sh", ["-c", "read line; printf '%s\\n' \"$line\" >&2; printf '{\"status\":200,\"headers\":{}}\\n{\"ok\":true}'"], { stdio: ["pipe", "pipe", "pipe"] });
    child.stderr.on("data", d => told.push(String(d)));
    return child;
  } });
  await new Promise(r => relay.listen(0, "127.0.0.1", () => r(undefined)));
  t.after(() => relay.close());
  tickets.add(T1, U, "fs", null, { op: "list", path: "Work", junk: "dropped" });
  const s = net.connect(/** @type {any} */ (relay.address()).port, "127.0.0.1"); s.on("error", () => {});
  const answer = await new Promise(resolve => { const got = []; s.on("connect", () => s.write(`${T1}\n`)); s.on("data", c => got.push(c)); s.on("end", () => resolve(Buffer.concat(got).toString())); });
  assert.equal(answer, '{"status":200,"headers":{}}\n{"ok":true}', "the whole answer arrives before the socket ends");
  const argv = spawned[0].join(" ");
  assert.match(argv, /^\/usr\/bin\/setpriv --reuid=20003 --regid=20003 --clear-groups --inh-caps=-all --ambient-caps=-all --bounding-set=-all --no-new-privs /, "the helper runs as the agent, with every capability dropped");
  assert.ok(argv.endsWith(`/usr/bin/node ${FS}`), "the helper and nothing after it: the operation is not on its command line");
  assert.ok(!argv.includes("Work"), "no part of the request is an argument");
  assert.equal(told.join("").trim(), '{"op":"list","path":"Work"}', "the checked operation is its first line, and only the known fields");
});
