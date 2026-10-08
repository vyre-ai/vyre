// @ts-check
// The address gate lets loopback in (a computer's own processes), which is only safe while nothing inside a computer forwards
// remote traffic to loopback. These checks read what the image installs and starts; the J7 matrix step 7.5c checks the running computer.
import "../../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.dirname(fileURLToPath(import.meta.url));
const read = f => fs.readFileSync(path.join(dir, f), "utf8");
/** Lines that install or run something, with comments dropped. */
const code = f => read(f).split("\n").filter(l => !/^\s*#/.test(l)).join("\n");

const FORWARDERS = /\b(tailscaled?|socat|redir|rinetd|haproxy|nginx|ncat|netcat|sshd|dropbear|stunnel|gost|3proxy|squid|microsocks)\b/;

test("image: nothing that forwards remote traffic to loopback is installed or started", () => {
  for (const f of ["Dockerfile", "entrypoint.sh"]) {
    const hit = FORWARDERS.exec(code(f));
    assert.equal(hit, null, `${f} mentions ${hit && hit[0]}, which could make a remote peer look like loopback to the address gate`);
  }
});

test("image: no tailnet node is started by the image", () => {
  assert.doesNotMatch(code("entrypoint.sh"), /tailnet|tailscale/);
});
