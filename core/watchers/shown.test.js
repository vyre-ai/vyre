// @ts-check
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { ShownLog } from "./shown.js";
import { createTarget } from "./targets.js";
import * as folder from "./folder.js";
import { watchersIntents } from "../../lib/said/watchers.js";
import { tempHome } from "../../test/helpers.js";

test("a thread's shown cards: newest per watcher, per thread, nothing recomputed", () => {
  let t = 1000;
  const log = new ShownLog({ now: () => t++ });
  log.record("t1", { name: "mail-harlow", hash: "aaa", title: "Files mail", state: "draft", project: "harlow-legal" });
  log.record("t1", { name: "feed-news", hash: "fff", project: "harlow-legal" });
  log.record("t1", { name: "mail-harlow", hash: "bbb", title: "Files mail", project: "harlow-legal" });   // shown again after an edit
  log.record("t2", { name: "mail-harlow", hash: "zzz", project: "northwind" });
  assert.deepEqual(log.list("t1").map(e => [e.name, e.hash]), [["feed-news", "fff"], ["mail-harlow", "bbb"]], "newest per watcher");
  assert.deepEqual(log.list("t2").map(e => [e.name, e.hash, e.project]), [["mail-harlow", "zzz", "northwind"]], "another thread sees only its own");
  assert.deepEqual(log.list("nobody"), []);
  log.record("", { name: "x", hash: "h", project: "p" }); log.record("t3", { name: "x", project: "p" });
  assert.deepEqual(log.list("t3"), [], "a card without a hash or a thread is not recorded");
  assert.notEqual(log.list("t1")[0], log.list("t1")[0], "a copy is returned");
});

test("card A shown, folder edited: shown still says A, and neither a yes for A nor a call with B is licensed", t => {
  const home = tempHome(t);
  const dir = path.join(home, "watchers");
  const mk = code => { fs.mkdirSync(path.join(dir, "mail-harlow"), { recursive: true });
    fs.writeFileSync(path.join(dir, "mail-harlow", "watcher.json"), JSON.stringify({ name: "mail-harlow", project: "harlow-legal", schedule: "*/15 * * * *" }));
    fs.writeFileSync(path.join(dir, "mail-harlow", "watch.js"), code); };
  mk("export default async function watch() {}");
  const A = String(folder.read(dir, "mail-harlow").hash);
  const log = new ShownLog();
  log.record("t1", { name: "mail-harlow", hash: A, title: "Files mail", state: "draft", project: "harlow-legal" });

  mk("export default async function watch() { /* edited after the card */ }");
  const B = String(folder.read(dir, "mail-harlow").hash);
  assert.notEqual(A, B);
  assert.equal(log.list("t1")[0].hash, A, "shown still says A: it is a record, not a read of the folder");

  // The person's "turn it on" is recorded against the card they were shown.
  const where = { project: "harlow-legal", kinds: ["mail"], watchers: log.list("t1").map(e => ({ ...e, shownTurnsAgo: 0 })) };
  const recorded = watchersIntents("Yes, turn it on.", where).intents.map(i => i.to[0]);
  assert.deepEqual(recorded, [`watchers.create:harlow-legal/mail-harlow@${A}`]);
  const read = n => folder.read(dir, n);
  // A call for the code they saw: the folder is not that code now, so there is no key and it is refused.
  assert.deepEqual(createTarget({ input: { name: "mail-harlow", hash: A } }, { read }), { to: [] });
  // A call for the edited code: a key exists, but it is not the one the person's words recorded.
  const forB = createTarget({ input: { name: "mail-harlow", hash: B } }, { read }).to[0];
  assert.equal(forB, `watchers.create:harlow-legal/mail-harlow@${B}`);
  assert.ok(!recorded.includes(forB), "the yes was for A, not B");
});

test("the recorder's own key is exactly what the target answers for an unchanged folder, and a pronoun several turns later records nothing", t => {
  const home = tempHome(t);
  const dir = path.join(home, "watchers");
  fs.mkdirSync(path.join(dir, "mail-harlow"), { recursive: true });
  fs.writeFileSync(path.join(dir, "mail-harlow", "watcher.json"), JSON.stringify({ name: "mail-harlow", project: "harlow-legal", schedule: "*/15 * * * *" }));
  fs.writeFileSync(path.join(dir, "mail-harlow", "watch.js"), "export default async function watch() {}");
  const hash = String(folder.read(dir, "mail-harlow").hash);
  const card = { name: "mail-harlow", hash, title: "Files mail", state: "draft" };
  const said = turnsAgo => watchersIntents("Yes, turn it on.", { project: "harlow-legal", kinds: ["mail"], watchers: [{ ...card, shownTurnsAgo: turnsAgo }] }).intents.map(i => i.to[0]);
  const asked = createTarget({ tool: "watchers.create", input: { name: "mail-harlow", hash } }, { read: n => folder.read(dir, n) }).to;
  assert.deepEqual(said(0), asked, "the recorder's key and the target's key are the same string");
  assert.deepEqual(said(1), asked);
  assert.deepEqual(said(3), [], "the same words several turns later record nothing");
  assert.deepEqual(watchersIntents("Turn on the mail watcher.", { project: "harlow-legal", watchers: [{ ...card, shownTurnsAgo: 9 }] }).intents.map(i => i.to[0]), asked, "a named watcher works at any age");
});
