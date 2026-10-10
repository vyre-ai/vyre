// @ts-check
// The phone's Glass frame wire: what the app injects reaches the page as a marked `message` event, and what the page says comes back as an object or nothing.
import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import fs from "node:fs";
import { toPage, fromPage } from "./frame-bridge.js";

test("a message from the app arrives in the page as a message event marked __host, with the data intact", () => {
  const seen = [];
  const window = { dispatchEvent: (e) => { seen.push(e); return true; } };
  vm.runInNewContext(toPage({ t: "connect", url: "ws://box:7000/glass/x?ticket=a\"b", quality: 6, compression: 2, fit: true }), { window, Event, Object });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].type, "message");
  assert.deepEqual(JSON.parse(JSON.stringify(seen[0].data)), { t: "connect", url: 'ws://box:7000/glass/x?ticket=a"b', quality: 6, compression: 2, fit: true, __host: true });
  // a message cannot break out of the script, whatever its text
  const out = [];
  vm.runInNewContext(toPage({ t: "x", note: "</script> ');alert(1);//" }), { window: { dispatchEvent: (e) => out.push(e) }, Event, Object });
  assert.equal(out[0].data.note, "</script> ');alert(1);//");
});

test("what the page says is an object with a type, or nothing", () => {
  assert.deepEqual(fromPage('{"t":"live"}'), { t: "live" });
  assert.deepEqual(fromPage('{"t":"down","code":1006,"reason":"x","clean":false}'), { t: "down", code: 1006, reason: "x", clean: false });
  for (const bad of ["", "nope", "[]", "42", "null", '{"x":1}', '{"t":5}']) assert.equal(fromPage(bad), null, bad);
});

test("the frame page tells a phone WebView from an iframe and trusts only the host's marked messages there", () => {
  const src = fs.readFileSync(new URL("../../src/glass/frame.js", import.meta.url), "utf8");
  assert.match(src, /typeof window\.ReactNativeWebView === "object"/);
  assert.match(src, /native \? e\.data\.__host !== true : e\.source !== window\.parent \|\| e\.origin !== location\.origin/);
  assert.match(src, /native\.postMessage\(JSON\.stringify\(m\)\)/);
});
