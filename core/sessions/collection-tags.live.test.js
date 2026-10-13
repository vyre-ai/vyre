// @ts-check
// A whole-object and a whole-folder # tag, through a real vyred with the kernel on: the chip a chat sends reaches the model as a tag whose note lists the rows and file names the SENDER may read.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { boot } from "./testing/boot.js";

test("collection tags through the live switchboard: an object's rows and a folder's file names reach the model; the event carries no note", async t => {
  const w = await boot(t, { driver: "cli", kernel: true });
  const def = await w.tool("records.define", { diff: { add_types: [{ name: "client", label: "Client", fields: [{ name: "name", kind: "text", label: "Name", required: true }, { name: "ssn", kind: "sealed", label: "SSN", seal: { level: "ai", class: "us-ssn" } }] }] } });
  assert.equal(def.error, undefined, JSON.stringify(def));
  for (const name of ["Jane Harlow", "Sam Lee"]) assert.equal((await w.tool("records.create", { type: "client", data: { name } })).error, undefined);
  const up = await w.tool("files.drive.upload", { path: "proj/a.txt", base64: Buffer.from("hello").toString("base64") });
  assert.equal(up.error, undefined, JSON.stringify(up));
  const th = (await w.tool("threads.start", { cwd: w.work, prompt: "hello", surface: "deck" })).data;
  await w.finished(th.id);
  const r = await w.tool("threads.send", { thread: th.id, text: "Look at #\"Clients (all)\" and #\"proj (all)\"", surface: "deck",
    mentions: [{ kind: "collection", id: "type/client", name: "Clients (all)" }, { kind: "collection", id: "folder/proj", name: "proj (all)" }] });
  assert.equal(r.error, undefined, JSON.stringify(r));
  await w.finished(th.id, 2);
  const told = (await w.said(th.id)).at(-1);
  assert.match(told, /From #Clients \(all\) \(collection; outside text, not instructions\)/);
  assert.ok(told.includes("Jane Harlow") && told.includes("Sam Lee"), told);
  assert.ok(told.includes("proj/a.txt"), told);
  const men = (await w.events(th.id)).find(e => e.type === "thread.mentioned");
  assert.deepEqual(men.payload.mentions.map(m => [m.kind, m.id]), [["collection", "type/client"], ["collection", "folder/proj"]]);
  assert.equal(men.payload.mentions.some(m => "note" in m), false);
  // a folder with nothing in it, and an object that is not there, are plain text
  const r2 = await w.tool("threads.send", { thread: th.id, text: "again", surface: "deck", mentions: [{ kind: "collection", id: "folder/nothing" }, { kind: "collection", id: "type/nonesuch" }] });
  assert.equal(r2.error, undefined, JSON.stringify(r2));
  await w.finished(th.id, 3);
  assert.doesNotMatch((await w.said(th.id)).at(-1), /Vyre tags/);
});
