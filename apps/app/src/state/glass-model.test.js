// @ts-check
// The Glass mini-view as data (glass-model.js): targets and steps into one view per agent's
// computer, the light rule for stills, the shield pause, maxWidth, and how a run leaves.

import "../../../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  COPY,
  DONE_CARD_MS,
  FETCH_GAP_MS,
  STOPPED_MS,
  ageTick,
  announceWait,
  applyGlassEvent,
  applySteps,
  applyTargets,
  becameVisible,
  fetchDone,
  fetchPlan,
  fetchStarted,
  frameWidth,
  initialGlass,
  markMissing,
  nextPhaseIn,
  nowTargets,
  openLabel,
  phaseOf,
  pictureLook,
  prune,
  shouldFetch,
  stepAge,
  stepLine,
  stoppedLine,
  targetFor,
  toStep,
} from "./glass-model.js";

const T0 = 1_000_000;
const targets = (...extra) => ({
  targets: [
    { target: "mac", kind: "mac", label: "alex's Mac", live: true },
    { target: "agent:kit", kind: "agent", label: "kit", live: true },
    { target: "agent:juno", kind: "agent", label: "juno", live: true, holder: "alex" },
    ...extra,
  ],
});
const step = (o = {}) => ({ target: "agent:kit", agent: "kit", thread: "t1", call: "c1", action: "click", summary: "Clicked Compose in Mail", ok: true, at: T0, ...o });
const stepped = (o = {}, thread = "t1") => ({ type: "sight.stepped", thread, payload: step(o) });
const env = (o = {}) => ({ now: T0, visible: true, foreground: true, path: /** @type {"direct" | "relay"} */ ("direct"), frame: true, ...o });
const frame = { data: { target: "agent:kit", image: "/9j/AAA", mime: "image/jpeg", maxWidth: 800, at: T0, step: "c1" } };

/** A state with kit acting on one step. */
function acting() {
  let s = applyTargets(initialGlass(), targets(), T0);
  s = applyGlassEvent(s, stepped(), T0).state;
  return s;
}

test("glass: the Mac is never a target, agents are, and steps for the Mac are dropped", () => {
  const s = applyTargets(initialGlass(), targets(), T0);
  assert.deepEqual(Object.keys(s.targets).sort(), ["agent:juno", "agent:kit"]);
  assert.equal(s.available, true);
  assert.equal(s.targets["agent:juno"].holder, "alex");
  assert.equal(toStep({ target: "mac", summary: "Opened Finder", at: T0 }), null);
  const r = applyGlassEvent(s, { type: "sight.stepped", payload: { target: "mac", summary: "Opened Finder", ok: true, at: T0 } }, T0);
  assert.equal(r.state, s, "a Mac step changes nothing");
  assert.equal(r.target, null);
});

test("glass: a box without sight.targets shows nothing", () => {
  const s = markMissing(initialGlass());
  assert.equal(s.available, false);
  assert.deepEqual(nowTargets(s, T0), []);
  assert.equal(targetFor(s, "kit"), null);
  assert.deepEqual(nowTargets(initialGlass(), T0), [], "nothing before the box has answered");
});

test("glass: now lists one card per agent computer with a step, by name", () => {
  let s = acting();
  assert.deepEqual(nowTargets(s, T0).map((v) => v.agent), ["kit"], "juno has no step yet");
  s = applyGlassEvent(s, stepped({ target: "agent:juno", agent: "juno", thread: "t2", summary: "Opened the Northwind Bakery invoice" }, "t2"), T0).state;
  assert.deepEqual(nowTargets(s, T0).map((v) => v.agent), ["juno", "kit"]);
  assert.equal(targetFor(s, "juno")?.thread, "t2");
});

