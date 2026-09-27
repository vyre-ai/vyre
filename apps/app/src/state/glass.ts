// The Glass mini-view, live (docs/design/system/components/glass-mini.md, the App parts): cohesion's
// sight module (ADR 0036) read from the box and kept current by its events, folded by
// glass-model.js. sight.targets is read at start, on a reset and when a thread or a lease changes;
// sight.stepped moves the step line at once. A box without sight.targets (no_such_tool, chat core's
// caps) switches the whole feature off and nothing is drawn.
//
// Stills (sight.frame) follow the light rule, with no interval timer: one when a card comes on
// screen, then one more only on a sight.stepped for that target, at most one per 2 s per target
// (a single timeout carries a step that came inside the gap), only while a card for it is on
// screen and the app is in front, and never over the relay. Cards say where they are and how
// wide through watchGlass(); the widest visible one sets maxWidth.

import { useMemo } from "react";
import { AppState, type AppStateStatus } from "react-native";
import { create } from "zustand";
import { CAPS } from "@vyre/chat-core/caps.js";
import { call, listen } from "../api/box";
import type { BoxEvent } from "../api/client";
import { connection, onConnection } from "./connection";
import {
  applyGlassEvent,
  applySteps,
  applyTargets,
  becameVisible,
  fetchDone,
  fetchPlan,
  fetchStarted,
  initialGlass,
  markMissing,
  nowTargets,
  prune,
  targetFor,
  type GlassState,
  type TargetView,
} from "./glass-model.js";
import { threadsStore } from "./threads";

export type { TargetView } from "./glass-model.js";

const TARGETS = "sight.targets";
const STEPS = "sight.steps";
const FRAME = "sight.frame";
const EVENTS = /^sight\.stepped$|^computer\.(shielded|unshielded)$|^thread\.(started|finished|stopped|state)$|^lease\.changed$/;

const useGlassStore = create<GlassState>()(() => initialGlass());
const get = useGlassStore.getState;
const put = (s: GlassState) => {
  if (s !== get()) useGlassStore.setState(s, true);
};

// ---- reads ---------------------------------------------------------------------------------------

const offline = (e: Error) => ({ error: { code: "offline", message: e.message } }) as const;

let reading: Promise<void> | null = null;
let again = false;
/** Steps asked once per target, so a card has a line before its first event. */
const asked = new Set<string>();

function readTargets(): Promise<void> {
  if (reading) {
    again = true;
    return reading;
  }
  reading = (async () => {
    const r = await CAPS.use(TARGETS, () => call(TARGETS, {}).catch(offline));
    if (r.error) {
      if (r.missing) put(markMissing(get()));
      return;
    }
    put(prune(applyTargets(get(), r.data, Date.now()), Date.now()));
    for (const v of Object.values(get().targets)) {
      if (!v.live || v.step || asked.has(v.target)) continue;
      asked.add(v.target);
      void call(STEPS, { target: v.target }).then((s) => {
        if (!s.error) put(applySteps(get(), v.target, s.data));
      }, () => {});
    }
  })().finally(() => {
    reading = null;
    if (again) {
      again = false;
      void readTargets();
    }
  });
  return reading;
}

let soon: ReturnType<typeof setTimeout> | null = null;
function readSoon(ms = 400) {
  if (soon) return;
  soon = setTimeout(() => {
    soon = null;
    void readTargets();
  }, ms);
}

const agentOfThread = (id: string) => threadsStore.get().items.find((t) => t.id === id)?.agent ?? null;

function onEvent(e: BoxEvent) {
  if (!EVENTS.test(e.type) || get().available === false) return;
  const r = applyGlassEvent(get(), e, Date.now(), { agentOfThread });
  put(r.state);
  if (r.target) pump(r.target);
  if (r.reread) readSoon();
}

// ---- stills --------------------------------------------------------------------------------------

