// @ts-check
// "Is this address private or public" is answered in ONE place, lib/netguard.js (consolidation inventory item 1, R031-00c). This test keeps it that way two ways:
//   1. every caller that used to carry its own deny list now returns what netguard returns, for a table of hostile and ordinary spellings;
//   2. no source file outside a short, named list writes a private-range literal of its own.
import "../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyAddress, isPublicAddress, isTailnet, isLoopbackHost } from "../lib/netguard.js";
import { classify } from "../lib/api-endpoint.js";
import { addressBlocked } from "../core/vault/api-request.js";
import { privateAddress } from "../kernel/modules/egress.js";
import { isPublicAddress as sandboxPublic } from "../lib/sandbox/index.js";
import { isPublicV4 } from "../core/wink/reach.js";
import { isTailnet as linkTailnet } from "../core/link/transport.js";
import { isTailnetIp } from "../core/wink/node/core.js";
import { isLoopback as vaultLoopback } from "../core/vault/relay.js";
import { publicIpv4, tailnetIp as workerTailnetIp } from "../names/worker/index.js";
import { tailnetIp as rulesTailnetIp } from "../core/names/rules.js";
import { findInSource } from "./source-files.js";

const TABLE = [
  "8.8.8.8", "93.184.216.34", "1.1.1.1", "100.63.255.255", "100.128.0.1", "172.15.0.1", "172.32.0.1", "2606:4700:4700::1111", "::ffff:8.8.8.8", "::ffff:808:808", "64:ff9b::808:808", "2002:808:808::",
  "127.0.0.1", "127.9.9.9", "::1", "[::1]", "::ffff:127.0.0.1", "::ffff:7f00:1", "::7f00:1", "10.0.0.1", "172.16.0.1", "172.31.255.255", "192.168.1.1", "100.64.0.1", "100.127.255.254", "169.254.169.254", "0.0.0.0",
  "224.0.0.1", "255.255.255.255", "192.0.0.5", "198.18.0.1", "::", "fe80::1", "fc00::1", "fd00:ec2::254", "ff02::1", "2001:db8::1", "::ffff:10.0.0.1", "::ffff:a9fe:a9fe", "::a00:1", "64:ff9b::a00:1",
  "2002:a00:1::", "not-an-ip", "", "999.1.1.1", "1.2.3.4.5", "fe80::1%eth0", "0177.0.0.1", "2130706433",
];

test("every caller agrees with lib/netguard.js on the whole table", () => {
  for (const a of TABLE) {
    const c = classifyAddress(a), pub = isPublicAddress(a, []);
    assert.equal(pub, c === "public", `netguard is consistent with itself for ${a}`);
    const old = classify(a);
    assert.equal(old, c === "public" ? "ok" : c, `api-endpoint classify: ${a}`);
    assert.equal(addressBlocked(a), !isPublicAddress(a), `vault api-request addressBlocked: ${a}`);
    assert.equal(sandboxPublic(a), isPublicAddress(a), `sandbox isPublicAddress: ${a}`);
    // The module egress is netguard plus the tunnel forms refused whole, so it may only ever be stricter.
    if (!isPublicAddress(a)) assert.equal(privateAddress(a), true, `module egress privateAddress is at least as strict: ${a}`);
    if (/^\d+\.\d+\.\d+\.\d+$/.test(a)) {
      assert.equal(isPublicV4(a), isPublicAddress(a, []), `wink reach isPublicV4: ${a}`);
      // The Cloudflare Worker cannot import lib/ (another runtime); its IPv4 rule must never accept what netguard refuses.
      if (publicIpv4(a) !== null) assert.equal(isPublicAddress(a, []), true, `names worker publicIpv4 accepts only public addresses: ${a}`);
    }
  }
});

test("the tailnet range is one question: every copy gives netguard's answer", () => {
  const ips = ["100.64.0.1", "100.127.255.254", "100.63.255.255", "100.128.0.1", "10.0.0.1", "8.8.8.8", "fd7a:115c:a1e0::1", "fd7a:115c:a1e0:ab12::5", "fd7a:115c:a1e1::1", "fd00::1", "::ffff:100.100.100.100", "garbage"];
  for (const a of ips) {
    assert.equal(linkTailnet(a), isTailnet(a), `core/link/transport isTailnet: ${a}`);
    assert.equal(isTailnetIp(a), isTailnet(a), `core/wink/node isTailnetIp: ${a}`);
    // The two name-publishing copies also canonicalise, and the Worker is another runtime: they must agree on membership for plain (unmapped) addresses.
    if (!a.startsWith("::ffff:")) {
      assert.equal(workerTailnetIp(a) !== null, isTailnet(a), `names worker tailnetIp: ${a}`);
      assert.equal(rulesTailnetIp(a) !== null, isTailnet(a), `core/names/rules tailnetIp: ${a}`);
    }
  }
});

test("loopback hosts: the vault relay's check is netguard's", () => {
  for (const h of ["localhost", "127.0.0.1", "127.8.8.8", "::1", "[::1]", "example.com", "10.0.0.1", ""]) assert.equal(vaultLoopback(h), isLoopbackHost(String(h).replace(/^\[|\]$/g, "")), h);
});

/** Files allowed to hold a private-range literal of their own, and why. Adding one needs the same reason written here. */
const ALLOWED = new Map([
  ["lib/netguard.js", "the one list"],
  ["names/worker/index.js", "a Cloudflare Worker: another runtime, cannot import lib/; the table above holds it to netguard's answers"],
  ["core/names/rules.js", "canonicalises a tailnet address for DNS; membership is held to netguard by the test above"],
  ["core/wink/reach.js", "picks this machine's own LAN address to ask a router to map (not a deny list)"],
  ["packages/module-sdk/testing.js", "the module test harness mirrors what ctx.fetch refuses; the package stays free of repo imports"],
]);
const PATTERNS = [/\b192\b.*\b168\b/, /\b169\b.*\b254\b/, /\b172\b.*\b31\b/, /\b100\b.*\b127\b/, /V4_BLOCKED|PRIVATE_HOST|TAILNET4/, /fd7a:115c/i];

test("no other source file writes a private-range list of its own", () => {
  const found = findInSource(PATTERNS, ALLOWED);
  assert.deepEqual(found, [], "an address range written outside lib/netguard.js; call classifyAddress, isPublicAddress, isTailnet or isPrivateNetwork instead");
});
