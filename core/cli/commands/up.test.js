// @ts-check
import { test } from "node:test";
import assert from "node:assert/strict";
import { parse, sshLine } from "./up.js";

test("up: flags with and without values", () => {
  assert.deepEqual(parse(["--system", "--user", "alex", "--dry-run"]), { flags: { system: true, user: "alex", "dry-run": true }, rest: [] });
  assert.deepEqual(parse(["--user=alex", "file"]), { flags: { user: "alex" }, rest: ["file"] });
});

test("up: over SSH, the tunnel line points at the address the person connected to", () => {
  assert.equal(sshLine(7300, "alex", { SSH_CONNECTION: "203.0.113.9 51234 198.51.100.4 22" }), "ssh -N -L 7300:127.0.0.1:7300 alex@198.51.100.4");
  assert.equal(sshLine(7300, "alex", { SSH_CONNECTION: "2001:db8::9 51234 2001:db8::4 22" }), "ssh -N -L 7300:127.0.0.1:7300 alex@[2001:db8::4]");
  assert.equal(sshLine(7300, "alex", {}), null, "not over SSH: no tunnel needed");
});
