// @ts-check
import "../../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { install, text, $ } from "../../test/fake-dom.js";

const doc = /** @type {any} */ (install());
doc.importNode = n => n;
doc.createDocumentFragment = () => new /** @type {any} */ (globalThis).Element("fragment");
Object.assign(globalThis, {
  DOMParser: class { parseFromString() { const E = /** @type {any} */ (globalThis).Element; const svg = new E("svg"); svg.append(new E("circle")); return { documentElement: svg }; } },
});
const { vaultUsed } = await import("./vault-used.js");

test("using #name: the name and the host, nothing that could be a value, and nothing to press", () => {
  const el = vaultUsed({ name: "GHLapikey", host: "services.leadconnectorhq.com", at: 5 });
  assert.equal(text($(el, ".cv-using-line")), "using #GHLapikey · services.leadconnectorhq.com");
  assert.equal(el.querySelector?.("button") ?? null, null);
  assert.equal(/** @type {any} */ (el)._ts, 5);
  assert.equal(text(vaultUsed({ name: "Stripe" })).trim(), "using #Stripe");
});
