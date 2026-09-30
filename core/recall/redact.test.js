import { test } from "node:test";
import assert from "node:assert/strict";
import { redactLinks } from "./indexer.js";

test("recall: a Tailscale sign-in link is not indexed, other text and links stay", () => {
  const t = "Open https://login.tailscale.com/a/abc123 to connect, then see https://tailscale.com/kb/1017 and http://login.tailscale.com/x?y=1.";
  const r = redactLinks(t);
  assert.ok(!r.includes("abc123") && !r.includes("y=1"));
  assert.match(r, /\[tailscale sign-in link removed\] to connect/);
  assert.ok(r.includes("https://tailscale.com/kb/1017"));
  assert.equal(redactLinks("nothing here"), "nothing here");
});

test("recall: the redaction list applies every rule, and redact and redactLinks agree", async () => {
  const { redact, REDACTIONS } = await import("./indexer.js");
  assert.ok(REDACTIONS.length >= 1 && REDACTIONS.every(r => r.re.global));
  const t = "go https://login.tailscale.com/a/zzz9 now";
  assert.equal(redact(t), redactLinks(t));
  assert.ok(!redact(t).includes("zzz9"));
});
