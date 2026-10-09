// @ts-check
// lib/netguard.js: the ONE answer to "what kind of address is this". Every other check in the repo calls it (test/netguard-single.test.js keeps that so), so the adversarial spellings live here.
import "../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyAddress, isPublicAddress, isTailnet, isTunnelAddress, isLoopbackHost, isPrivateNetwork, toBytes } from "./netguard.js";

const NONE = [];

test("classifyAddress: loopback, refused and public in every spelling of the same address", () => {
  const loopback = ["127.0.0.1", "127.9.9.9", "::1", "0:0:0:0:0:0:0:1", "[::1]", "::ffff:127.0.0.1", "::ffff:7f00:1", "::7f00:1", "64:ff9b::7f00:1", "2002:7f00:1::", "::1%lo"];
  for (const a of loopback) assert.equal(classifyAddress(a), "loopback", a);
  const refused = ["10.0.0.1", "172.16.0.1", "172.31.255.255", "192.168.1.1", "100.64.0.1", "100.127.255.255", "169.254.169.254", "0.0.0.0", "224.0.0.1", "255.255.255.255", "192.0.2.1", "198.18.0.1", "203.0.113.9",
    "::", "fe80::1", "fe80::1%eth0", "FE80::1", "fc00::1", "fd00:ec2::254", "ff02::1", "2001:db8::1", "2001::1", "::ffff:10.0.0.1", "::ffff:a9fe:a9fe", "::a00:1", "64:ff9b::a00:1", "64:ff9b:1::a00:1", "2002:a00:1::",
    "::ffff:0:a00:1", "::ffff:0:808:808", "4000::1"];
  for (const a of refused) assert.equal(classifyAddress(a), "refused", a);
  const open = ["8.8.8.8", "93.184.216.34", "100.63.255.255", "100.128.0.1", "172.32.0.1", "::ffff:808:808", "::ffff:8.8.8.8", "64:ff9b::808:808", "2002:808:808::", "2606:4700:4700::1111", "2a00:1450:4001:81b::200e"];
  for (const a of open) assert.equal(classifyAddress(a), "public", a);
  for (const a of ["example.com", "", "1.2.3.4.5", "999.1.1.1", "01.1.1.1", ":::", "1::2::3", "::gggg"]) assert.equal(classifyAddress(a), null, JSON.stringify(a));
  assert.equal(classifyAddress("2606:4700::1%eth0"), "refused", "a zone id is never a public destination");
});

test("isPublicAddress follows classifyAddress, refuses the machine's own addresses, and refuses what is not an address", () => {
  assert.equal(isPublicAddress("8.8.8.8", NONE), true);
  assert.equal(isPublicAddress("8.8.8.8", ["8.8.8.8"]), false, "this machine's own address");
  assert.equal(isPublicAddress("::ffff:8.8.8.8", ["8.8.8.8"]), false, "its mapped form too");
  assert.equal(isPublicAddress("example.com", NONE), false);
  assert.equal(isPublicAddress("127.0.0.1", NONE), false);
});

test("isTailnet: 100.64.0.0/10 and fd7a:115c:a1e0::/48 only, in any spelling, and nothing else", () => {
  for (const a of ["100.64.0.1", "100.127.255.254", "::ffff:100.100.100.100", "fd7a:115c:a1e0::1", "FD7A:115C:A1E0:ab12::5"]) assert.equal(isTailnet(a), true, a);
  for (const a of ["100.63.255.255", "100.128.0.1", "10.0.0.1", "fd7a:115c:a1e1::1", "fd00::1", "8.8.8.8", "tailnet.example", ""]) assert.equal(isTailnet(a), false, a);
});

test("isTunnelAddress: compatible, NAT64, 6to4 and Teredo forms, never a plain or mapped address", () => {
  for (const a of ["::a00:1", "64:ff9b::808:808", "2002:808:808::", "2001:0:4136:e378:8000:63bf:3fff:fdd2"]) assert.equal(isTunnelAddress(a), true, a);
  for (const a of ["8.8.8.8", "::ffff:8.8.8.8", "2606:4700::1111", "example.com"]) assert.equal(isTunnelAddress(a), false, a);
});

test("isLoopbackHost and isPrivateNetwork", () => {
  for (const h of ["localhost", "LOCALHOST", "127.0.0.2", "::1", "::ffff:7f00:1"]) assert.equal(isLoopbackHost(h), true, h);
  for (const h of ["example.com", "10.0.0.1", "8.8.8.8", "localhost.evil.example"]) assert.equal(isLoopbackHost(h), false, h);
  for (const a of ["127.0.0.1", "10.1.2.3", "172.20.0.1", "192.168.0.9", "100.64.1.1", "169.254.1.1", "fd12::1", "fe80::1", "::ffff:192.168.0.9"]) assert.equal(isPrivateNetwork(a), true, a);
  for (const a of ["8.8.8.8", "172.32.0.1", "224.0.0.1", "0.0.0.0", "2606:4700::1111", "example.local", "203.0.113.9"]) assert.equal(isPrivateNetwork(a), false, a);
});

test("toBytes: the one parser reads every spelling to the same 16 bytes", () => {
  const want = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 255, 255, 127, 0, 0, 1];
  for (const a of ["127.0.0.1", "::ffff:127.0.0.1", "::ffff:7f00:1", "[::ffff:7f00:1]", "0:0:0:0:0:ffff:7f00:1"]) assert.deepEqual([...(toBytes(a) || [])], want, a);
  assert.deepEqual([...(toBytes("[::1]") || [])], [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]);
  assert.equal(toBytes("fe80::1%eth0"), null);
  assert.equal(toBytes("not-an-ip"), null);
});
