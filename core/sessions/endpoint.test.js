import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { addressRefused, classify, hostSafe, metadataName, resolveSafe, pinnedFetch } from "./endpoint.js";
import { endpointOk } from "./accounts.js";

test("addresses a key is never sent to: private, tailnet, link-local and metadata; loopback is this machine", () => {
  for (const a of ["10.0.0.5", "172.16.1.1", "172.31.255.1", "192.168.1.1", "100.64.0.1", "100.127.1.1", "100.100.100.200", "169.254.169.254", "192.0.0.192", "fd00:ec2::254", "fc00::1", "fe80::1", "::ffff:10.0.0.1"]) assert.equal(addressRefused(a), true, a);
  for (const a of ["127.0.0.1", "::1", "8.8.8.8", "172.32.0.1", "100.128.0.1", "api.openai.com"]) assert.equal(addressRefused(a), false, a);
  assert.ok(metadataName("metadata.google.internal"));
  for (const u of ["https://10.1.2.3/v1", "https://100.100.100.200/v1", "https://192.0.0.192", "https://[fd00:ec2::254]/"]) assert.throws(() => endpointOk(u), /not a place a key may be sent/, u);
  assert.equal(endpointOk("http://127.0.0.1:11434/v1"), "http://127.0.0.1:11434/v1");
});

test("IPv6 spellings of private IPv4 are refused: mapped in hex, NAT64, 6to4, compatible, ULA", () => {
  for (const u of ["https://[::ffff:10.0.0.1]/v1", "https://[::ffff:169.254.169.254]/v1", "https://[64:ff9b::a00:1]/v1", "https://[2002:a00:1::]/v1", "https://[::10.0.0.1]/v1", "https://[fd12::1]/v1", "https://[fe80::1]/v1", "https://[::ffff:100.100.100.200]/v1", "https://[::ffff:c000:00c0]/v1", "https://[::]/v1"]) assert.throws(() => endpointOk(u), /not a place a key may be sent/, u);
  for (const a of ["::ffff:a00:1", "::ffff:a9fe:a9fe", "64:ff9b::a00:1", "2002:a00:1::", "::ffff:0a00:0001", "fd00:ec2::254", "0:0:0:0:0:ffff:10.0.0.1"]) assert.equal(addressRefused(a), true, a);
  for (const a of ["2606:4700:4700::1111", "::ffff:808:808", "64:ff9b::808:808", "2002:808:808::", "::1"]) assert.equal(addressRefused(a), false, a);
});

test("on a box loopback is refused; anywhere Vyre's own ports are", () => {
  const was = process.env.VYRE_SUPERVISOR;
  try {
    delete process.env.VYRE_SUPERVISOR;
    assert.equal(endpointOk("http://127.0.0.1:11434/v1"), "http://127.0.0.1:11434/v1");
    assert.throws(() => endpointOk("http://127.0.0.1:7300/v1"), /on this machine/);
    assert.throws(() => endpointOk("http://localhost:7305/v1"), /on this machine/);
    process.env.VYRE_SUPERVISOR = "docker";
    assert.throws(() => endpointOk("http://127.0.0.1:11434/v1"), /on this machine/);
  } finally { if (was === undefined) delete process.env.VYRE_SUPERVISOR; else process.env.VYRE_SUPERVISOR = was; }
});

test("hostSafe resolves the name each time: one private answer refuses it", async () => {
  assert.equal(await hostSafe("https://api.example.com/v1", async () => [{ address: "8.8.8.8" }]), true);
  assert.equal(await hostSafe("https://api.example.com/v1", async () => [{ address: "8.8.8.8" }, { address: "10.0.0.9" }]), false);
  assert.equal(await hostSafe("https://api.example.com/v1", async () => { throw new Error("nxdomain"); }), false);
  assert.equal(await hostSafe("http://localhost:11434/v1", async () => { throw new Error("not asked"); }), true);
  assert.deepEqual(await resolveSafe("https://api.example.com/v1", async () => [{ address: "8.8.4.4" }]), { address: "8.8.4.4", family: 4 }, "the address to use is pinned");
  assert.equal(await hostSafe("https://api.example.com/v1", async () => [{ address: "::ffff:a9fe:a9fe" }]), false, "an AAAA answer in mapped form");
  assert.equal(await hostSafe("https://metadata.google.internal/x", async () => [{ address: "8.8.8.8" }]), false);
});

