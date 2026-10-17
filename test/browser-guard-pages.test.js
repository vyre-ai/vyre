// @ts-check
// The agent's navigation floor under the owner's full-DevTools ruling: the browser's own pages are open, except the ones that would list a saved login or address.

import "../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { guardAgentNavigate } from "../lib/browser-access.js";

test("password, autofill, payment and address pages are shut; other chrome:// pages and about:blank are open", async () => {
  for (const url of ["chrome://password-manager/passwords", "chrome://password-manager-internals", "chrome://settings/passwords", "chrome://settings/autofill", "chrome://settings/payments", "chrome://settings/addresses", "CHROME://SETTINGS/PASSWORDS"]) {
    await assert.rejects(() => guardAgentNavigate(url), /saved logins and addresses/, url);
  }
  for (const url of ["chrome://version", "chrome://settings", "chrome://inspect", "chrome://net-export", "about:blank"]) await guardAgentNavigate(url);
});

test("everything else off the public web is still refused", async () => {
  for (const url of ["file:///etc/passwd", "javascript:alert(1)", "chrome-extension://abc/x.html", "ftp://example.com/"]) await assert.rejects(() => guardAgentNavigate(url), /not an http\(s\) URL/, url);
});
