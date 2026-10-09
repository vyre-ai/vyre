// @ts-check
// codec: read and write values through a request's decoded layers, leaving every other byte alone.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { getAt, setAt, walk, fillTemplate, fillSlotTemplate, templateRefs, escapeTemplate } from "./codec.js";

const req = (/** @type {any} */ o) => ({ method: "GET", url: "https://x.test/a", headers: {}, ...o });

test("path, query, header and form layers read and write, and untouched bytes stay", () => {
  const r = req({ url: "https://x.test/in/ada/posts?q=hello%20world&tag=a&tag=b&z=%7E", headers: { "x-id": "old" } });
  assert.equal(getAt(r, ["path:1"]), "ada");
  assert.equal(getAt(r, ["query:q"]), "hello world");
  assert.equal(getAt(r, ["query[1]:tag"]), "b");
  assert.equal(setAt(r, ["path:1"], "grace").url, "https://x.test/in/grace/posts?q=hello%20world&tag=a&tag=b&z=%7E");
  assert.equal(setAt(r, ["query:q"], "a b&c").url, "https://x.test/in/ada/posts?q=a%20b%26c&tag=a&tag=b&z=%7E");
  assert.equal(setAt(r, ["header:X-Id"], "new").headers["x-id"], "new");
  const f = req({ method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "a=1&b=two+words&a=3" });
  assert.equal(getAt(f, ["form[1]:a"]), "3");
  assert.equal(setAt(f, ["form:b"], "x y").body, "a=1&b=x+y&a=3");
});

test("JSON inside a string inside a form field is reached and re-encoded layer by layer", () => {
  const inner = JSON.stringify(["term", null, 10]);
  const outer = JSON.stringify([[["rpc", inner, null, "generic"]]]);
  const r = req({ method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: `f.req=${encodeURIComponent(outer)}&at=tok` });
  const at = ["form:f.req", "json:/0/0/1", "json:/0"];
  assert.equal(getAt(r, at), "term");
  const out = setAt(r, at, "other");
  assert.equal(getAt(out, at), "other");
  assert.equal(getAt(out, ["form:at"]), "tok");
  assert.equal(getAt(out, ["form:f.req", "json:/0/0/1", "json:/2"]), 10, "a number elsewhere in the inner layer keeps its type");
});

test("a base64 layer round-trips in the alphabet and padding it came in", () => {
  const state = JSON.stringify({ page: 2, q: "term" });
  const b64url = btoa(state).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const r = req({ url: `https://x.test/s?state=${b64url}` });
  assert.equal(getAt(r, ["query:state", "b64", "json:/q"]), "term");
  const out = setAt(r, ["query:state", "b64", "json:/q"], "new");
  assert.equal(getAt(out, ["query:state", "b64", "json:/q"]), "new");
  assert.ok(!/=/.test(out.url.split("state=")[1]), "padding is not added where the original had none");
});

test("integers past 2^53 survive a read and a write as exact digits", () => {
  const r = req({ method: "POST", body: '{"id":12345678901234567890,"q":"a"}' });
  assert.equal(getAt(r, ["body", "json:/id"]), "12345678901234567890");
  assert.equal(setAt(r, ["body", "json:/q"], "b").body, '{"id":12345678901234567890,"q":"b"}');
});

test("walk lists every leaf with its step path, including nested JSON and base64 JSON", () => {
  const r = req({ method: "POST", url: "https://x.test/p/ada?x=1", headers: { "content-type": "application/json" }, body: JSON.stringify({ a: { b: "deep" }, s: JSON.stringify({ n: 5 }) }) });
  const ats = walk(r).map(l => l.at.join(" > "));
  assert.ok(ats.includes("path:1"));
  assert.ok(ats.includes("query:x"));
  assert.ok(ats.includes("body > json:/a/b"));
  assert.ok(ats.includes("body > json:/s > json:/n"), ats.join("\n"));
});

test("templates: braces are literal when doubled, unknown names stay, escapes follow the leaf", () => {
  assert.equal(fillTemplate("q={q}&f={{id}}&u={other}", { q: "a b" }), "q=a b&f={id}&u={other}");
  assert.equal(fillSlotTemplate("next=/s?q={q}", { q: "a&b" }, "url"), "next=/s?q=a%26b");
  assert.equal(fillSlotTemplate('search(q: "{q}")', { q: 'say "hi"' }, "json"), 'search(q: "say \\"hi\\"")');
  assert.deepEqual(templateRefs("v1:{cookie:sid}:{q}:{session:csrf}"), ["cookie:sid", "session:csrf"]);
  assert.equal(escapeTemplate("{a}"), "{{a}}");
});
