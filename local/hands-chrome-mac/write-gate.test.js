// @ts-check
// Hygiene: there is ONE write gate. Nothing in the extension may issue a request with the page's credentials except through pageFetch(), and pageFetch()
// refuses a write that did not pass writeGate(). This test reads the source so that a new route cannot be added without going through it.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { writeGate, PASS } from "./extension/shared/outbound.js";
import { pageFetch } from "./extension/caps/net.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXT = path.join(HERE, "extension");
const files = (/** @type {string} */ d) => fs.readdirSync(path.join(EXT, d)).filter(f => f.endsWith(".js")).map(f => ({ rel: `${d}/${f}`, src: fs.readFileSync(path.join(EXT, d, f), "utf8") }));
const all = [...files("caps"), ...files("lib"), ...files("shared")];

test("the page-side fetch() call exists only in pageFetch (net.js) and in the guard shims (outbound.js)", () => {
  const holders = all.filter(f => /(^|[^.\w])fetch\(/.test(f.src)).map(f => f.rel).sort();
  // outbound.js wraps window.fetch inside strings; sitecache and presence use none; icon code is gone.
  assert.deepEqual(holders, ["caps/net.js"]);
  const net = all.find(f => f.rel === "caps/net.js")?.src || "";
  const open = net.indexOf("export async function pageFetch");
  const close = net.indexOf("\nexport ", open + 10) > 0 ? net.indexOf("\n}\n", open) : net.length;
  const inside = net.slice(open, close);
  const hits = [...net.matchAll(/(^|[^.\w])fetch\(/g)].map(m => m.index || 0);
  assert.ok(hits.length > 0 && hits.every(i => i > open && i < close + 1), "every fetch( in net.js is inside pageFetch");
  assert.match(inside, /writeGate|PASS/, "pageFetch checks the pass");
});

test("every caller of pageFetch gets its pass from writeGate", () => {
  const callers = all.filter(f => /\bpageFetch\(/.test(f.src) && !/export async function pageFetch/.test(f.src) || (f.rel === "caps/net.js"));
  for (const f of callers) {
    const calls = [...f.src.matchAll(/\bpageFetch\(/g)].length - (f.rel === "caps/net.js" ? 1 : 0);
    if (calls <= 0) continue;
    assert.ok(/writeGate\(/.test(f.src), `${f.rel} calls pageFetch but never asks writeGate`);
    assert.ok(/gate\b/.test(f.src.slice(f.src.indexOf("pageFetch("))), `${f.rel} does not pass the gate to pageFetch`);
  }
});

test("the pass cannot be forged by importing it: PASS is imported only where pageFetch lives", () => {
  const users = all.filter(f => /\bPASS\b/.test(f.src) && !f.rel.endsWith("outbound.js")).map(f => f.rel);
  assert.deepEqual(users, ["caps/net.js"]);
});

test("no capability runs a script through Fetch-domain commands that re-issue requests", () => {
  // Fetch.fulfillRequest (a mock) and failRequest are allowed in net.js and devtools.js (they answer or stop the page's own request); continueRequest may only
  // pass a request through. No other file may use the Fetch domain.
  const users = all.filter(f => /"Fetch\./.test(f.src)).map(f => f.rel).sort();
  assert.deepEqual(users, ["caps/net.js"]);
});

test("writeGate: reads pass; a write passes only when asked or covered; otherwise it comes back held with its kind", () => {
  assert.equal(writeGate("GET", "https://a.example/x", "").pass, PASS);
  assert.equal(writeGate("post", "https://a.example/x", "{}", { asked: true }).pass, PASS);
  assert.equal(writeGate("DELETE", "https://a.example/x/1", "", { writeOk: true }).pass, PASS);
  const h = /** @type {any} */ (writeGate("DELETE", "https://a.example/x/1", "", {}).held);
  assert.equal(h.kind, "delete");
  assert.equal(h.write, true);
  assert.equal(writeGate("PUT", "https://a.example/x/1", "").pass, undefined);
});

test("pageFetch itself refuses a write with no pass, even if a caller forgets the gate", async () => {
  const ctx = { cdp: { attach: async () => {}, send: async () => ({}) }, tabs: { get: async () => ({}) } };
  await assert.rejects(pageFetch(/** @type {any} */ (ctx), 1, { url: "https://a.example/x", method: "DELETE" }), { code: "blocked" });
  await assert.rejects(pageFetch(/** @type {any} */ (ctx), 1, { url: "https://a.example/x", method: "POST" }, { gate: /** @type {any} */ ({ pass: Symbol("forged") }) }), { code: "blocked" });
});
