// @ts-check
// Files on a message by reference: held with path, name, size and hash and the asker; read only at the send, refused if the file changed, if the asker may no longer read it, or if they are too big or too many.
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { hold, release, MAX_TOTAL, MAX_FILES, typeOf } from "./attachments.js";
import { rfc822Text } from "./message.js";

const sha = (/** @type {Buffer} */ b) => crypto.createHash("sha256").update(b).digest("hex");
function world() {
  /** @type {Record<string, Buffer>} */ const files = { "Rota/week1.pdf": Buffer.from("PDF-1"), "Rota/week2.pdf": Buffer.from("PDF-2") };
  /** @type {Set<string>} */ const readable = new Set(["Rota/week1.pdf", "Rota/week2.pdf"]);
  /** @type {string[]} */ const serviceReads = [];
  const ctx = { kernel: { space: "spc_x",
    chain: async () => ({ hops: [{ actor: { kind: "person", id: "per_alex" } }] }),
    drive: { get: async (/** @type {any} */ c, /** @type {string} */ p, /** @type {any} */ o) => { if (c.svc) serviceReads.push(p); else if (!readable.has(p)) throw new Error("denied"); const b = files[p]; if (o && o.maxBytes && b.length > o.maxBytes) throw Object.assign(new Error("big"), { code: "too_large" }); return b; } },
    serviceChain: () => ({ svc: true }),
    personMay: async (/** @type {string} */ person, /** @type {string} */ action, /** @type {string} */ res) => person === "per_alex" && action === "drive.read" && readable.has(res.replace("vyre://spc_x/file/", "")) } };
  return { ctx, files, readable, serviceReads };
}

test("hold records path, name, size, hash and the asker; release returns the bytes only for what was held", async () => {
  const w = world();
  const held = await hold(w.ctx, {}, [{ path: "Rota/week1.pdf", name: "Week 1.pdf" }, { path: "Rota/week2.pdf" }]);
  assert.deepEqual(held.map(h => [h.path, h.name, h.size, h.by]), [["Rota/week1.pdf", "Week 1.pdf", 5, "per_alex"], ["Rota/week2.pdf", "week2.pdf", 5, "per_alex"]]);
  assert.ok(held.every(h => /^[0-9a-f]{64}$/.test(h.sha256)) && !JSON.stringify(held).includes("PDF-1"), "no bytes in the held content");
  assert.deepEqual(await hold(w.ctx, {}, undefined), []);
  const sent = await release(w.ctx, held);
  assert.deepEqual(sent.map(s => [s.filename, s.contentType, s.bytes.toString()]), [["Week 1.pdf", "application/pdf", "PDF-1"], ["week2.pdf", "application/pdf", "PDF-2"]]);
  assert.deepEqual(w.serviceReads, ["Rota/week1.pdf", "Rota/week2.pdf"], "the module read exactly the held paths");
});

test("hold refuses a file the asker may not read, a bad path, too many files and too much", async () => {
  const w = world();
  await assert.rejects(hold(w.ctx, {}, [{ path: "Other/secret.pdf" }]), /not in your Files, or you may not read it/);
  for (const path of ["../etc/passwd", "/abs", "a/../b"]) await assert.rejects(hold(w.ctx, {}, [{ path }]), /by its path/);
  await assert.rejects(hold(w.ctx, {}, Array.from({ length: MAX_FILES + 1 }, () => ({ path: "Rota/week1.pdf" }))), /up to 10 files/);
  w.files["Big/x.bin"] = Buffer.alloc(MAX_TOTAL + 1); w.readable.add("Big/x.bin");
  await assert.rejects(hold(w.ctx, {}, [{ path: "Big/x.bin" }]), /over the size limit|at most 25 MB/);
  w.files["Big/a.bin"] = Buffer.alloc(MAX_TOTAL - 2); w.files["Big/b.bin"] = Buffer.alloc(10); w.readable.add("Big/a.bin"); w.readable.add("Big/b.bin");
  await assert.rejects(hold(w.ctx, {}, [{ path: "Big/a.bin" }, { path: "Big/b.bin" }]), /add up to at most 25 MB/);
  w.ctx.kernel.chain = async () => ({ hops: [{ actor: { kind: "agent", id: "kit" } }] });
  await assert.rejects(hold(w.ctx, {}, [{ path: "Rota/week1.pdf" }]), /only for a person/);
});

test("release refuses a file that changed, one the asker can no longer read, and anything the held content does not describe", async () => {
  const w = world();
  const held = await hold(w.ctx, {}, [{ path: "Rota/week1.pdf", name: "Rota.pdf" }]);
  w.files["Rota/week1.pdf"] = Buffer.from("PDF-X");
  await assert.rejects(release(w.ctx, held), /Rota.pdf changed after you approved this message, so nothing was sent. Approve it again./);
  w.files["Rota/week1.pdf"] = Buffer.from("PDF-1");
  assert.equal((await release(w.ctx, held)).length, 1, "the same bytes pass again");
  w.readable.delete("Rota/week1.pdf");
  await assert.rejects(release(w.ctx, held), /can no longer be read by the person who asked/);
  w.readable.add("Rota/week1.pdf");
  await assert.rejects(release(w.ctx, [{ ...held[0], path: "Rota/week2.pdf" }]), /changed after you approved/, "a swapped path does not carry the old hash");
  await assert.rejects(release(w.ctx, [{ ...held[0], path: "../x" }]), /not a file this message may carry/);
  await assert.rejects(release(w.ctx, [{ name: "x", path: "Rota/week1.pdf" }]), /not a file this message may carry/, "no asker, no hash");
  assert.deepEqual(w.serviceReads.filter(p => p === "../x"), [], "no path outside the held content is ever read");
});

test("rfc822Text with files is multipart/mixed: the text first, each file base64 and named", () => {
  const t = rfc822Text({ from: "a@harlow.example", to: ["b@northwind-bakery.example"], subject: "Rota", body: "See attached", attachments: [{ filename: "week1.pdf", contentType: typeOf("week1.pdf"), bytes: Buffer.from("PDF-1") }] });
  assert.match(t, /Content-Type: multipart\/mixed; boundary="/);
  assert.match(t, /Content-Disposition: attachment; filename="week1.pdf"/);
  assert.match(t, new RegExp(Buffer.from("PDF-1").toString("base64")));
  assert.ok(t.indexOf("text/plain") < t.indexOf("application/pdf"), "the text comes first");
  assert.ok(!/multipart/.test(rfc822Text({ to: ["b@x.example"], subject: "s", body: "b" })), "no files, no change");
});
