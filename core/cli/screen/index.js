// @ts-check
// The live screen: what `vyre` opens in a terminal (docs/SPEC.md, section 10). This file joins
// the pure parts (model, layout, transcript) to the terminal (driver) and to vyred (live), and
// runs the effects a key asks for, one at a time.
//
// The terminal is a surface like the Deck or a phone: it names itself "cli:<pid>" on everything
// that touches a thread's keyboard, and gives back every keyboard it took when it closes.
// Answering an ask or sending a draft goes through callAsPerson, so vyred still decides whether
// a person is here; the screen steps out of the way while that proof is asked for.

import { call, request, write } from "../../daemon/client.js";
import { callAsPerson } from "../presence.js";
import * as model from "./model.js";
import { render } from "./layout.js";
import { terminal } from "./driver.js";
import { transcript, apply, load as loadTranscript } from "./transcript.js";
import { load, sessions, stream, linkStatus, REFRESH } from "./live.js";

const { SURFACE } = model;
const LINK_MS = 60_000;
const REFRESH_MS = 250;
const KEEP_TRANSCRIPTS = 20;

/**
 * @typedef {{ newSession: () => Promise<number>|number, startThread: (args: string[]) => Promise<number>,
 *   resume: (t: any, o: { project?: string }) => Promise<number>, talk: (agent: string, io: any) => Promise<void>,
 *   asPerson?: typeof callAsPerson }} Actions
 */

/**
 * Run the screen until the person quits or hands off to Claude Code. Resolves to an exit code.
 * @param {{ input: any, output: any }} io
 * @param {Actions & { real?: boolean, onFrame?: (lines: string[]) => void }} o
 */
