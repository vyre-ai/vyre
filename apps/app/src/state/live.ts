// Needs you and Chats, live (ADR 0027 section 7, the spike's Now): painted from this device's
// cache at once, then read from the box (gate.held, threads.asks, threads.list, projects.list) and
// kept current by the event stream (ask.*, gate.*, thread.*). The approve swipe's answers run
// here too: optimistic, held for Undo, then through the outbox (answers.ts).

import { AppState, Platform } from "react-native";
import { call, listen, send } from "../api/box";
import type { BoxEvent } from "../api/client";
import { tokens } from "../theme/tokens";
import { createAnswers } from "./answers";
import { viewCache } from "./cache";
import { onConnection } from "./connection";
import { answerCall, answerOutcome, applyNeedsEvent, hydrate, merge, type Decision, type Need, type NeedsContext } from "./needs-model";
import { needsStore, setNeeds } from "./needs";
import { threadsStore, toThreads, type ThreadRow } from "./threads";
import { MOCK } from "../real/box";
import { startUnlockAnswerer } from "../personal/answerer";

/** Who the box hears typing and answering from (team/archive/CONTRACT-native-apps.md 3.2: always the same explicit surface). */
export const SURFACE: string = Platform.OS === "web" ? "web" : Platform.OS;

const NEEDS_KEY = "needs";
const CHATS_KEY = "chats";
const NEEDS_EVENTS = /^(ask\.(raised|answered|cancelled)|gate\.(held|released|failed|revised|rejected))$/;
const THREAD_EVENTS = /^thread\.(started|finished|stopped|state)$|^lease\.changed$/;

let ctx: NeedsContext = {};
let started = false;

function contextFrom(threads: readonly ThreadRow[], projects: unknown): NeedsContext {
  const p: Record<string, string> = { ...(ctx.projects ?? {}) };
  const list = projects && typeof projects === "object" ? (projects as { projects?: unknown }).projects : null;
  if (Array.isArray(list)) for (const x of list) if (x && typeof x.slug === "string") p[x.slug] = typeof x.name === "string" && x.name ? x.name : x.slug;
  const t: NeedsContext["threads"] = {};
  for (const r of threads) t[r.id] = { agent: r.agent, name: r.name, project: r.project };
  return { projects: p, threads: t };
}

let reading: Promise<void> | null = null;
let again = false;

/** Read both lists from the box. One read at a time; a request during a read runs once after it. */
function read(): Promise<void> {
  if (reading) {
    again = true;
    return reading;
  }
  reading = (async () => {
    const [held, asks, threads, projects] = await Promise.all([
      call("gate.held"),
      call("threads.asks"),
      call("threads.list"),
      ctx.projects ? Promise.resolve({ data: null }) : call("projects.list"),
    ]);
    if (!threads.error) {
      ctx = contextFrom(toThreads(threads.data), projects.data);
      const rows = toThreads(threads.data).map((r) => ({ ...r, projectName: r.project ? (ctx.projects?.[r.project] ?? r.project) : null }));
      threadsStore.set({ items: rows, from: "box" });
      void viewCache.set(CHATS_KEY, rows);
    }
    // Keep what shows when a read fails: the cache or the last read stands until one works.
    if (held.error || asks.error) return;
    const list = merge(held.data, asks.data, ctx);
    setNeeds(list, "box");
    answers.prune(list.map((n) => n.id));
    void viewCache.set(NEEDS_KEY, list);
  })().finally(() => {
    reading = null;
    if (again) {
      again = false;
      void read();
    }
  });
  return reading;
}

let soon: ReturnType<typeof setTimeout> | null = null;
/** Read again shortly: events come in bursts (a Gate hold emits several). */
function readSoon(ms = 250) {
  if (soon) return;
  soon = setTimeout(() => {
    soon = null;
    void read();
  }, ms);
}

let saving: ReturnType<typeof setTimeout> | null = null;
function saveSoon() {
  if (saving) return;
  saving = setTimeout(() => {
    saving = null;
    void viewCache.set(NEEDS_KEY, needsStore.get().items);
  }, 500);
}

function onEvent(e: BoxEvent) {
  if (NEEDS_EVENTS.test(e.type)) {
    const before = needsStore.get().items;
    const r = applyNeedsEvent(before, e, ctx);
    if (r.list !== before) {
      setNeeds(r.list, needsStore.get().from === "cache" ? "cache" : "box");
      answers.prune(r.list.map((n) => n.id));
      saveSoon();
    }
    if (r.refetch) readSoon();
  } else if (THREAD_EVENTS.test(e.type)) readSoon(400);
}

// ---- answers ---------------------------------------------------------------------------------

/** Outbox keys of answers on their way, so a row held for a proof can come back with why. */
const keys = new Map<string, string>();

async function deliver(need: Need, d: Decision) {
  const { tool, input } = answerCall(need, d, SURFACE);
  const { key, answered } = await send(tool, input);
  keys.set(key, need.id);
  try {
    return answerOutcome(need, await answered);
  } finally {
    keys.delete(key);
  }
}

function publish() {
  const held = answers.latestHeld();
  needsStore.set({
    hidden: answers.hidden(),
    refused: answers.refused(),
    toast: held ? { id: held.id, label: `${held.decision === "approve" ? "Approved" : "Denied"} · ${held.need.title}`, until: held.until } : null,
  });
}

export const answers = createAnswers({
  undoMs: tokens.motion.undo,
  now: Date.now,
  setTimer: (f, ms) => setTimeout(f, ms),
  clearTimer: (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
  deliver,
  onChange: publish,
  // Taken: the item leaves the list now rather than when its event lands.
  onDone: (need) => {
    const items = needsStore.get().items.filter((n) => n.id !== need.id);
    setNeeds(items, needsStore.get().from === "cache" ? "cache" : "box");
    saveSoon();
  },
});

// ---- start -------------------------------------------------------------------------------------

/** Paint from the cache, read the box, follow its events. Once per app. */
export function startLive(): void {
  // The sample world (EXPO_PUBLIC_VYRE_MOCK=1) has no box to read from: its screens draw from the sample store, and a read here would only log 404s.
  if (MOCK) return;
  if (started) return;
  started = true;
  void viewCache.get(NEEDS_KEY).then((v) => {
    const list = hydrate(v);
    // The box may have answered first; its list wins.
    if (list && needsStore.get().from === "none") setNeeds(list, "cache");
  });
  void viewCache.get(CHATS_KEY).then((v) => {
    if (threadsStore.get().from === "none" && Array.isArray(v)) threadsStore.set({ items: toThreads(v), from: "cache" });
  });
  listen(onEvent, () => void read());
  void read();
  if (!MOCK) startUnlockAnswerer();

  // An answer the outbox holds for a proof would block the queue behind it: its row comes back
  // with the reason instead of sitting collapsed.
  onConnection((s) => {
    for (const row of s.outbox) {
      const id = keys.get(row.key);
      if (id && row.status === "needs_presence") answers.refuse(id, "Needs Face ID on this device");
    }
  });

  // Leaving: every answer still in its Undo window goes to the outbox, which survives the reload.
  const flush = () => void answers.flushAll();
  if (Platform.OS === "web" && typeof document !== "undefined") {
    document.addEventListener("visibilitychange", () => document.visibilityState === "hidden" && flush());
    addEventListener("pagehide", flush);
  } else {
    AppState.addEventListener("change", (s) => s !== "active" && flush());
  }
}

/** Read the lists now (pull to refresh, a reconnect). */
export const refresh = read;
