// @ts-check
// The PDF converter for real: the pinned Gotenberg image, run exactly as the space's unit runs it (read-only, no capabilities, no new privileges, temp folders), turns a filled Word document into a PDF.
// Skips itself unless VYRE_PDF_LIVE=1. Run it on a test box with Docker: VYRE_PDF_LIVE=1 node --test core/documents/pdf-live.test.js
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { allowLoopbackForTests } from "../../lib/http.js";
import { homeUnit } from "../../lib/spaces/home-unit.js";
import { fill } from "./fill.js";
import { toPdf } from "./pdf.js";
import { docx } from "./testing/docx.js";

const LIVE = process.env.VYRE_PDF_LIVE === "1";

test("the hardened, pinned converter makes a PDF of a filled document", { skip: !LIVE, timeout: 180_000 }, async t => {
  const g = homeUnit({ id: "spc_harlow00001", name: "harlow" }, { random: n => new Uint8Array(n) }).compose.services.gotenberg;
  const image = String(g.image);
  const name = `vyre-pdf-live-${process.pid}`;
  const run = spawnSync("docker", ["run", "--rm", "-d", "--name", name, "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true", ...g.tmpfs.flatMap((/** @type {string} */ p) => ["--tmpfs", p]), "-p", "127.0.0.1::3000", image, ...g.command], { encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  t.after(() => { spawnSync("docker", ["rm", "-f", name]); allowLoopbackForTests(false); });
  const port = /:(\d+)$/m.exec(spawnSync("docker", ["port", name, "3000/tcp"], { encoding: "utf8" }).stdout.split("\n")[0])?.[1];
  assert.ok(port, "the converter published a loopback port for the test");
  allowLoopbackForTests(true);
  const { buffer } = fill(docx(["Dear {client.name}, your fee is {fee}."]), { client: { name: "Dana Harlow" }, fee: 1500 });
  let pdf = null;
  for (let i = 0; i < 40 && !pdf; i++) { try { pdf = await toPdf(buffer, { url: `http://127.0.0.1:${port}` }); } catch { await new Promise(r => setTimeout(r, 1000)); } }
  assert.ok(pdf, "the converter answered");
  assert.equal(pdf.subarray(0, 5).toString(), "%PDF-");
  assert.ok(pdf.length > 1000);
});
