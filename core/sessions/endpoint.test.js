import { test } from "node:test";
import assert from "node:assert/strict";
import { addressRefused, hostSafe, metadataName } from "./endpoint.js";
import { endpointOk } from "./accounts.js";

test("addresses a key is never sent to: private, tailnet, link-local and metadata; loopback is this machine", () => {
  for (const a of ["10.0.0.5", "172.16.1.1", "172.31.255.1", "192.168.1.1", "100.64.0.1", "100.127.1.1", "100.100.100.200", "169.254.169.254", "192.0.0.192", "fd00:ec2::254", "fc00::1", "fe80::1", "::ffff:10.0.0.1"]) assert.equal(addressRefused(a), true, a);
  for (const a of ["127.0.0.1", "::1", "8.8.8.8", "172.32.0.1", "100.128.0.1", "api.openai.com"]) assert.equal(addressRefused(a), false, a);
  assert.ok(metadataName("metadata.google.internal"));
  for (const u of ["https://10.1.2.3/v1", "https://100.100.100.200/v1", "https://192.0.0.192", "https://[fd00:ec2::254]/"]) assert.throws(() => endpointOk(u), /not a place a key may be sent/, u);
  assert.equal(endpointOk("http://127.0.0.1:11434/v1"), "http://127.0.0.1:11434/v1");
});

test("hostSafe resolves the name each time: one private answer refuses it", async () => {
  assert.equal(await hostSafe("https://api.example.com/v1", async () => [{ address: "8.8.8.8" }]), true);
  assert.equal(await hostSafe("https://api.example.com/v1", async () => [{ address: "8.8.8.8" }, { address: "10.0.0.9" }]), false);
  assert.equal(await hostSafe("https://api.example.com/v1", async () => { throw new Error("nxdomain"); }), false);
  assert.equal(await hostSafe("http://localhost:11434/v1", async () => { throw new Error("not asked"); }), true);
  assert.equal(await hostSafe("https://metadata.google.internal/x", async () => [{ address: "8.8.8.8" }]), false);
});
