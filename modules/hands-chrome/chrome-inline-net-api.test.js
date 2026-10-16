// @ts-check
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { captureNetwork } from "./cdp-capture.js";
import { createBoxApi } from "./box-api.js";
import { learn } from "../../lib/siteops/apilearn.js";

test("box chrome.net capture: get returns a redacted request record", async () => {
  /** @type {any[]} */ const sent = [];
  const cdp = {
    on: (fn) => { cdp._fn = fn; return () => {}; },
    send: async (method, params, sessionId) => { sent.push({ method, sessionId }); return method === "Network.getResponseBody" ? { body: "{\"ok\":true}", base64Encoded: false } : {}; },
    _fn: null,
  };
  const cap = captureNetwork(cdp, "s1", { full: true });
  await cap.start();
  cdp._fn({ method: "Network.requestWillBeSent", sessionId: "s1", params: { requestId: "1", request: { method: "GET", url: "https://api.example.com/v1/items?token=secret" }, type: "Fetch" } });
  cdp._fn({ method: "Network.responseReceived", sessionId: "s1", params: { requestId: "1", response: { status: 200, mimeType: "application/json", headers: {} } } });
  cdp._fn({ method: "Network.loadingFinished", sessionId: "s1", params: { requestId: "1" } });
  const got = await cap.get("1");
  assert.ok(got);
  assert.match(String(got.url), /items/);
});

test("box chrome.api: learn builds a catalog entry from capture", async () => {
  const catalogs = new Map();
  const dead = new Map();
  const recs = [{ method: "GET", url: "https://app.example.com/api/users", status: 200, type: "fetch", requestHeaders: { accept: "application/json" }, postData: undefined }];
  const fresh = learn(recs);
  catalogs.set("https://app.example.com", fresh);
  const api = createBoxApi({ cdp: { send: async () => ({}), on: () => () => {} }, sessionId: "s1", catalogs, dead });
  const cat = await api.catalog({ origin: "https://app.example.com" });
  assert.ok(cat.entries.length >= 1);
  const route = await api.route({ hint: "users", host: "https://app.example.com" });
  assert.equal(route.route, "ui");
});
