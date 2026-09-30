// @ts-check
// ssh.js against a fake `ssh` that logs its arguments and runs the remote command locally.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { quote, line, remote, portFree, validTarget } from "./ssh.js";
import { SCRATCH } from "../../test/scratch.mjs";

/** A fake ssh: logs argv, answers -O itself, fails BatchMode when FAKE_SSH_NOKEY is set, else runs the command with sh. */
const FAKE_SSH = `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_SSH_LOG"
op=""; batch=0
while [ $# -gt 0 ]; do
  case "$1" in
    -o) [ "$2" = BatchMode=yes ] && batch=1; shift 2 ;;
    -O) op=$2; shift 2 ;;
    -L) shift 2 ;;
    -*) shift ;;
    *) break ;;
  esac
done
shift
[ -n "$op" ] && exit 0
if [ "$batch" = 1 ] && [ -n "\${FAKE_SSH_NOKEY:-}" ]; then echo "alex@203.0.113.9: Permission denied (publickey)." >&2; exit 255; fi
exec sh -c "$*"
`;

function fake(t) {
  const dir = fs.mkdtempSync(path.join(SCRATCH, "vyre-ssh-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const bin = path.join(dir, "ssh"), log = path.join(dir, "log");
  fs.writeFileSync(bin, FAKE_SSH, { mode: 0o755 });
  return { dir, log, env: { ...process.env, VYRE_SSH_BIN: bin, FAKE_SSH_LOG: log } };
}

test("ssh: quote leaves plain words alone and survives any quote", () => {
  assert.equal(quote("/srv/vyre"), "/srv/vyre");
  assert.equal(quote("a b"), "'a b'");
  assert.equal(quote(""), "''");
  const nasty = `it's "$HOME" \`id\` ; rm -rf x`;
  assert.equal(execFileSync("sh", ["-c", `printf %s ${quote(nasty)}`], { encoding: "utf8" }), nasty);
  assert.equal(execFileSync("sh", ["-c", line("printf", "%s|%s", "a b", "c'd")], { encoding: "utf8" }), "a b|c'd");
});

test("ssh: a target that ssh would read as an option is refused", () => {
  assert.equal(validTarget("alex@203.0.113.9"), true);
  for (const bad of ["-oProxyCommand=touch /tmp/x@203.0.113.9", "alex@-oProxyCommand=x", "alex", "a@b@c", "alex@host name", ""]) {
    assert.equal(validTarget(bad), false, bad);
  }
  assert.throws(() => remote("-oProxyCommand=id@x"), /not a user@host/);
});

test("ssh: open holds a master, run and json ride it, close ends it", async t => {
  const f = fake(t);
  const r = remote("alex@203.0.113.9", { env: f.env });
  assert.deepEqual(await r.open(), { ok: true, why: null });
  const first = fs.readFileSync(f.log, "utf8").split("\n")[0];
  assert.match(first, /ControlMaster=auto/);
  assert.match(first, /ControlPersist=600/);
  assert.match(first, /BatchMode=yes -- alex@203\.0\.113\.9 true$/, "-- ends the options before the target");
  const dir = /ControlPath=(\S+)\/%C/.exec(first)?.[1] || "";
  assert.ok(dir.startsWith("/tmp/"), "the socket folder is short");
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700);

  const res = await r.run(line("echo", "hi there"));
  const later = fs.readFileSync(f.log, "utf8").trim().split("\n").pop() || "";
  assert.match(later, /BatchMode=yes -o ServerAliveInterval=15 -o ServerAliveCountMax=4 -- alex@203\.0\.113\.9 /, "after the master nothing may ask, and a dead link is noticed");
  assert.deepEqual(res, { code: 0, stdout: "hi there\n", stderr: "" });
  assert.deepEqual(await r.json(`echo '{"a":1}'`), { a: 1 });
  await assert.rejects(r.json("echo oops >&2; exit 3"), /oops/);
  assert.equal((await r.run("cat", { input: "piped" })).stdout, "piped");

  await r.close();
  assert.match(fs.readFileSync(f.log, "utf8"), /-O exit -- alex@203\.0\.113\.9/);
  assert.equal(fs.existsSync(dir), false);
});

test("ssh: no key and no terminal says why, and asks nothing", async t => {
  const f = fake(t);
  const r = remote("alex@203.0.113.9", { env: { ...f.env, FAKE_SSH_NOKEY: "1" } });
  const o = await r.open();
  assert.equal(o.ok, false);
  assert.match(String(o.why), /Permission denied/);
  await r.close();
});

test("ssh: put copies a file with mode 0700, without scp", async t => {
  const f = fake(t);
  const r = remote("alex@203.0.113.9", { env: f.env });
  t.after(() => r.close());
  const src = path.join(f.dir, "installer.sh"), dest = path.join(f.dir, "copy of it.sh");
  fs.writeFileSync(src, "#!/bin/sh\necho installed\n");
  assert.equal((await r.put(src, dest)).code, 0);
  assert.equal(fs.readFileSync(dest, "utf8"), "#!/bin/sh\necho installed\n");
  assert.equal(fs.statSync(dest).mode & 0o777, 0o700);
});

test("ssh: a tunnel rides the master; a taken port stops it by name", async t => {
  const f = fake(t);
  const r = remote("alex@203.0.113.9", { env: f.env });
  t.after(() => r.close());
  const srv = net.createServer();
  await new Promise(res => srv.listen(0, "127.0.0.1", () => res(null)));
  t.after(() => srv.close());
  const port = /** @type {net.AddressInfo} */ (srv.address()).port;
  assert.equal(await portFree(port), false);
  await assert.rejects(r.tunnel(port, port), new RegExp(`port ${port} on this computer is taken`));
  await assert.rejects(r.tunnel(/** @type {any} */ (null), /** @type {any} */ (null)), /no port to forward/);

  srv.close();
  await new Promise(res => setTimeout(res, 50));
  const tun = await r.tunnel(port, port);
  await tun.close();
  const log = fs.readFileSync(f.log, "utf8");
  assert.match(log, new RegExp(`ExitOnForwardFailure=yes -O forward -L ${port}:127\\.0\\.0\\.1:${port} -- alex`));
  assert.match(log, new RegExp(`-O cancel -L ${port}:127\\.0\\.0\\.1:${port}`));
});
