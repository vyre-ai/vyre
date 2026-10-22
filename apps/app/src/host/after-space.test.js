// After a Space is online the page sets the name and the photo, names the assistant on the paired server, and reads the first chat from assistant.welcome.
import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { createHost } from "./host-core.js";
import { afterSpace, phaseOf } from "../../../../lib/first-run-shape.js";
import { world, BASE } from "../../../../names/worker/testing.js";
import worker from "../../../../names/worker/index.js";

const FAST = { memoryKiB: 64, passes: 2 };
const PASSWORD = "correct horse battery staple";
const LOOK = "s3~c5~e1~m2~t4~b1~h0";

const memoryStore = () => { let kept = null; return { load: async () => (kept ? structuredClone(kept) : null), save: async (k) => { kept = structuredClone(k); } }; };

function directory(t) {
  const w = world(t);
  const fetchIn = async (url, init = {}) => {
    const u = new URL(url);
    const headers = new Headers(init.headers || {});
    headers.set("cf-connecting-ip", "203.0.113.9");
    return worker.fetch(new Request(`${BASE}${u.pathname}${u.search}`, { method: init.method || "GET", headers, body: init.body }), w.env);
  };
  return { fetch: fetchIn, base: BASE, now: () => w.clock.t };
}

test("after the space is online: name, photo, assistant, then the first chat", async (t) => {
  assert.deepEqual([afterSpace(), afterSpace("setup.name"), afterSpace("setup.photo"), afterSpace("setup.assistant"), afterSpace("setup.model"), afterSpace("setup.chat")], ["setup.name", "setup.photo", "setup.assistant", "setup.model", "setup.chat", "ready"]);
  for (const s of ["setup.name", "setup.photo", "setup.assistant", "setup.model", "setup.chat"]) assert.equal(phaseOf(s), 2, s);

  const d = directory(t);
  const calls = [];
  const store = memoryStore();
  const host = createHost({
    store, directory: d.base, fetch: d.fetch, now: d.now, kdf: FAST,
    space: { load: async () => ({ call: async (name, input, box) => {
      calls.push({ name, input, box });
      if (name === "assistant.welcome") return { text: "Hi Pia Walker. I'm Juno, your assistant.", cards: [{ id: "pair", title: "Pair this server", body: "Finish pairing." }] };
      if (name === "onboard.assistant") return { made: true, name: "juno", display: "Juno" };
      return { ok: true };
    } }) },
  });
  await host.call("onboard.person.create", { username: "juniper", password: PASSWORD, confirm: PASSWORD });
  await host.call("identity.heal");
  assert.deepEqual(await host.call("identity.display.set", { display: "Pia Walker" }), { display: "Pia Walker" });
  assert.deepEqual(await host.call("identity.photo.set", { photo: "https://photos.example/pia.png" }), { photo: "https://photos.example/pia.png" });
  await assert.rejects(() => host.call("identity.photo.set", { photo: "http://photos.example/a.png" }), (e) => e.code === "bad_photo");
  await assert.rejects(() => host.call("identity.photo.set", { photo: "notaurl" }), (e) => e.code === "bad_photo");
  const status = await host.call("identity.status");
  assert.equal(status.display, "Pia Walker");
  assert.equal(status.photo, "https://photos.example/pia.png");

  const local = await host.call("onboard.first.chat");
  assert.match(local.text, /Pia Walker/);
  assert.equal(calls.length, 0, "with no paired server the welcome is built here");

  const k = await store.load();
  await store.save({ ...k, current: "spc_juniperjuniper", spaces: [{ id: "spc_juniperjuniper", name: "juniper", role: "owner", server: "https://juniper.vyre.run", paired: { box: "boxA", route: "r", relay: "x", name: "juniper" } }] });
  const chat = await host.call("onboard.first.chat");
  assert.equal(chat.text, "Hi Pia Walker. I'm Juno, your assistant.");
  assert.equal(chat.cards[0].id, "pair");
  assert.equal(calls.at(-1).name, "assistant.welcome");
  assert.equal(calls.at(-1).box, "boxA");

  const made = await host.call("onboard.assistant.set", { name: "Juno", look: LOOK, person: "Pia Walker" });
  assert.deepEqual(made, { name: "juno", display: "Juno", look: LOOK });
  const sent = calls.filter((c) => ["onboard.you", "onboard.assistant", "agents.update"].includes(c.name));
  assert.deepEqual(sent.map((c) => c.name), ["onboard.you", "onboard.assistant", "agents.update"]);
  assert.equal(sent[0].input.name, "Pia Walker");
  assert.equal(sent[0].input.assistant, "Juno");
  assert.ok(sent.every((c) => c.box === "boxA"));
});
