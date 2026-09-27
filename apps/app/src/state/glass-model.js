// @ts-check
// The Glass mini-view as data (docs/design/system/components/glass-mini.md, the App parts): what
// cohesion's sight module says (sight.targets, sight.steps, the sight.stepped event, sight.frame
// stills) folded into one view per agent's computer, when to ask for a still, and the words.
// Pure, no React and no timers, so node tests import it. The phone never shows the Mac: only
// "agent:<name>" targets are kept.
//
// The light rule for pictures (the team's, over the spec's "every 2 s"): one still when a card
// becomes visible, then one more only on a sight.stepped for that target, at most one per 2 s per
// target, only while a card is on screen and the app is in front, and never over the relay.

/** At most one still per target in this long. */
export const FETCH_GAP_MS = 2000;
/** A finished run keeps its card this long, then collapses to the pill. */
export const DONE_CARD_MS = 30_000;
/** A stopped run says so this long, then leaves. */
export const STOPPED_MS = 4000;
/** The step line's live region speaks at most this often. */
export const ANNOUNCE_GAP_MS = 5000;
/** sight.frame's bounds for maxWidth, and its step. */
export const MIN_WIDTH = 160;
export const MAX_WIDTH = 1280;
export const WIDTH_STEP = 80;

export const COPY = Object.freeze({
  live: "Live",
  paused: "Picture paused · steps still live",
  shielded: "Paused while a person signs in",
  hide: "Hide screen",
  show: "Show screen",
});

/** @param {string} agent */
export const openLabel = (agent) => `Open Glass for ${agent}'s computer`;
/** @param {string} holder */
export const holderLine = (holder) => `${holder} has the keyboard`;
/** @param {string} what */
export const waitingLine = (what) => `Waiting for you: ${what}`;
/** @param {number} n */
export const stoppedLine = (n) => `Stopped. ${n} ${n === 1 ? "step" : "steps"} done.`;

/**
 * @typedef {{ target: string, agent: string | null, thread: string | null, call: string | null,
 *   action: string, summary: string, ok: boolean | null, why: string | null, app: string | null, at: number }} Step
 * @typedef {{ image: string, at: number, maxWidth: number }} Still
 * @typedef {"acting" | "done" | "stopped"} Run
 * @typedef {"none" | "ok" | "stale" | "shielded"} Picture
 * @typedef {{
 *   target: string, agent: string, label: string, live: boolean, holder: string | null,
 *   step: Step | null, count: number, thread: string | null,
 *   run: Run, endedAt: number | null,
 *   still: Still | null, picture: Picture,
 *   lastFetchAt: number | null, want: boolean, inFlight: boolean,
 * }} TargetView
 * @typedef {{ available: boolean | null, frame: boolean | null, targets: Readonly<Record<string, TargetView>> }} GlassState
 * @typedef {{ type: string, thread?: string | null, payload?: Record<string, unknown> | null }} GlassEvent
 * @typedef {"direct" | "relay"} Path
 */

/** @returns {GlassState} */
export const initialGlass = () => ({ available: null, frame: null, targets: {} });

const str = (/** @type {unknown} */ v) => (typeof v === "string" && v ? v : null);

/**
 * "agent:kit" is kit; anything else (the Mac) is nobody the phone shows.
 * @param {unknown} target
 * @returns {string | null}
 */
export function agentOf(target) {
  const t = str(target);
  const m = t ? /^agent:(.+)$/.exec(t) : null;
  return m ? m[1] : null;
}

/**
 * sight.targets' answer: the agents' computers only.
 * @param {unknown} data
 * @returns {{ target: string, agent: string, label: string, live: boolean, holder: string | null }[]}
 */
export function toTargets(data) {
  const list = data && typeof data === "object" ? /** @type {{ targets?: unknown }} */ (data).targets : null;
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const t of list) {
    if (!t || typeof t !== "object") continue;
    const agent = agentOf(t.target);
    if (!agent || (t.kind !== undefined && t.kind !== "agent")) continue;
    out.push({ target: String(t.target), agent, label: str(t.label) ?? agent, live: t.live === true, holder: str(t.holder) });
  }
  return out;
}

