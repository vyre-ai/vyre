// @ts-check
import { test } from "node:test";
import assert from "node:assert/strict";
import { parse, sshLine, mac } from "./up.js";

test("up: flags with and without values", () => {
  assert.deepEqual(parse(["--system", "--user", "alex", "--dry-run"]), { flags: { system: true, user: "alex", "dry-run": true }, rest: [] });
  assert.deepEqual(parse(["--user=alex", "file"]), { flags: { user: "alex" }, rest: ["file"] });
});

test("up: over SSH, the tunnel line points at the address the person connected to", () => {
  assert.equal(sshLine(7300, "alex", { SSH_CONNECTION: "203.0.113.9 51234 198.51.100.4 22" }), "ssh -N -L 7300:127.0.0.1:7300 alex@198.51.100.4");
  assert.equal(sshLine(7300, "alex", { SSH_CONNECTION: "2001:db8::9 51234 2001:db8::4 22" }), "ssh -N -L 7300:127.0.0.1:7300 alex@[2001:db8::4]");
  assert.equal(sshLine(7300, "vyre", { SSH_CONNECTION: "203.0.113.9 51234 198.51.100.4 22", VYRE_HOST_USER: "alex" }), "ssh -N -L 7300:127.0.0.1:7300 alex@198.51.100.4", "the host account, not the container's");
  assert.equal(sshLine(7300, "alex", {}), null, "not over SSH: no tunnel needed");
});

/** mac() with a fake box and link; returns what it called and printed. */
async function runMac(box, { healthy = true, status = { linked: false, pending: null }, pair = { code: "123-456" }, capsule = true, platform = "darwin", opened = true } = {}) {
  const calls = [], lines = [];
  const log = console.log;
  console.log = (...a) => lines.push(a.join(" "));
  let code;
  try {
    code = await mac(box, { capsule }, {
      health: async () => healthy,
      tool: async (name, input) => { calls.push([name, input]); return name === "link.status" ? { data: status } : { data: pair }; },
      platform,
      openCapsule: async () => { calls.push(["capsule"]); return opened; },
    });
  } finally { console.log = log; }
  return { code, calls, text: lines.join("\n") };
}

test("up on a Mac: no box yet says how to point at one, and does nothing else", async () => {
  const r = await runMac(undefined);
  assert.equal(r.code, 0);
  assert.deepEqual(r.calls, []);
  assert.match(r.text, /vyre up --connect/);
});

test("up on a Mac: an unreachable box stops before pairing or the Capsule", async () => {
  const r = await runMac("https://alex.vyre.run", { healthy: false });
  assert.equal(r.code, 1);
  assert.deepEqual(r.calls, []);
});

test("up on a Mac: not paired starts pairing, prints the code to approve, then opens the Capsule", async () => {
  const r = await runMac("https://alex.vyre.run");
  assert.equal(r.code, 0);
  assert.deepEqual(r.calls.map(c => c[0]), ["link.status", "link.pair", "capsule"]);
  assert.deepEqual(r.calls[1][1], { box: "https://alex.vyre.run" });
  assert.match(r.text, /vyre link approve 123-456/);
});

test("up on a Mac: a pairing already waiting shows its code instead of starting another", async () => {
  const r = await runMac("https://alex.vyre.run", { status: { linked: false, pending: { code: "654-321" } } });
  assert.deepEqual(r.calls.map(c => c[0]), ["link.status", "capsule"]);
  assert.match(r.text, /vyre link approve 654-321/);
});

test("up on a Mac: already linked goes straight to the Capsule; --no-capsule skips it", async () => {
  const linked = { linked: true };
  assert.deepEqual((await runMac("https://alex.vyre.run", { status: linked })).calls.map(c => c[0]), ["link.status", "capsule"]);
  assert.deepEqual((await runMac("https://alex.vyre.run", { status: linked, capsule: false })).calls.map(c => c[0]), ["link.status"]);
});

test("up on a Mac: with no Capsule installed it points at the download", async () => {
  const r = await runMac("https://alex.vyre.run", { status: { linked: true }, opened: false });
  assert.equal(r.code, 0);
  assert.match(r.text, /vyre\.run\/box\/Vyre-mac\.zip/);
});