test("every spelling of an address gets one answer: hex, dotted, compatible, NAT64, 6to4, zone ids, other loopbacks", () => {
  const refused = ["::ffff:a00:1", "::ffff:10.0.0.1", "::ffff:0a00:0001", "0:0:0:0:0:ffff:a00:1", "::a00:1", "::10.0.0.1", "64:ff9b::a9fe:a9fe", "64:ff9b::169.254.169.254", "2002:c0a8:101::",
    "2002:6464:c8::5", "fe80::1%eth0", "FE80::1", "fd12:3456::1", "fc00::1", "ff02::1", "::", "0.0.0.0", "100.64.0.1", "[::ffff:a9fe:a9fe]", "64:ff9b::c000:c0"];
  for (const a of refused) assert.equal(classify(a), "refused", a);
  const loop = ["127.0.0.1", "127.0.0.2", "::1", "0:0:0:0:0:0:0:1", "::ffff:127.0.0.1", "::ffff:7f00:1", "::7f00:1", "64:ff9b::7f00:1", "2002:7f00:1::", "[::1]"];
  for (const a of loop) assert.equal(classify(a), "loopback", a);
  for (const a of ["8.8.8.8", "::ffff:808:808", "64:ff9b::808:808", "2002:808:808::", "2606:4700:4700::1111"]) assert.equal(classify(a), "ok", a);
  assert.equal(classify("example.com"), null);
});

test("loopback in any spelling is refused for Vyre's own ports and, on a box, entirely", () => {
  const was = process.env.VYRE_SUPERVISOR;
  try {
    delete process.env.VYRE_SUPERVISOR;
    for (const u of ["http://127.0.0.2:7300/v1", "http://[::ffff:7f00:1]:7301/v1", "http://[::ffff:127.0.0.1]:7300/v1", "http://[0:0:0:0:0:0:0:1]:7310/v1", "http://127.1:7300/v1", "https://127.0.0.2:7300/v1", "https://[::7f00:1]:7300/v1"])
      assert.throws(() => endpointOk(u), /on this machine/, u);
    assert.equal(endpointOk("http://127.0.0.2:11434/v1"), "http://127.0.0.2:11434/v1");
    process.env.VYRE_SUPERVISOR = "docker";
    for (const u of ["http://127.0.0.2:11434/v1", "https://[::ffff:7f00:1]/v1", "http://[::1]:11434/v1"]) assert.throws(() => endpointOk(u), /on this machine/, u);
  } finally { if (was === undefined) delete process.env.VYRE_SUPERVISOR; else process.env.VYRE_SUPERVISOR = was; }
});

test("a name that answers with a refused or loopback address, in any form, is refused; the answer used is the one checked", async () => {
  for (const address of ["::ffff:a00:1", "64:ff9b::a00:1", "2002:a00:1::", "::a00:1", "fe80::1%eth0", "127.0.0.9", "::ffff:7f00:1", "::1", "64:ff9b::7f00:1"])
    assert.equal(await hostSafe("https://api.example.com/v1", async () => [{ address }]), false, address);
  assert.equal(await hostSafe("https://api.example.com/v1", async () => [{ address: "2606:4700::1" }, { address: "::ffff:a00:1" }]), false, "one bad answer among good ones");
  assert.equal(await hostSafe("http://[::ffff:7f00:1]:7300/v1"), false);
  assert.equal(await hostSafe("https://[::ffff:a00:1]/v1"), false);
  assert.equal(await hostSafe("https://[::ffff:a00:1]/v1", async () => { throw new Error("not asked"); }), false);
});

test("pinnedFetch connects to the pinned address, never a fresh lookup of the name", async t => {
  let sawHost = "";
  const srv = http.createServer((req, res) => { sawHost = String(req.headers.host); res.end("ok"); });
  await new Promise(r => srv.listen(0, "127.0.0.1", r));
  t.after(() => srv.close());
  const r = await pinnedFetch(`http://pinned.invalid:${srv.address().port}/x`, {}, { address: "127.0.0.1", family: 4 });
  assert.equal(await r.text(), "ok");
  assert.match(sawHost, /^pinned\.invalid:/);
});
