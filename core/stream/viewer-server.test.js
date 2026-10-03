// @ts-check
// Per viewer, on the server (reviewer gate C-3, chat-03): the viewer is part of the connection and every frame is drawn for
// them before conn.send, in serve, serveSSE and the replay path. A client never decides what it may see.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { SessionLog } from "./log.js";
import { serve, serveSSE } from "./server.js";
import { forViewer } from "./viewer.js";
import { createAdapter, pipe } from "./adapter.js";

const SECRET_REF = "seal:abc-9f31", SECRET_VALUE = "123-45-6789";
const record = () => ({ block: "record", urn: "urn:vyre:rec:1", type: "matter", title: "Harlow v. Northwind", fields: [
  { name: "title", label: "Title", kind: "text", value: "Harlow v. Northwind" },
  { name: "fee", label: "Fee", kind: "money", value: { amount: 4200, currency: "USD" }, read_roles: ["admin"] },
  { name: "ssn", label: "SSN", kind: "sealed", value: { sealed: "ssn", ref: SECRET_REF, present: true, valid_format: true, set_at: 1, hint: SECRET_VALUE.slice(-4) }, seal: { level: "human", class: "ssn", reveal_roles: ["owner"] } },
] });
const ADMIN = { id: "person:chris", roles: ["admin"] }, MEMBER = { id: "person:sam", roles: ["member"] };

/** A connection that keeps what it was sent. */
function conn() {
  /** @type {any[]} */ const got = [];
  return { got, send: (/** @type {any} */ f) => got.push(JSON.parse(JSON.stringify(f))), onClose: () => {}, close: () => {} };
}
const wire = (/** @type {any[]} */ got) => JSON.stringify(got);
const real = (/** @type {any[]} */ got) => got.filter(f => f.type !== "session.heartbeat");

function filled() {
  const log = new SessionLog("s1", { flushMs: 0 });
  log.append("text-delta", { message: "m1", index: 0, text: "hello" });
  log.append("tool-finished", { tool_id: "t1", ok: true, result: record() }, { author: "assistant:kit", acts_for: "person:alex" });
  log.append("tool-finished", { tool_id: "t2", ok: true, result: { block: "record", urn: "urn:vyre:rec:2", title: "Admin only matter", read_roles: ["admin"], fields: [{ name: "note", label: "Note", kind: "text", value: "settlement floor 90k" }] } });
  log.append("text-done", { message: "m1" });
  return log;
}

test("C-3: a second viewer's frames hold no value and no ref of a sealed field, nor a hidden field's value", () => {
  const log = filled();
  const a = conn(), m = conn();
  serve(log, a, { from: 0, viewer: ADMIN });
  serve(log, m, { from: 0, viewer: MEMBER });
  for (const c of [a, m]) {
    assert.ok(!wire(c.got).includes(SECRET_REF), "no ref leaves the home");
    assert.ok(!wire(c.got).includes(SECRET_VALUE), "no value, no hint that carries one");
    assert.ok(!wire(c.got).includes('"hint"'));
  }
  const fee = (/** @type {any} */ c) => real(c.got).find(f => f.data.tool_id === "t1").data.result.fields.find((/** @type {any} */ x) => x.name === "fee");
  assert.deepEqual(fee(a).value, { amount: 4200, currency: "USD" });
  assert.deepEqual(fee(m).value, { hidden: "role", kind: "money", present: true });
  assert.ok(!wire(m.got).includes("4200"), "the member's wire holds no fee");
});