type Watch = { visible: boolean; width: number };
/** Every card on screen, by target: whether it is visible and the maxWidth it would ask for. */
const watchers = new Map<string, Map<number, Watch>>();
/** One pending timeout per target (the throttle's trailing fetch). */
const timers = new Map<string, ReturnType<typeof setTimeout>>();
let foreground = AppState.currentState !== "background";

function seen(target: string): { visible: boolean; width: number } {
  let visible = false;
  let width = 0;
  for (const w of watchers.get(target)?.values() ?? []) {
    if (!w.visible) continue;
    visible = true;
    width = Math.max(width, w.width);
  }
  return { visible, width };
}

/** Decide for one target: ask now, once later (one timeout), or not at all. */
function pump(target: string) {
  const t = timers.get(target);
  if (t) clearTimeout(t);
  timers.delete(target);
  const v = get().targets[target];
  if (!v) return;
  const { visible, width } = seen(target);
  const now = Date.now();
  const plan = fetchPlan(v, { now, visible, foreground, path: connection.get().path, frame: get().frame });
  if (!plan) return;
  if (plan.at > now) {
    timers.set(target, setTimeout(() => {
      timers.delete(target);
      pump(target);
    }, plan.at - now));
    return;
  }
  put(fetchStarted(get(), target, now));
  void call(FRAME, { target, maxWidth: width })
    .catch(offline)
    .then((r) => {
      put(fetchDone(get(), target, r as { data?: unknown; error?: { code: string } }));
      // A step that came while this one was on its way wants another (after the gap).
      pump(target);
    });
}

/** Back in front, or off the relay: a card on screen is as good as newly shown (one still). */
const pumpAll = () => {
  for (const target of Object.keys(get().targets)) {
    if (seen(target).visible) put(becameVisible(get(), target));
    pump(target);
  }
};

let nextId = 1;

/**
 * A card says it is drawn for `target`, whether it is on screen and the maxWidth it would ask for.
 * Returns the update and the goodbye.
 */
export function watchGlass(target: string): { set(w: Watch): void; stop(): void } {
  const id = nextId++;
  let map = watchers.get(target);
  if (!map) watchers.set(target, (map = new Map()));
  const mine = map;
  return {
    set(w) {
      const before = seen(target).visible;
      mine.set(id, w);
      if (!before && w.visible) put(becameVisible(get(), target));
      pump(target);
    },
    stop() {
      mine.delete(id);
      if (!mine.size) watchers.delete(target);
      pump(target);
    },
  };
}

// ---- start ---------------------------------------------------------------------------------------

let started = false;

/** Read the box's computers and follow their steps. Once per app. */
export function startGlass(): void {
  if (started) return;
  started = true;
  listen(onEvent, () => void readTargets());
  void readTargets();
  AppState.addEventListener("change", (s: AppStateStatus) => {
    const front = s === "active";
    if (front === foreground) return;
    foreground = front;
    if (front) pumpAll();
    else for (const [k, t] of timers) {
      clearTimeout(t);
      timers.delete(k);
    }
  });
  let path = connection.get().path;
  onConnection((s) => {
    if (s.path === path) return;
    path = s.path;
    pumpAll();
  });
}

// ---- hooks ---------------------------------------------------------------------------------------

/** Whether sight is on this box: null until it answers, false when the tool is not there. */
export const useGlassAvailable = () => useGlassStore((s) => s.available);
/** Whether sight.frame is there (null until the first still). */
export const useGlassFrame = () => useGlassStore((s) => s.frame);
export const useGlassTarget = (target: string) => useGlassStore((s) => s.targets[target] ?? null);
/** The thread's agent's computer, when it has a step. */
export const useGlassFor = (agent: string | null | undefined) => useGlassStore((s) => targetFor(s, agent));

/** Now's cards: the targets with a step, by agent. Each card leaves by its own phase (GlassMini). */
export function useGlassCards(): TargetView[] {
  const targets = useGlassStore((s) => s.targets);
  const available = useGlassStore((s) => s.available);
  return useMemo(() => nowTargets({ available, frame: null, targets }, Date.now()), [targets, available]);
}
