// @ts-check
// onboard.status's tailnet devices: only the owner's own, untagged nodes, with the fields step 6
// and Settings > Devices use.

import test from "node:test";
import assert from "node:assert/strict";
import { parsePeers } from "./index.js";

test("onboard: parsePeers keeps the owner's own untagged devices and says which are online", () => {
  const peers = parsePeers({
    Self: { UserID: 1, Tags: [] },
    Peer: {
      a: { HostName: "alex-iphone", DNSName: "alex-iphone.tail0000.ts.net.", OS: "iOS", UserID: 1, Online: false, LastSeen: "2026-09-19T10:00:00Z" },
      b: { HostName: "alex-mbp", DNSName: "alex-mbp.tail0000.ts.net.", OS: "macOS", UserID: 1, Online: true, LastSeen: "0001-01-01T00:00:00Z" },
      c: { HostName: "ci-runner", OS: "linux", UserID: 1, Tags: ["tag:ci"], Online: true },
      d: { HostName: "someone-else", OS: "iOS", UserID: 2, Online: true },
    },
  });
  assert.deepEqual(peers.map(p => [p.name, p.os, p.online]), [["alex-iphone", "iOS", false], ["alex-mbp", "macOS", true]]);
  assert.equal(peers[0].dns, "alex-iphone.tail0000.ts.net");
  assert.equal(peers[1].lastSeen, null, "a zero time is no time");
  assert.deepEqual(parsePeers(null), []);
});