test("C-3: a viewer who is not cleared for a record gets no frame for it, only its cursor", () => {
  const log = filled();
  const a = conn(), m = conn();
  serve(log, a, { from: 0, viewer: ADMIN });
  serve(log, m, { from: 0, viewer: MEMBER });
  assert.equal(real(a.got).find(f => f.cur === 3).type, "session.tool-finished");
  const stub = real(m.got).find(f => f.cur === 3);
  assert.equal(stub.type, "session.hidden");
  assert.deepEqual(stub.data, {});
  assert.ok(!wire(m.got).includes("Admin only matter") && !wire(m.got).includes("settlement floor") && !wire(m.got).includes("urn:vyre:rec:2"));
  assert.deepEqual(real(m.got).map(f => f.cur), [1, 2, 3, 4], "gapless: the client's own gap check holds");
});

test("C-3: replay gives the same filtered view as live", () => {
  const log = new SessionLog("s2", { flushMs: 0 });
  const live = conn();
  serve(log, live, { from: 0, viewer: MEMBER });
  log.append("text-delta", { message: "m1", index: 0, text: "hello" });
  log.append("tool-finished", { tool_id: "t1", ok: true, result: record() });
  log.append("tool-finished", { tool_id: "t2", ok: true, result: { block: "record", title: "x", read_roles: ["admin"], fields: [] } });
  const late = conn();
  serve(log, late, { from: 0, viewer: MEMBER });
  const strip = (/** @type {any[]} */ g) => real(g).map(f => ({ ...f }));
  assert.deepEqual(strip(late.got), strip(live.got));
  assert.ok(!wire(late.got).includes(SECRET_REF));
  // a connection that resumes from the middle is drawn the same way
  const mid = conn();
  serve(log, mid, { from: 1, viewer: MEMBER });
  assert.deepEqual(strip(mid.got), strip(live.got).slice(1));
});

test("C-3: the SSE form is drawn per viewer too", async t => {
  const log = filled();
  const s = http.createServer((req, res) => { serveSSE(log, req, res, { from: 0, viewer: MEMBER }); });
  await new Promise(r => s.listen(0, "127.0.0.1", () => r(undefined)));
  t.after(() => { s.closeAllConnections(); s.close(); });
  const port = /** @type {any} */ (s.address()).port;
  const body = await new Promise(resolve => {
    let text = "";
    const r = http.get({ port, host: "127.0.0.1", path: "/" }, res => { res.on("data", d => { text += d; if ((text.match(/^data:/gm) || []).length >= 5) { r.destroy(); resolve(text); } }); });
    r.on("error", () => resolve(text));
  });
  assert.ok(String(body).includes("session.hidden"));
  assert.ok(!String(body).includes(SECRET_REF) && !String(body).includes("settlement floor") && !String(body).includes("4200"));
});

test("C-3: forViewer leaves control frames, and other frames, alone", () => {
  const hb = { v: 1, id: "x", cur: 0, session: "s", type: "session.heartbeat", time: 1, data: { head: 3 } };
  assert.equal(forViewer(hb, MEMBER), hb);
  const t = { v: 1, id: "y", cur: 2, session: "s", type: "session.text-delta", time: 1, turn: null, data: { message: "m", index: 0, text: "hi" } };
  assert.equal(forViewer(t, MEMBER), t);
});

test("C-3: thread.shell output and its command are redacted before they are logged or sent", () => {
  const log = new SessionLog("s3", { flushMs: 0 });
  const ad = createAdapter();
  const key = "ghp_" + "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8";
  pipe(log, ad, { type: "thread.shell", payload: { command: `echo token=${key}`, output: `token=${key}\nGITHUB_TOKEN=${key}\nok\n` } });
  const c = conn();
  serve(log, c, { from: 0, viewer: MEMBER });
  const chunks = real(c.got).filter(f => f.type === "session.term-chunk");
  assert.ok(chunks.length >= 1);
  const text = chunks.map(f => Buffer.from(f.data.b64, "base64").toString("utf8")).join("");
  assert.ok(text.includes("ok"));
  assert.ok(!text.includes("a1B2c3D4") && !wire(c.got).includes("a1B2c3D4"), "no key on the wire");
  assert.ok(!JSON.stringify(log.read(0)).includes("a1B2c3D4"), "none in the log either");
});
