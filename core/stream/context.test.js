// @ts-check
// What a chat message carries for the assistants beside the words: a card of a record named exactly, and the files attached. Over a fake kernel; the whole flow on a real daemon is in core/stream tests.
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createSendContext } from "./context.js";
import { put } from "../../lib/attachments-store.js";
import { SCRATCH } from "../../test/scratch.mjs";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==", "base64");
function fakeKernel() {
  /** @type {Map<string, Uint8Array>} */ const files = new Map();
  const person = { hops: [{ actor: { kind: "person", id: "per_x" } }] };
  return {
    person, files,
    records: {
      query: async (/** @type {any} */ _c, /** @type {string} */ type) => ({ rows: type === "chat-record" ? [{ data: { drive: "Projects/p", chat: "c1" } }] : [] }),
      search: async () => ({ rows: [{ type: "contact", id: "c1" }] }),
      reference: async () => ({ urn: "vyre://spc_a/contact/c1", title: "Dana Whitfield", fields: [{ name: "status", label: "Status", kind: "text", value: "open" }] }),
    },
    drive: {
      put: async (/** @type {any} */ _c, /** @type {string} */ p, /** @type {Uint8Array} */ b) => { files.set(p, b); },
      list: async (/** @type {any} */ _c, /** @type {string} */ f) => [...files].filter(([p]) => p.startsWith(`${f}/`)).map(([p, b]) => ({ path: p, size: b.length })),
      get: async (/** @type {any} */ _c, /** @type {string} */ p) => files.get(p),
    },
  };
}
const call = async () => ({ error: { code: "not_found" } }); // settings.get answers nothing: cards stay on

test("a message with a named record and attached files: the card for everyone, an image inline for an assistant with a session, the rest as paths", async t => {
  const k = fakeKernel();
  const png = await put(k, k.person, "c1", { name: "screenshot.png", bytes: new Uint8Array(PNG) });
  const pdf = await put(k, k.person, "c1", { name: "offer letter.pdf", bytes: new TextEncoder().encode("%PDF-1.4") });
  const a = fs.mkdtempSync(path.join(SCRATCH, "vyre-ctx-a-")), b = fs.mkdtempSync(path.join(SCRATCH, "vyre-ctx-b-"));
  t.after(() => { fs.rmSync(a, { recursive: true, force: true }); fs.rmSync(b, { recursive: true, force: true }); });
  const make = createSendContext({ kernel: k, call });
  const got = await make({ chain: k.person, grp: "c1", text: "What is Dana Whitfield's status? See the files.", attachments: [png, pdf], members: [
    { who: "assistant:juno", cwd: a, session: true }, { who: "model:claude/default#1", cwd: b, session: false }] });
  assert.deepEqual(got.saved.map(x => x.id), [png.id, pdf.id]);
  // an assistant with a session: the image rides inline, the pdf is a path in its folder
  const juno = got.noteOf("assistant:juno");
  assert.match(juno, /\[Vyre record card, from the person's own words naming "Dana Whitfield"/);
  assert.match(juno, /The person attached 2 files; one is an image, shown to you\./);
  assert.ok(juno.includes(path.join(a, ".vyre", "attachments", `${pdf.id}-offer letter.pdf`)));
  assert.deepEqual(got.imagesOf("assistant:juno"), [{ media_type: "image/png", data: PNG.toString("base64") }]);
  assert.ok(fs.existsSync(path.join(a, ".vyre", "attachments", `${pdf.id}-offer letter.pdf`)));
  // one that is just starting has no session to carry an image yet: both are paths in its folder
  const slot = got.noteOf("model:claude/default#1");
  assert.ok(slot.includes(path.join(b, ".vyre", "attachments", `${png.id}-screenshot.png`)) && slot.includes(path.join(b, ".vyre", "attachments", `${pdf.id}-offer letter.pdf`)));
  assert.deepEqual(got.imagesOf("model:claude/default#1"), []);
});

test("a bad list refuses the whole send, and a folder that is not on this machine is said in words", async () => {
  const k = fakeKernel();
  const pdf = await put(k, k.person, "c1", { name: "a.pdf", bytes: new TextEncoder().encode("%PDF") });
  const make = createSendContext({ kernel: k, call });
  const q = (/** @type {any} */ attachments) => make({ chain: k.person, grp: "c1", text: "hi", attachments, members: [{ who: "assistant:juno", cwd: "/nowhere/at/all", session: true }] });
  await assert.rejects(q([{ ...pdf, id: "att_Nope0000000000000000" }]), { code: "bad_input" });
  await assert.rejects(q([pdf, pdf]), { code: "bad_input" });
  await assert.rejects(q("nope"), { code: "bad_input" });
  await assert.rejects(make({ chain: null, grp: "c1", text: "hi", attachments: [pdf], members: [] }), { code: "bad_input" });
  const got = await q([pdf]);
  assert.match(got.noteOf("assistant:juno"), /is at \(in this chat's files; this assistant's folder is not on this machine\)/);
  assert.equal((await q(undefined)).noteOf("assistant:juno").includes("attached"), false, "nothing attached, nothing said");
});