/**
 * One step as the box sends it; null when it is not one or is the Mac's.
 * @param {unknown} v
 * @param {string | null} [thread] the event's thread, when the step does not name one
 * @returns {Step | null}
 */
export function toStep(v, thread = null) {
  if (!v || typeof v !== "object") return null;
  const o = /** @type {Record<string, unknown>} */ (v);
  const target = str(o.target);
  const agent = agentOf(target) ?? null;
  if (!target || !agent) return null;
  const summary = str(o.summary);
  if (!summary) return null;
  return {
    target,
    agent: str(o.agent) ?? agent,
    thread: str(o.thread) ?? thread,
    call: str(o.call),
    action: str(o.action) ?? "",
    summary,
    ok: typeof o.ok === "boolean" ? o.ok : null,
    why: str(o.why),
    app: str(o.app),
    at: typeof o.at === "number" && Number.isFinite(o.at) ? o.at : 0,
  };
}

/**
 * @param {string} target
 * @param {string} agent
 * @returns {TargetView}
 */
function blank(target, agent) {
  return {
    target, agent, label: agent, live: false, holder: null,
    step: null, count: 0, thread: null,
    run: "acting", endedAt: null,
    still: null, picture: "none",
    lastFetchAt: null, want: false, inFlight: false,
  };
}

/**
 * @param {GlassState} s
 * @param {string} target
 * @param {(v: TargetView) => TargetView | null} f null removes it
 * @returns {GlassState}
 */
function edit(s, target, f) {
  const v = s.targets[target];
  if (!v) return s;
  const next = f(v);
  if (next === v) return s;
  const targets = { ...s.targets };
  if (next) targets[target] = next;
  else delete targets[target];
  return { ...s, targets };
}

/**
 * The run ended: a finished one keeps its card, a stopped one says so and leaves.
 * @param {TargetView} v
 * @param {"done" | "stopped"} how
 * @param {number} now
 * @returns {TargetView}
 */
function end(v, how, now) {
  if (v.run !== "acting" || !v.step) return v;
  return { ...v, run: how, endedAt: now, want: false };
}

/**
 * The tool is not on this box (sight.targets said no_such_tool): the whole feature is off.
 * @param {GlassState} s
 * @returns {GlassState}
 */
export const markMissing = (s) => ({ ...initialGlass(), available: false });

/**
 * sight.targets' answer. New computers join, known ones take the new label, liveness and holder.
 * A computer no longer live ends its run; one that left the list takes its finished run with it.
 * @param {GlassState} s
 * @param {unknown} data
 * @param {number} now
 * @returns {GlassState}
 */
export function applyTargets(s, data, now) {
  const list = toTargets(data);
  /** @type {Record<string, TargetView>} */
  const targets = {};
  const seen = new Set();
  for (const t of list) {
    seen.add(t.target);
    const was = s.targets[t.target] ?? blank(t.target, t.agent);
    let v = { ...was, label: t.label, live: t.live, holder: t.holder };
    if (!t.live) v = end(v, "done", now);
    targets[t.target] = v;
  }
  for (const [k, v] of Object.entries(s.targets)) {
    if (seen.has(k)) continue;
    // Gone from the box: an acting run has ended; a finished or stopped one leaves with it.
    if (v.run === "acting" && v.step) targets[k] = { ...end(v, "done", now), live: false };
    else if (v.run === "stopped" && v.endedAt !== null && now - v.endedAt < STOPPED_MS) targets[k] = v;
  }
  return { ...s, available: true, targets };
}

/**
 * sight.steps' answer for one target (newest first): the latest step, when it is newer than the
 * one shown, and how many this run has taken (the steps of the latest step's thread).
 * @param {GlassState} s
 * @param {string} target
 * @param {unknown} data
 * @returns {GlassState}
 */
export function applySteps(s, target, data) {
  const raw = Array.isArray(data) ? data : data && typeof data === "object" ? /** @type {{ steps?: unknown }} */ (data).steps : null;
  if (!Array.isArray(raw)) return s;
  const steps = raw.map((x) => toStep(x)).filter((x) => x !== null && x.target === target);
  if (!steps.length) return s;
  const latest = /** @type {Step} */ (steps[0]);
  return edit(s, target, (v) => {
    if (v.step && v.step.at >= latest.at) return v;
    const count = steps.filter((x) => x && x.thread === latest.thread).length;
    return { ...v, step: latest, thread: latest.thread ?? v.thread, count: Math.max(v.count, count) };
  });
}