test("glass: one still when the card shows, then only on sight.stepped, at most one per 2 s", () => {
  let s = applyTargets(initialGlass(), targets(), T0);
  s = applySteps(s, "agent:kit", [step({ at: T0 - 5000 })]);
  assert.equal(fetchPlan(s.targets["agent:kit"], env()), null, "nothing asked before a card shows");
  s = becameVisible(s, "agent:kit");
  assert.deepEqual(fetchPlan(s.targets["agent:kit"], env()), { at: T0 }, "the first still, now");
  s = fetchStarted(s, "agent:kit", T0);
  assert.equal(fetchPlan(s.targets["agent:kit"], env()), null, "one on its way: no second");
  s = fetchDone(s, "agent:kit", frame);
  assert.equal(s.targets["agent:kit"].picture, "ok");
  assert.equal(s.frame, true);
  assert.equal(fetchPlan(s.targets["agent:kit"], env({ now: T0 + 60_000 })), null, "no timer: nothing without a step");

  // A step 500 ms later: wanted, but held to the 2 s gap by one timeout at T0 + 2000.
  s = applyGlassEvent(s, stepped({ at: T0 + 500, summary: "Typed the subject" }), T0 + 500).state;
  assert.deepEqual(fetchPlan(s.targets["agent:kit"], env({ now: T0 + 500 })), { at: T0 + FETCH_GAP_MS });
  // Three more steps before then still make one fetch.
  for (const at of [T0 + 900, T0 + 1200, T0 + 1900]) s = applyGlassEvent(s, stepped({ at }), at).state;
  assert.deepEqual(fetchPlan(s.targets["agent:kit"], env({ now: T0 + 1900 })), { at: T0 + FETCH_GAP_MS });
  assert.deepEqual(fetchPlan(s.targets["agent:kit"], env({ now: T0 + FETCH_GAP_MS })), { at: T0 + FETCH_GAP_MS });
  s = fetchStarted(s, "agent:kit", T0 + FETCH_GAP_MS);
  s = fetchDone(s, "agent:kit", frame);
  assert.equal(fetchPlan(s.targets["agent:kit"], env({ now: T0 + 3000 })), null, "the burst made one fetch");
  assert.equal(shouldFetch(T0 + 3999, T0 + 2000, true, true, "direct"), false);
  assert.equal(shouldFetch(T0 + 4000, T0 + 2000, true, true, "direct"), true);
});

test("glass: no still while hidden, in the background, over the relay, or without the frame tool", () => {
  const v = acting().targets["agent:kit"];
  assert.equal(v.want, true);
  assert.equal(fetchPlan(v, env({ visible: false })), null, "hidden");
  assert.equal(fetchPlan(v, env({ foreground: false })), null, "in the background");
  assert.equal(fetchPlan(v, env({ path: "relay" })), null, "over the relay");
  assert.equal(fetchPlan(v, env({ frame: false })), null, "no sight.frame on this box");
  assert.equal(shouldFetch(T0, null, false, true, "direct"), false);
  assert.equal(shouldFetch(T0, null, true, false, "direct"), false);
  assert.equal(shouldFetch(T0, null, true, true, "relay"), false);
  assert.equal(shouldFetch(T0, null, true, true, "direct"), true);
  assert.deepEqual(pictureLook(v, { path: "relay", frame: true }), { badge: false, dim: true, note: COPY.paused });
  assert.equal(stepLine(v, T0).text, "Clicked Compose in Mail", "the steps stay live over the relay");
});

test("glass: frame refused with failed pauses for the sign-in, a step resumes it", () => {
  let s = acting();
  s = fetchStarted(s, "agent:kit", T0);
  s = fetchDone(s, "agent:kit", frame);
  s = applyGlassEvent(s, stepped({ at: T0 + 3000 }), T0 + 3000).state;
  s = fetchStarted(s, "agent:kit", T0 + 3000);
  s = fetchDone(s, "agent:kit", { error: { code: "failed" } });
  let v = s.targets["agent:kit"];
  assert.equal(v.picture, "shielded");
  assert.ok(v.still, "the last still stays");
  assert.deepEqual(pictureLook(v, { path: "direct", frame: true }), { badge: false, dim: true, note: COPY.shielded });
  s = becameVisible(s, "agent:kit");
  assert.equal(fetchPlan(s.targets["agent:kit"], env({ now: T0 + 60_000 })), null, "not asked again while a person signs in");
  s = applyGlassEvent(s, stepped({ at: T0 + 9000 }), T0 + 9000).state;
  v = s.targets["agent:kit"];
  assert.notEqual(v.picture, "shielded");
  assert.deepEqual(fetchPlan(v, env({ now: T0 + 9000 })), { at: T0 + 9000 }, "the next step asks again");
});

test("glass: computer.unshielded resumes a paused picture", () => {
  let s = acting();
  s = fetchStarted(s, "agent:kit", T0);
  s = fetchDone(s, "agent:kit", { error: { code: "failed" } });
  assert.equal(s.targets["agent:kit"].picture, "shielded");
  assert.equal(s.targets["agent:kit"].still, null);
  const r = applyGlassEvent(s, { type: "computer.unshielded", payload: { agent: "kit" } }, T0 + 5000);
  assert.equal(r.target, "agent:kit");
  assert.equal(r.state.targets["agent:kit"].picture, "none");
  assert.deepEqual(fetchPlan(r.state.targets["agent:kit"], env({ now: T0 + 5000 })), { at: T0 + 5000 });
  const other = applyGlassEvent(r.state, { type: "computer.unshielded", payload: { agent: "juno" } }, T0 + 5000);
  assert.equal(other.state, r.state, "another computer's shield changes nothing here");
});

