// @ts-check
// Clock's setup over a fake exec: the two shortcut files are well-formed property lists with the
// actions in order, signed with --mode anyone, opened one by one, and nothing runs when the gate
// says no dialog may be shown.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { makeEnv } from "./env.js";
import { fakeExec } from "./fake.js";
import { setupClock, timerShortcut, alarmShortcut, plist, ACTIONS, WHY } from "./setup.js";
import { tempHome } from "../../test/helpers.js";

/** A Shortcuts world: which shortcuts exist, and a signer that copies input to output. */
function world(/** @type {any} */ t, have = /** @type {string[]} */ ([])) {
  const home = tempHome(t);
  /** @type {Record<string, string>} */
  const signedFrom = {};
  const f = fakeExec((file, args) => {
    if (file === "shortcuts" && args[0] === "list") return { stdout: have.join("\n") };
    if (file === "shortcuts" && args[0] === "sign") {
      const src = args[args.indexOf("--input") + 1], dst = args[args.indexOf("--output") + 1];
      signedFrom[dst] = fs.readFileSync(src, "utf8");
      fs.writeFileSync(dst, "signed");
      return {};
    }
    return {};
  });
  return { home, dir: path.join(home, "apps", "shortcuts"), calls: f.calls, signedFrom, env: makeEnv({ config: { exec: f.exec, platform: "darwin", tmpdir: home } }) };
}

test("setup: the plist writer escapes text and writes every type", () => {
  const x = plist({ a: "x < y & z", n: 3, r: 1.5, b: true, list: ["￼"], empty: {}, none: [] });
  assert.match(x, /^<\?xml version="1.0" encoding="UTF-8"\?>/);
  assert.match(x, /<key>a<\/key>\n\t<string>x &lt; y &amp; z<\/string>/);
  assert.match(x, /<integer>3<\/integer>/);
  assert.match(x, /<real>1.5<\/real>/);
  assert.match(x, /<true\/>/);
  assert.match(x, /<dict\/>/);
  assert.match(x, /<array\/>/);
});

test("setup: Vyre Timer is text, then numbers, then Start Timer in seconds; Vyre Alarm reads time and label", () => {
  const t = timerShortcut();
  assert.deepEqual(t.WFWorkflowActions.map(a => a.WFWorkflowActionIdentifier), [ACTIONS.getText, ACTIONS.getNumbers, ACTIONS.startTimer]);
  assert.equal(t.WFWorkflowActions[0].WFWorkflowActionParameters.WFInput.Value.Type, "ExtensionInput");
  assert.equal(t.WFWorkflowActions[2].WFWorkflowActionParameters.WFDuration.Value.Unit, "sec");
  assert.ok(t.WFWorkflowInputContentItemClasses.includes("WFGenericFileContentItem"), "the input arrives as a file");
  const a = alarmShortcut();
  assert.deepEqual(a.WFWorkflowActions.map(x => x.WFWorkflowActionIdentifier), [ACTIONS.getText, ACTIONS.getDictionary, ACTIONS.getValue, ACTIONS.getValue, ACTIONS.createAlarm]);
  assert.deepEqual(a.WFWorkflowActions.slice(2, 4).map(x => x.WFWorkflowActionParameters.WFDictionaryKey), ["time", "label"]);
});

test("setup: writes, signs with --mode anyone and opens both, keeping only the signed files", async t => {
  const w = world(t);
  const r = await setupClock(w.env, w.dir);
  const timer = path.join(w.dir, "Vyre Timer.shortcut"), alarm = path.join(w.dir, "Vyre Alarm.shortcut");
  assert.deepEqual(r.files, [timer, alarm]);
  assert.equal(r.ready, false);
  assert.equal(r.steps[0], WHY);
  assert.ok(r.steps.some(s => s === "Shortcuts has opened Vyre Timer: click Add Shortcut."));
  assert.ok(r.steps.some(s => /make them by hand/.test(s)), "no manual fallback");
  const sign = w.calls.filter(c => c.args[0] === "sign");
  assert.deepEqual(sign[0].args, ["sign", "--mode", "anyone", "--input", path.join(w.dir, "Vyre Timer.unsigned.shortcut"), "--output", timer]);
  assert.match(w.signedFrom[timer], /<string>is.workflow.actions.detect.number<\/string>/);
  assert.deepEqual(w.calls.filter(c => c.file === "open").map(c => c.args), [[timer], [alarm]]);
  assert.deepEqual(fs.readdirSync(w.dir).sort(), ["Vyre Alarm.shortcut", "Vyre Timer.shortcut"]);
});

test("setup: only the missing shortcut is made; with both there, nothing is", async t => {
  const w = world(t, ["Vyre Timer"]);
  assert.deepEqual((await setupClock(w.env, w.dir)).files, [path.join(w.dir, "Vyre Alarm.shortcut")]);
  const done = world(t, ["Vyre Timer", "Vyre Alarm"]);
  const r = await setupClock(done.env, done.dir);
  assert.equal(r.ready, true);
  assert.deepEqual(done.calls.map(c => c.args[0]), ["list"]);
  assert.equal(fs.existsSync(done.dir), false);
});

test("setup: with the real exec and no dialogs allowed, it refuses before writing or spawning anything", async t => {
  const home = tempHome(t);
  /** @type {any[]} */
  const spawned = [];
  const env = makeEnv({ config: { platform: "darwin" }, execFile: (/** @type {any[]} */ ...a) => { spawned.push(a); return { stdin: { end() {} } }; }, vars: { NODE_TEST_CONTEXT: "1" } });
  const dir = path.join(home, "apps", "shortcuts");
  await assert.rejects(setupClock(env, dir), (/** @type {any} */ e) => e.code === "no_dialog");
  assert.equal(spawned.length, 0);
  assert.equal(fs.existsSync(dir), false);
});
