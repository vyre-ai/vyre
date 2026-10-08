// @ts-check
// A vyre command that needs Docker, run by a person who cannot reach Docker (not root, not in the docker group), says to use sudo, never Docker's own
// permission error (the 0.2.12 live walk: `vyre uninstall` without sudo showed a raw socket error).
import "../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import net from "node:net";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const WRAPPER = path.join(path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."), "box", "vyre");

test("box/vyre: uninstall and logs without access to Docker say to run them with sudo", { skip: process.getuid && process.getuid() === 0 ? "root can reach Docker" : process.platform === "win32" ? "no unix sockets" : false }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vyre-sudo-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, "compose.yml"), "");
  const sock = path.join(dir, "d.sock");
  const srv = net.createServer();
  await new Promise(r => srv.listen(sock, () => r(null)));
  t.after(() => srv.close());
  fs.chmodSync(sock, 0o000);
  for (const verb of ["uninstall", "logs"]) {
    const r = spawnSync("sh", [WRAPPER, verb, ...(verb === "uninstall" ? ["--yes"] : [])], { encoding: "utf8", env: { PATH: process.env.PATH, HOME: dir, VYRE_DIR: dir, DOCKER_HOST: `unix://${sock}` } });
    assert.notEqual(r.status, 0, verb);
    assert.match(r.stderr + r.stdout, new RegExp(`run it with sudo: sudo vyre ${verb}`), verb);
    assert.doesNotMatch(r.stderr + r.stdout, /permission denied while trying to connect/i, verb);
  }
});