/**
 * A sight.stepped: the line changes now and a still is wanted. A step after a run ended starts
 * the next run; a step while a person signed in ends that pause.
 * @param {GlassState} s
 * @param {Step} step
 * @returns {GlassState}
 */
export function applyStep(s, step) {
  const agent = /** @type {string} */ (agentOf(step.target));
  const known = s.targets[step.target] ?? { ...blank(step.target, agent), live: true };
  const fresh = known.run !== "acting";
  if (!fresh && known.step && step.at < known.step.at) return s;
  const v = {
    ...known,
    live: true,
    run: /** @type {Run} */ ("acting"),
    endedAt: null,
    step,
    thread: step.thread ?? known.thread,
    count: (fresh ? 0 : known.count) + 1,
    want: true,
    picture: known.picture === "shielded" ? /** @type {Picture} */ (known.still ? "stale" : "none") : known.picture,
  };
  return { ...s, targets: { ...s.targets, [step.target]: v } };
}

/**
 * Events from the box: sight.stepped, computer.shielded and .unshielded, and the thread's end.
 * `reread` says to read sight.targets again (a thread or a lease changed).
 * @param {GlassState} s
 * @param {GlassEvent} e
 * @param {number} now
 * @param {{ agentOfThread?: (thread: string) => string | null }} [ctx]
 * @returns {{ state: GlassState, target: string | null, reread: boolean }}
 */
export function applyGlassEvent(s, e, now, ctx = {}) {
  const p = e.payload ?? {};
  if (e.type === "sight.stepped") {
    const step = toStep(p, e.thread ?? null);
    if (!step) return { state: s, target: null, reread: false };
    return { state: applyStep(s, step), target: step.target, reread: !s.targets[step.target] };
  }
  if (e.type === "computer.unshielded" || e.type === "computer.shielded") {
    const agent = str(p.agent);
    const target = agent ? `agent:${agent}` : null;
    if (!target) return { state: s, target: null, reread: false };
    const on = e.type === "computer.shielded";
    const state = edit(s, target, (v) => {
      if (on) return v.picture === "shielded" ? v : { ...v, picture: "shielded", want: false };
      if (v.picture !== "shielded") return v;
      return { ...v, picture: v.still ? "stale" : "none", want: true };
    });
    return { state, target, reread: false };
  }
  if (e.type === "thread.finished" || e.type === "thread.stopped") {
    const thread = e.thread ?? str(p.thread) ?? str(p.id);
    const how = e.type === "thread.stopped" ? "stopped" : "done";
    const byAgent = thread && ctx.agentOfThread ? ctx.agentOfThread(thread) : null;
    let state = s;
    let hit = null;
    for (const v of Object.values(s.targets)) {
      if ((thread && v.thread === thread) || (!v.thread && byAgent && v.agent === byAgent)) {
        state = edit(state, v.target, (x) => end(x, how, now));
        hit = v.target;
      }
    }
    return { state, target: hit, reread: true };
  }
  if (/^thread\.(started|state)$|^lease\.changed$/.test(e.type)) return { state: s, target: null, reread: true };
  return { state: s, target: null, reread: false };
}

// ---- pictures -----------------------------------------------------------------------------------

/**
 * The light rule's gate, before the throttle: a card on screen, the app in front, not the relay.
 * @param {number} now
 * @param {number | null} lastFetchAt
 * @param {boolean} visible
 * @param {boolean} foreground
 * @param {Path} path
 * @returns {boolean}
 */
export function shouldFetch(now, lastFetchAt, visible, foreground, path) {
  if (!visible || !foreground || path === "relay") return false;
  return lastFetchAt === null || now - lastFetchAt >= FETCH_GAP_MS;
}

/**
 * Whether to ask for a still: "now", at a later time (the throttle's single timeout), or not.
 * A still is wanted when the card first shows or a step came; never while a person signs in on
 * that computer, never while one is on its way, never without the frame tool.
 * @param {TargetView} v
 * @param {{ now: number, visible: boolean, foreground: boolean, path: Path, frame: boolean | null }} env
 * @returns {{ at: number } | null} at <= now means now
 */
