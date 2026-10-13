// @ts-check
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { drive, escapeQuery } from "./drive.js";

const acct = (name, email) => ({ name, email, auth: { type: "service-account", item: "sa", subject: email } });

test("search asks drive.readonly for each account given and tags rows with the account", async () => {
  const calls = [];
  const request = async (a, req) => { calls.push([a.name, req.api, req.scope, req.path, req.query]); return { files: [{ id: "f1", name: "Plan", mimeType: "application/vnd.google-apps.document", modifiedTime: "2026-10-01T00:00:00Z", webViewLink: "https://docs.google.com/x" }] }; };
  const rows = await drive({ request }).search([acct("a", "alice@firm.test")], { q: "plan", limit: 5 });
  assert.equal(calls[0][1], "drive"); assert.equal(calls[0][2], "drive.readonly"); assert.equal(calls[0][3], "/drive/v3/files");
  assert.match(calls[0][4].q, /fullText contains 'plan'/);
  assert.match(calls[0][4].q, /trashed = false/);
  assert.deepEqual(rows.map(r => [r.account, r.id, r.name]), [["a", "f1", "Plan"]]);
});

test("a query cannot break out of its quotes", () => {
  assert.equal(escapeQuery("it's \\ x"), "it\\'s \\\\ x");
  assert.throws(() => escapeQuery("a".repeat(300)), /too long/);
});

test("read exports a Google doc as text, reads plain files by media, refuses binaries, caps the text", async () => {
  const seen = [];
  const request = async (a, req) => {
    seen.push(req.path + JSON.stringify(req.query || {}));
    if (req.path === "/drive/v3/files/doc11111") return { id: "doc11111", name: "Doc", mimeType: "application/vnd.google-apps.document" };
    if (req.path === "/drive/v3/files/txt11111") return { id: "txt11111", name: "n.txt", mimeType: "text/plain" };
    if (req.path === "/drive/v3/files/pdf11111") return { id: "pdf11111", name: "x.pdf", mimeType: "application/pdf" };
    return { text: "x".repeat(30000) };
  };
  const d = drive({ request });
  const doc = await d.read(acct("a", "alice@firm.test"), { id: "doc11111" });
  assert.equal(doc.text.length, 20000); assert.equal(doc.truncated, true);
  assert.ok(seen.some(s => s.includes("/export") && s.includes("text/plain")));
  await d.read(acct("a", "alice@firm.test"), { id: "txt11111" });
  assert.ok(seen.some(s => s.includes("alt") && s.includes("media")));
  const pdf = await d.read(acct("a", "alice@firm.test"), { id: "pdf11111" });
  assert.equal(pdf.text, undefined); assert.match(pdf.note, /not text/);
  await assert.rejects(d.read(acct("a", "x@y.z"), { id: "../x" }), /id/);
});
