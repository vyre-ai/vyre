// @ts-check
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { parse, status } from "./tailnet.js";
import { SCRATCH } from "../../test/scratch.mjs";

const sample = {
  BackendState: "Running",
  Self: { HostName: "laptop", DNSName: "laptop.tail0000.ts.net.", TailscaleIPs: ["100.64.0.2"], UserID: 7 },
  User: { 7: { LoginName: "alex@example.com" }, 9: { LoginName: "sam@example.com" } },
  Peer: {
    a: { HostName: "vyre", DNSName: "vyre.tail0000.ts.net.", TailscaleIPs: ["100.64.0.3"], Online: true, UserID: 7, OS: "linux" },
    b: { HostName: "vyre", DNSName: "vyre-2.tail0000.ts.net.", TailscaleIPs: ["100.64.0.4"], Online: false, UserID: 7, OS: "linux" },
    c: { HostName: "vyre", DNSName: "vyre.tail9999.ts.net.", TailscaleIPs: ["100.64.0.5"], Online: true, UserID: 9, OS: "linux" },
    d: { HostName: "vyre", DNSName: "vyre-3.tail0000.ts.net.", TailscaleIPs: ["100.64.0.6"], Online: true, UserID: 7, Tags: ["tag:server"] },
    e: { HostName: "vyrex", DNSName: "vyrex.tail0000.ts.net.", TailscaleIPs: ["100.64.0.7"], Online: true, UserID: 7 },
  },
};

test("tailnet: parse reads login, self and peers", () => {
  const t = parse(sample);
  assert.equal(t.running, true);
  assert.equal(t.login, "alex@example.com");
  assert.equal(t.self?.dnsName, "laptop.tail0000.ts.net");
  assert.equal(t.peers.length, 5);
});

test("tailnet: signed out and missing are said plainly", async t => {
  assert.match(String(parse({ BackendState: "NeedsLogin" }).why), /signed out/);
  const dir = fs.mkdtempSync(path.join(SCRATCH, "vyre-tn-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const missing = await status({ ...process.env, VYRE_TAILSCALE_BIN: path.join(dir, "nope") });
  assert.equal(missing.installed, false);
  const fake = path.join(dir, "tailscale");
  fs.writeFileSync(fake, `#!/bin/sh\ncat <<'J'\n${JSON.stringify(sample)}\nJ\n`, { mode: 0o755 });
  const got = await status({ ...process.env, VYRE_TAILSCALE_BIN: fake });
  assert.equal(got.login, "alex@example.com");
});
