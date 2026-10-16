// @ts-check
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { mergeApiCatalog } from "./api-tool.js";

test("mergeApiCatalog: learns shapes into the per-agent store", () => {
  const store = new Map();
  const fresh = [{
    method: "GET",
    url: "https://bakery.example/api/orders/1001",
    status: 200,
    type: "XHR",
    requestHeaders: { cookie: "sid=secret" },
  }];
  const cat = mergeApiCatalog(store, "kit", "bakery.example", fresh);
  assert.ok(cat.length >= 1);
  assert.ok(cat[0].pathTemplate.includes("{id}"));
  assert.equal(store.get("kit|bakery.example").length, cat.length);
});