export function fetchPlan(v, env) {
  if (!env.visible || !env.foreground || env.path === "relay" || env.frame === false) return null;
  if (v.inFlight || v.picture === "shielded" || !v.want) return null;
  if (shouldFetch(env.now, v.lastFetchAt, env.visible, env.foreground, env.path)) return { at: env.now };
  return { at: /** @type {number} */ (v.lastFetchAt) + FETCH_GAP_MS };
}

/**
 * A card came on screen: one still is wanted (the throttle still holds).
 * @param {GlassState} s
 * @param {string} target
 * @returns {GlassState}
 */
export const becameVisible = (s, target) => edit(s, target, (v) => (v.want || v.picture === "shielded" ? v : { ...v, want: true }));

/**
 * @param {GlassState} s
 * @param {string} target
 * @param {number} now
 * @returns {GlassState}
 */
export const fetchStarted = (s, target, now) => edit(s, target, (v) => ({ ...v, inFlight: true, lastFetchAt: now, want: false }));

/**
 * sight.frame's answer. "failed" is a person signing in on that computer: paused until the next
 * step or computer.unshielded. Any other failure keeps the last still, dimmed. no_such_tool
 * switches pictures off on this box.
 * @param {GlassState} s
 * @param {string} target
 * @param {{ data?: any, error?: { code: string } }} r
 * @returns {GlassState}
 */
export function fetchDone(s, target, r) {
  if (r.error && isMissingCode(r.error.code)) return { ...edit(s, target, (v) => ({ ...v, inFlight: false })), frame: false };
  const next = edit(s, target, (v) => {
    const done = { ...v, inFlight: false };
    if (r.error) {
      if (r.error.code === "failed") return { ...done, picture: "shielded", want: false };
      return { ...done, picture: v.still ? "stale" : "none" };
    }
    const d = r.data ?? {};
    if (typeof d.image !== "string" || !d.image) return { ...done, picture: v.still ? "stale" : "none" };
    // A step that raced the answer asked for another; a shield that raced it wins.
    if (v.picture === "shielded") return done;
    return { ...done, still: { image: d.image, at: typeof d.at === "number" ? d.at : 0, maxWidth: Number(d.maxWidth) || 0 }, picture: "ok" };
  });
  return next.frame === null && !r.error ? { ...next, frame: true } : next;
}

/** @param {string} code */
const isMissingCode = (code) => code === "no_such_tool" || code === "unknown_tool" || code === "http_404";

/**
 * maxWidth for sight.frame: the card's width in device pixels, rounded to a multiple of 80 (a
 * small resize asks for the same size) and held to 160..1280.
 * @param {number} width the card's width in points
 * @param {number} ratio the device pixel ratio
 * @returns {number}
 */
export function frameWidth(width, ratio) {
  const px = (Number.isFinite(width) ? width : 0) * (Number.isFinite(ratio) && ratio > 0 ? ratio : 1);
  const r = Math.round(px / WIDTH_STEP) * WIDTH_STEP;
  return Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, r));
}

// ---- what shows ---------------------------------------------------------------------------------

/**
 * Which variant a target shows at `now`: the card, the pill (a finished run after 30 s), the
 * stopped card, or nothing.
 * @param {TargetView} v
 * @param {number} now
 * @returns {"card" | "pill" | "stopped" | "gone"}
 */
export function phaseOf(v, now) {
  if (!v.step) return "gone";
  if (v.run === "acting") return "card";
  const since = now - (v.endedAt ?? now);
  if (v.run === "done") return since < DONE_CARD_MS ? "card" : "pill";
  return since < STOPPED_MS ? "stopped" : "gone";
}

/**
 * When phaseOf next changes (one timeout), or null when it does not.
 * @param {TargetView} v
 * @param {number} now
 * @returns {number | null} milliseconds from now
 */
export function nextPhaseIn(v, now) {
  if (!v.step || v.run === "acting" || v.endedAt === null) return null;
  const at = v.endedAt + (v.run === "done" ? DONE_CARD_MS : STOPPED_MS);
  return at > now ? at - now : null;
}

/**
 * Drops what has gone (a stopped run after its 4 s).
 * @param {GlassState} s
 * @param {number} now
 * @returns {GlassState}
 */
