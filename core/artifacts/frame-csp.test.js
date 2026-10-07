// The headers of an artifact's private page: it cannot frame, post, rebase or reach out, and it runs at an opaque origin that cannot navigate the top page.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { pageHeaders } from "./render.js";

test("the private page's CSP shuts frames, forms, base and every fetch, and the sandbox has no top navigation or popups", () => {
  const csp = pageHeaders({ scripts: true, framedBy: "self" })["content-security-policy"];
  const parts = csp.split("; ");
  for (const want of ["sandbox allow-scripts", "default-src 'none'", "connect-src 'none'", "frame-src 'none'", "form-action 'none'", "base-uri 'none'", "object-src 'none'", "frame-ancestors 'self'"]) assert.ok(parts.includes(want), want);
  for (const flag of ["allow-same-origin", "allow-top-navigation", "allow-popups", "allow-forms", "allow-modals"]) assert.ok(!csp.includes(flag), flag);
  const doc = pageHeaders({ scripts: false, framedBy: "self" })["content-security-policy"];
  assert.ok(doc.startsWith("sandbox;"), "a document runs no script at all");
  assert.ok(doc.includes("script-src 'none'"));
  assert.ok(pageHeaders({ scripts: true, framedBy: "none" })["content-security-policy"].includes("frame-ancestors 'none'"));
});