test("glass: any other failure keeps the last still, dimmed; no_such_tool switches pictures off", () => {
  let s = acting();
  s = fetchDone(fetchStarted(s, "agent:kit", T0), "agent:kit", frame);
  s = fetchDone(fetchStarted(s, "agent:kit", T0 + 2000), "agent:kit", { error: { code: "timeout" } });
  const v = s.targets["agent:kit"];
  assert.equal(v.picture, "stale");
  assert.equal(v.still?.image, "/9j/AAA");
  assert.deepEqual(pictureLook(v, { path: "direct", frame: true }), { badge: false, dim: true, note: null });
  s = fetchDone(fetchStarted(s, "agent:kit", T0 + 4000), "agent:kit", { error: { code: "no_such_tool" } });
  assert.equal(s.frame, false);
  assert.equal(pictureLook(s.targets["agent:kit"], { path: "direct", frame: s.frame }).note, COPY.paused);
});

test("glass: maxWidth is device pixels rounded to 80, held to 160..1280", () => {
  assert.equal(frameWidth(343, 3), 1040, "343 x 3 = 1029, nearest 80 is 1040");
  assert.equal(frameWidth(345, 3), 1040, "a small resize asks for the same size");
  assert.equal(frameWidth(358, 2), 720);
  assert.equal(frameWidth(40, 1), 160, "held to 160");
  assert.equal(frameWidth(1000, 3), 1280, "held to 1280");
  assert.equal(frameWidth(0, 2), 160);
  assert.equal(frameWidth(Number.NaN, Number.NaN), 160);
  for (const w of [200, 311, 390, 428]) assert.equal(frameWidth(w, 2.75) % 80, 0);
});

test("glass: a finished run keeps its card 30 s, then the pill, then leaves with the run", () => {
  let s = acting();
  const r = applyGlassEvent(s, { type: "thread.finished", thread: "t1", payload: {} }, T0 + 1000);
  assert.equal(r.reread, true);
  s = r.state;
  let v = s.targets["agent:kit"];
  assert.equal(v.run, "done");
  assert.equal(phaseOf(v, T0 + 1000), "card");
  assert.equal(stepLine(v, T0 + 1000).mark, "ok");
  assert.equal(pictureLook({ ...v, picture: "ok" }, { path: "direct", frame: true }).badge, false, "no Live badge once it ended");
  assert.equal(nextPhaseIn(v, T0 + 1000), DONE_CARD_MS, "one timeout to the pill");
  assert.equal(phaseOf(v, T0 + 1000 + DONE_CARD_MS - 1), "card");
  assert.equal(phaseOf(v, T0 + 1000 + DONE_CARD_MS), "pill");
  assert.equal(nextPhaseIn(v, T0 + 1000 + DONE_CARD_MS), null);
  assert.deepEqual(nowTargets(s, T0 + 1000 + DONE_CARD_MS).map((x) => x.agent), ["kit"], "the pill stays while the run is there");
  // The run leaves the box's list: the pill goes with it.
  s = applyTargets(s, { targets: [{ target: "agent:juno", kind: "agent", label: "juno", live: true }] }, T0 + 40_000);
  assert.equal(s.targets["agent:kit"], undefined);
  // A new step after the end starts the next run with its own count.
  s = applyTargets(s, targets(), T0 + 50_000);
  s = applyGlassEvent(s, stepped({ at: T0 + 50_000 }), T0 + 50_000).state;
  v = s.targets["agent:kit"];
  assert.equal(v.run, "acting");
  assert.equal(v.count, 1);
});

test("glass: a target that stops being live ends its run as done", () => {
  let s = acting();
  s = applyTargets(s, { targets: [{ target: "agent:kit", kind: "agent", label: "kit", live: false }] }, T0 + 500);
  assert.equal(s.targets["agent:kit"].run, "done");
  assert.equal(s.targets["agent:kit"].endedAt, T0 + 500);
});