export function prune(s, now) {
  let out = s;
  for (const v of Object.values(s.targets)) if (v.step && phaseOf(v, now) === "gone") out = edit(out, v.target, () => null);
  return out;
}

/**
 * The picture's look: the Live badge only while it is live, dimmed with a note when it is not.
 * @param {TargetView} v
 * @param {{ path: Path, frame: boolean | null }} env
 * @returns {{ badge: boolean, dim: boolean, note: string | null }}
 */
export function pictureLook(v, env) {
  if (v.picture === "shielded") return { badge: false, dim: true, note: COPY.shielded };
  if (env.path === "relay" || env.frame === false) return { badge: false, dim: true, note: COPY.paused };
  if (v.picture === "stale") return { badge: false, dim: true, note: null };
  const live = v.run === "acting" && v.live && v.picture === "ok";
  return { badge: live, dim: false, note: null };
}

/**
 * The step line: its mark, text and what trails it (the age or the holder), and why a failed
 * step failed. Waiting for you replaces the summary; a stopped run says how far it got.
 * @param {TargetView} v
 * @param {number} now
 * @param {string | null} [waiting] what the agent waits on you for
 * @returns {{ mark: "running" | "ok" | "failed" | "waiting" | "stopped", text: string, trail: string | null, why: string | null }}
 */
export function stepLine(v, now, waiting = null) {
  const step = v.step;
  if (!step) return { mark: "running", text: "", trail: null, why: null };
  if (v.run === "stopped") return { mark: "stopped", text: stoppedLine(v.count), trail: null, why: null };
  const trail = v.holder ? holderLine(v.holder) : stepAge(now - step.at);
  if (waiting && v.run === "acting") return { mark: "waiting", text: waitingLine(waiting), trail, why: null };
  const mark = step.ok === true || v.run === "done" ? "ok" : step.ok === false ? "failed" : "running";
  return { mark, text: step.summary, trail, why: step.ok === false ? step.why : null };
}

/**
 * The step's age: "now", "4 s", "2 min", "1 h". A clock that runs behind reads "now".
 * @param {number} ms
 * @returns {string}
 */
export function stepAge(ms) {
  const t = Number.isFinite(ms) ? ms : 0;
  if (t < 2000) return "now";
  if (t < 60_000) return `${Math.floor(t / 1000)} s`;
  if (t < 3_600_000) return `${Math.floor(t / 60_000)} min`;
  return `${Math.floor(t / 3_600_000)} h`;
}

/**
 * How long until stepAge's text changes: a second under a minute, then on the minute, then the hour.
 * @param {number} ms
 * @returns {number}
 */
export function ageTick(ms) {
  const t = Math.max(0, Number.isFinite(ms) ? ms : 0);
  if (t < 2000) return 2000 - t;
  const step = t < 60_000 ? 1000 : t < 3_600_000 ? 60_000 : 3_600_000;
  return step - (t % step);
}

/**
 * The live region's words for a step: "kit: Clicked Compose in Mail".
 * @param {string} agent
 * @param {string} text
 */
export const announceText = (agent, text) => `${agent}: ${text}`;

/**
 * How long the live region waits before it speaks again (0: now). At most once every 5 s.
 * @param {number} now
 * @param {number | null} lastAt
 * @returns {number}
 */
export function announceWait(now, lastAt) {
  if (lastAt === null) return 0;
  return Math.max(0, lastAt + ANNOUNCE_GAP_MS - now);
}

/**
 * Now's cards: one per agent's computer with a step, by agent name.
 * @param {GlassState} s
 * @param {number} now
 * @returns {TargetView[]}
 */
export function nowTargets(s, now) {
  if (s.available !== true) return [];
  return Object.values(s.targets)
    .filter((v) => v.step && phaseOf(v, now) !== "gone")
    .sort((a, b) => a.agent.localeCompare(b.agent));
}

/**
 * The target for an agent (a thread's), when the box has one with a step.
 * @param {GlassState} s
 * @param {string | null | undefined} agent
 * @returns {TargetView | null}
 */
export function targetFor(s, agent) {
  if (s.available !== true || !agent) return null;
  const v = s.targets[`agent:${agent}`];
  return v && v.step ? v : null;
}