export async function runScreen(io, o) {
  const asPerson = o.asPerson || callAsPerson;
  let st = model.initial(await load());
  /** @type {Map<string, import("./transcript.js").Transcript>} */
  const transcripts = new Map();
  /** @type {Map<string, any>} */
  const details = new Map();
  const leased = new Set();
  /** @type {import("./keys.js").Key[]} */
  const queue = [];
  let busy = false;
  let refreshTimer = null;
  let linkTimer = null;
  /** @type {(code: number) => void} */
  let finish = () => {};
  const done = new Promise(r => { finish = r; });
  let ended = false;

  const frame = () => {
    const lines = render(st, { ...term.size(), transcripts, details });
    o.onFrame?.(lines);
    return lines;
  };
  const term = terminal(io, { real: o.real, onKeys: keys => { queue.push(...keys); pump(); } });

  // ---- data

  async function refresh() {
    refreshTimer = null;
    try {
      const d = await load({ sessions: st.data.sessions });
      st = model.withData(st, { ...d, link: st.data.link });
    } catch (e) {
      st = { ...st, status: "Vyre did not answer: " + /** @type {Error} */ (e).message };
    }
    await follow();
    term.paint();
  }
  const soon = () => { clearTimeout(refreshTimer); refreshTimer = setTimeout(refresh, REFRESH_MS); };

  /** Load what the selected item needs: a thread's backlog, a draft's content. */
  async function follow() {
    const it = model.current(st);
    if (!it) return;
    if (it.kind === "thread" && !transcripts.has(it.value.id)) {
      const tr = transcript();
      transcripts.set(it.value.id, tr);
      // Least recently opened first out, so a long session does not grow without end.
      if (transcripts.size > KEEP_TRANSCRIPTS) transcripts.delete(/** @type {string} */ (transcripts.keys().next().value));
      const g = await call("threads.get", { thread: it.value.id, limit: 200 });
      loadTranscript(tr, g.error ? [] : g.data.events || []);
      term.paint();
    }
    if (it.kind === "draft" && !details.has(it.value.id)) {
      const g = await call("gate.get", { id: it.value.id });
      details.set(it.value.id, g.error ? null : g.data);
      term.paint();
    }
  }

  async function loadSessions(slug) {
    const ss = await sessions(slug);
    st = model.withData(st, { ...st.data, sessions: { ...st.data.sessions, [slug]: ss } });
  }

  const events = stream({
    since: st.data.health && st.data.health.last_event,
    onEvent: e => {
      const tid = e.thread ?? (e.payload && e.payload.thread);
      const tr = tid && transcripts.get(tid);
      if (tr && apply(tr, e)) term.paint();
      if (REFRESH.test(e.type)) soon();
    },
    onDown: () => { st = { ...st, status: "lost vyred's event stream · reconnecting" }; term.paint(); },
    onOpen: () => { if (st.status.startsWith("lost vyred")) { st = { ...st, status: "" }; soon(); } },
  });

  async function link() {
    const tools = await request("GET", "/v1/tools");
    const names = (tools.data || []).map(t => t.name);
    const phrase = await linkStatus(names);
    if (phrase !== (st.data.link || "")) { st = { ...st, data: { ...st.data, link: phrase } }; term.paint(); }
  }

  // ---- effects

  /** A human-only tool: tried as is, and only when vyred wants a proof does the screen step aside. */
  async function asHuman(tool, input) {
    const first = await call(tool, input);
    if (!(first.error && first.error.code === "presence_required")) return first;
    term.suspend();
    try { return await asPerson(tool, input); } finally { term.resume(); }
  }

  /** Hand the terminal to something else for good: Claude Code. */
  async function handOff(fn) {
    await end();
    finish(await fn());
  }

  /** @param {import("./model.js").Effect} ef */
  async function run(ef) {
    switch (ef.type) {
      case "quit": await end(); finish(0); return;
      case "new": return handOff(() => o.newSession());
      case "new-in": return handOff(() => o.startThread(["--project", ef.project]));
      case "resume": return handOff(() => o.resume(ef.session, { project: ef.session.project }));
      case "load": await loadSessions(ef.project); return;
      case "talk":
        term.suspend();
        try { await o.talk(ef.agent, io); } finally { term.resume(); }
        soon();
        return;
      case "answer": {
        const r = await asHuman("threads.answer", { ask: ef.ask.id, decision: ef.decision, surface: SURFACE });
        st = { ...st, status: r.error ? r.error.message : r.data && r.data.answered ? (ef.decision === "allow" ? "allowed" : "denied") + ` · ${ef.ask.tool}` : `not answered${r.data && r.data.note ? ": " + r.data.note : ""}` };
        soon();
        return;
      }
      case "draft": {
        const r = await asHuman(ef.decision === "approve" ? "gate.approve" : "gate.reject", { id: ef.draft.id });
        st = { ...st, status: r.error ? r.error.message : ef.decision === "approve" ? `sent · ${ef.draft.kind} to ${[].concat(ef.draft.to).join(", ")}` : "rejected · nothing was sent" };
        soon();
        return;
      }
      case "send": {
        // Each try is its own intent (the second follows a lease), so each gets its own key.
        const send = () => write("threads.send", { thread: ef.thread.id, text: ef.text, surface: SURFACE });
        let r = await send();
        // A holder that is a closed terminal holds nothing: take the keyboard and send again.
        if (!r.error && r.data && !r.data.sent && r.data.holder && !model.liveHolder(r.data.holder)) {
          const l = await call("threads.lease", { thread: ef.thread.id, surface: SURFACE });
          if (!l.error) { leased.add(ef.thread.id); r = await send(); }
        }
        if (r.error) st = { ...st, status: r.error.message };
        else if (r.data && r.data.sent) { leased.add(ef.thread.id); st = { ...st, status: "" }; }
        else if (r.data && r.data.holder) st = { ...st, compose: ef.text, status: `${r.data.holder} has the keyboard · ctrl-l takes it` };
        else st = { ...st, compose: ef.text, status: `not sent${r.data && r.data.note ? ": " + r.data.note : ""}` };
        return;
      }
      case "lease": {
        const r = await call("threads.lease", { thread: ef.thread.id, surface: SURFACE });
        if (r.error) st = { ...st, status: r.error.message };
        else { leased.add(ef.thread.id); st = { ...st, status: `keyboard: this terminal${r.data.previous && r.data.previous !== r.data.holder ? " · taken from " + r.data.previous : ""}` }; }
        soon();
        return;
      }
    }
  }

  async function pump() {
    if (busy || ended) return;
    busy = true;
    try {
      while (queue.length && !ended) {
        const key = /** @type {import("./keys.js").Key} */ (queue.shift());
        if (key.name === "ctrl-z") { term.background(); continue; }
        const r = model.reduce(st, key);
        st = r.st;
        term.paint();
        if (r.effect) await run(r.effect);
        if (!ended) { await follow(); term.paint(); }
      }
    } catch (e) {
      st = { ...st, status: /** @type {Error} */ (e).message };
      term.paint();
    } finally { busy = false; }
  }

  async function end() {
    if (ended) return;
    ended = true;
    clearTimeout(refreshTimer);
    clearInterval(linkTimer);
    events.stop();
    term.stop();
    // Give back every keyboard this terminal took, so no thread is left held by a closed screen.
    await Promise.all([...leased].map(id => call("threads.release", { thread: id, surface: SURFACE }, { timeout: 2000 })));
  }

  // Timers first: keys can arrive (and quit) while the first loads below are still out, and a
  // timer set after end() would keep the process alive.
  linkTimer = setInterval(() => { link().catch(() => {}); }, LINK_MS);
  term.start(frame);
  link().catch(() => {});
  await follow();
  term.paint();
  // Each project's sessions, after the first paint: the filter searches them without opening.
  (async () => { for (const p of st.data.projects) { if (ended) return; if (!st.data.sessions[p.slug]) await loadSessions(p.slug); } term.paint(); })().catch(() => {});
  return done;
}