test("glass: stopped says how far it got, then leaves after 4 s", () => {
  let s = acting();
  s = applyGlassEvent(s, stepped({ at: T0 + 100, summary: "Typed the subject" }), T0 + 100).state;
  s = applyGlassEvent(s, stepped({ at: T0 + 200, summary: "Attached the Harlow Legal brief" }), T0 + 200).state;
  s = applyGlassEvent(s, { type: "thread.stopped", thread: "t1", payload: {} }, T0 + 1000).state;
  const v = s.targets["agent:kit"];
  assert.equal(phaseOf(v, T0 + 1000), "stopped");
  assert.deepEqual(stepLine(v, T0 + 1000), { mark: "stopped", text: "Stopped. 3 steps done.", trail: null, why: null });
  assert.equal(nextPhaseIn(v, T0 + 1000), STOPPED_MS);
  assert.equal(phaseOf(v, T0 + 1000 + STOPPED_MS), "gone");
  assert.deepEqual(nowTargets(s, T0 + 1000 + STOPPED_MS), []);
  assert.equal(prune(s, T0 + 1000 + STOPPED_MS).targets["agent:kit"], undefined);
  assert.equal(prune(s, T0 + 1000).targets["agent:kit"]?.run, "stopped", "kept inside its 4 s");
  assert.equal(stoppedLine(1), "Stopped. 1 step done.");
});

test("glass: a thread's end finds its computer by the agent when the step named no thread", () => {
  let s = applyTargets(initialGlass(), targets(), T0);
  s = applyGlassEvent(s, { type: "sight.stepped", payload: step({ thread: undefined }) }, T0).state;
  assert.equal(s.targets["agent:kit"].thread, null);
  s = applyGlassEvent(s, { type: "thread.stopped", thread: "t9", payload: {} }, T0 + 10, { agentOfThread: (t) => (t === "t9" ? "kit" : null) }).state;
  assert.equal(s.targets["agent:kit"].run, "stopped");
});

test("glass: the step line: running, failed with why, waiting for you, the holder", () => {
  let s = acting();
  s = applyGlassEvent(s, stepped({ at: T0 + 10, ok: undefined, summary: "Opening Mail" }), T0 + 10).state;
  assert.equal(stepLine(s.targets["agent:kit"], T0 + 10).mark, "running");
  s = applyGlassEvent(s, stepped({ at: T0 + 20, ok: false, summary: "Clicked Send", why: "The Send button was greyed out" }), T0 + 20).state;
  const f = stepLine(s.targets["agent:kit"], T0 + 4020);
  assert.deepEqual(f, { mark: "failed", text: "Clicked Send", trail: "4 s", why: "The Send button was greyed out" });
  const w = stepLine(s.targets["agent:kit"], T0 + 20, "Send to dana@harlowlegal.com");
  assert.equal(w.mark, "waiting");
  assert.equal(w.text, "Waiting for you: Send to dana@harlowlegal.com");
  s = applyGlassEvent(s, stepped({ target: "agent:juno", agent: "juno", thread: "t2", summary: "Scrolled the order list" }, "t2"), T0).state;
  assert.equal(stepLine(s.targets["agent:juno"], T0 + 9000).trail, "alex has the keyboard", "the holder in place of the age");
  assert.equal(openLabel("kit"), "Open Glass for kit's computer");
});

test("glass: ages read now, seconds, minutes, hours and tick at most once a second", () => {
  assert.equal(stepAge(0), "now");
  assert.equal(stepAge(-3000), "now", "a clock behind reads now");
  assert.equal(stepAge(4200), "4 s");
  assert.equal(stepAge(125_000), "2 min");
  assert.equal(stepAge(3_700_000), "1 h");
  assert.equal(ageTick(0), 2000);
  assert.equal(ageTick(4200), 800);
  assert.ok(ageTick(4200) <= 1000);
  assert.equal(ageTick(125_000), 55_000, "on the minute after a minute");
});

test("glass: the live region speaks at most once every 5 s", () => {
  assert.equal(announceWait(T0, null), 0);
  assert.equal(announceWait(T0 + 1000, T0), 4000);
  assert.equal(announceWait(T0 + 5000, T0), 0);
  assert.equal(announceWait(T0 + 9000, T0), 0);
});

test("glass: sight.steps paints the latest step and the run's count; an older answer does not win", () => {
  let s = applyTargets(initialGlass(), targets(), T0);
  s = applySteps(s, "agent:kit", { steps: [step({ at: T0, summary: "Clicked Send" }), step({ at: T0 - 100 }), step({ at: T0 - 200, thread: "t0" })] });
  assert.equal(s.targets["agent:kit"].step?.summary, "Clicked Send");
  assert.equal(s.targets["agent:kit"].count, 2, "the latest thread's steps");
  s = applyGlassEvent(s, stepped({ at: T0 + 100, summary: "Opened Sent" }), T0 + 100).state;
  s = applySteps(s, "agent:kit", [step({ at: T0 })]);
  assert.equal(s.targets["agent:kit"].step?.summary, "Opened Sent");
  const again = applyGlassEvent(s, stepped({ at: T0 - 50, summary: "Late" }), T0 + 200).state;
  assert.equal(again.targets["agent:kit"].step?.summary, "Opened Sent", "an older event does not replace the line");
});
