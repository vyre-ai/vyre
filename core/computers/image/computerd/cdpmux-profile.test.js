// @ts-check
import "../../../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { CdpMux } from "./cdpmux.js";
import { FakeChrome } from "./testing/fake-chrome.js";
import { PassThrough } from "node:stream";

function world() {
  const toChrome = new PassThrough();
  const fromChrome = new PassThrough();
  const fake = new FakeChrome();
  fake.wire(toChrome, fromChrome);
  const mux = new CdpMux({ log: () => {} });
  mux.attach(toChrome, fromChrome);
  return { mux, fake };
}

test("cdpmux: exportAgentContext and importAgentContext round-trip cookies", async () => {
  const { mux, fake } = world();
  mux.contextStore.set("agt-1", "ctx-1");
  fake.cookies.set("ctx-1", [{ name: "sid", value: "x", domain: "a.test", path: "/" }]);
  const exported = await mux.exportAgentContext("agt-1");
  assert.equal(exported.cookies[0].name, "sid");
  assert.equal(await mux.importAgentContext("agt-2", exported), true);
  const ctx2 = mux.contextStore.get("agt-2");
  assert.ok(typeof ctx2 === "string");
  const again = await mux.exportAgentContext("agt-2");
  assert.equal(again.cookies[0].name, "sid");
});

test("cdpmux soak: repeated export/import across contexts stays consistent", async () => {
  const { mux, fake } = world();
  for (let n = 0; n < 8; n++) {
    const id = `agt-${n}`;
    mux.contextStore.set(id, `ctx-${n}`);
    fake.cookies.set(`ctx-${n}`, [{ name: `c${n}`, value: String(n), domain: "soak.test", path: "/" }]);
    const exported = await mux.exportAgentContext(id);
    assert.equal(exported.cookies[0].value, String(n));
    const target = `agt-${(n + 1) % 8}`;
    await mux.importAgentContext(target, exported);
    const round = await mux.exportAgentContext(target);
    assert.equal(round.cookies[0].name, `c${n}`);
  }
});
