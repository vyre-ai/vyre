// @ts-check
// Now: what needs you, what is working, and what memory learned today. Boards: DeckNow, PhoneNow.
//
// Needs you: drafts held at the Gate and open asks from sessions (js/needs.js), in Beacon.
// Working: running threads from the switchboard (threads.list). When nothing runs, the most
// recent sessions from the catalogue stand in, so Now is never an empty page.
// Learned today: memory.facts last seen today, in Recall gold, each with its source thread.
//
// On the box, Working and the recent sessions take in the paired Mac's too, with a machine chip
// and no Watch (a Mac thread is read here, never driven: js/machine.js). A paired Mac that is away
// shows as one quiet chip in Working's head, from link.macs, read each time Working redraws.

import { h, put, link, head, empty } from "../js/dom.js";
import { attempt } from "../js/api.js";
import { icon, mark, wordmark } from "../js/icons.js";
import * as needs from "../js/needs.js";
import { form, gateFields } from "../js/editable.js";
import { setupCard } from "../js/phone-setup.js";
import { assistantCard } from "../js/assistant-setup.js";
import { pairRequests } from "../js/pair.js";
import { firstPasskeyCard } from "../js/first-passkey.js";
import { things, count, clock, today, since, when, startOfToday, base, initial, plural } from "../js/fmt.js";
import { isMac, machineChip, offlineChip, readMacs } from "../js/machine.js";
import { createProjectInline, indexHistoryInline } from "../js/empty-actions.js";
import { phoneNow } from "../js/now-phone.js";
import { sessionHref, elsewhere } from "../js/need-rows.js";

/** Under 760 px Now is the phone's own layout (js/now-phone.js); this file draws the Deck's. */
const phone = () => matchMedia("(max-width: 760px)").matches;

/** @param {any} ctx */
export default async function now(ctx) {
  if (phone()) { phoneNow(ctx); return; }
  const date = h("div", { class: "lbl" }, today());
  const title = h("h1", { class: "h1 now-title" }, " ");
  const sub = h("p", { class: "muted" }, " ");
  const assistant = h("div", { class: "now-assistant" });
  const needsBox = h("section", { class: "now-needs", "aria-labelledby": "needs-h" });
  const working = h("section", { class: "now-sec", "aria-labelledby": "working-h" });
  const learned = h("section", { class: "now-sec", "aria-labelledby": "learned-h" });
  const recentProjects = h("section", { class: "now-sec", "aria-labelledby": "recent-h" });

  // A Mac asking to pair waits on the person, so it sits above everything else.
  const pairing = pairRequests();
  ctx.cleanup(pairing.stop);
  // No passkey on the box at all: nothing above can be approved until there is one.
  const firstKey = firstPasskeyCard();
  ctx.cleanup(firstKey.stop);

  put(ctx.root, h("div", { class: "now" },
    h("div", { class: "phone-head" }, h("span", { style: { display: "flex", gap: "8px", alignItems: "center" } }, mark(18), wordmark(20)),
      h("span", { class: "code" }, location.host)),
    h("div", { class: "now-col" },
      // A phone that is not set up yet: install, notifications, a passkey. null anywhere else.
      firstKey.el,
      pairing.el,
      setupCard(),
      h("div", { class: "now-head" }, date, title, sub, assistant),
      needsBox, working, learned, recentProjects)));

  // The assistant, present: who it is and what it is doing, the first live thing Now says after
  // onboarding hands off here.
  // No assistant yet (onboarding's first step was skipped): the card to make one stands in its
  // place, and the line is drawn from what agents.create hands back.
  const drawAssistant = (/** @type {any} */ a) => {
    assistant.classList.toggle("has-card", !a);
    put(assistant, a ? h("span", null, h("b", null, a.name), " · ", a.doing || "idle")
      : assistantCard({ onCreated: made => { if (ctx.alive()) drawAssistant(made); } }));
  };
  (async () => {
    const r = await attempt("agents.list");
    if (!ctx.alive() || r.error) return;
    drawAssistant((Array.isArray(r.data) ? r.data : []).find(x => x.kind === "assistant") || null);
  })();

  let running = 0;
  // Offline read of the last Now state: only counts, a name and a timestamp, never a held item's
  // words or destination (the service worker already refuses to cache /v1/ for the same reason).
  const SNAP_KEY = "vyre.now.snapshot";
  const saveSnapshot = () => { try { localStorage.setItem(SNAP_KEY, JSON.stringify({ at: Date.now(), needs: needs.current().length, running })); } catch {} };
  const loadSnapshot = () => { try { return JSON.parse(localStorage.getItem(SNAP_KEY) || "null"); } catch { return null; } };
  const say = () => {
    const n = needs.current().length;
    put(title, n ? `${things(n)} need${n === 1 ? "s" : ""} you.` : "Nothing needs you.");
    const r = running ? `${count(running)} thread${running === 1 ? " is" : "s are"} running on ${running === 1 ? "its" : "their"} own.` : "Nothing is running.";
    put(sub, n ? `${r} Nothing else is waiting on you.` : r);
    saveSnapshot();
  };
  // The clock only needs to be right while someone can see it. In a background tab, SPEC's
  // budget is "no timers faster than a minute" — so pause the tick on visibilitychange rather
  // than let it burn 30s wakeups the whole time this view is mounted but unseen, and catch up
  // immediately (and re-tick) the moment the tab is looked at again. (perf audit, 2026-09-27)
  let tick = null;
  const startTick = () => { if (!tick) tick = setInterval(() => put(date, today()), 30_000); };
  const stopTick = () => { if (tick) { clearInterval(tick); tick = null; } };
  const onVisible = () => { if (document.hidden) stopTick(); else { put(date, today()); startTick(); } };
  document.addEventListener("visibilitychange", onVisible);
  if (!document.hidden) startTick();
  ctx.cleanup(() => { stopTick(); document.removeEventListener("visibilitychange", onVisible); });

  // Needs you
  const drawNeeds = list => {
    say();
    if (!list.length) { put(needsBox); return; }
    put(needsBox,
      h("div", { class: "now-label" }, h("span", { class: "dot beacon", "aria-hidden": "true" }),
        h("h2", { id: "needs-h", class: "lbl beacon" }, "Needs you", h("span", { class: "phone-only" }, ` · ${list.length}`))),
      list.map(n => needCard(n)));
  };
  ctx.cleanup(needs.watch(drawNeeds));
  drawNeeds(needs.current());
  needs.load();

  // Working
  let macs = /** @type {any[]} */ ([]);
  const drawWorking = async () => {
    const [r, m] = await Promise.all([attempt("threads.list", {}), readMacs(attempt, macs)]);
    if (!ctx.alive()) return;
    macs = m;
    if (r.error?.code === "offline") {
      const snap = loadSnapshot();
      const headRow = head("Working");
      /** @type {HTMLElement} */ (headRow.firstChild).id = "working-h";
      put(working, headRow, h("div", { class: "empty" },
        snap ? `Offline. As of ${since(snap.at)} ago: ${things(snap.needs)} needed you, ${snap.running} running.` : "Offline, and nothing is cached yet."));
      return;
    }
    const all = r.data || [];
    // threads.list's real field is `status` (starting|working|waiting|idle|stopped), not `state`,
    // and "running" isn't a value it uses at all — any non-stopped status counts as running.
    const run = all.filter(t => t.status !== "stopped");
    const done = all.filter(t => t.status === "stopped" && (t.last || 0) >= startOfToday());
    running = run.length;
    say();
    const right = h("span", { style: { display: "inline-flex", gap: "10px", alignItems: "center" } }, offlineChip(macs),
      h("span", { class: "lbl now-count" }, r.error ? "" : `${run.length} running · ${done.length} finished today`));
    const headRow = head("Working", right);
    /** @type {HTMLElement} */ (headRow.firstChild).id = "working-h";
    if (run.length) { put(working, headRow, h("div", { class: "rows" }, run.map(workRow))); return; }
    // Nothing running (or no switchboard): the latest sessions, so there is always a way back in.
    const c = await attempt("projects.catalog", { limit: 5 });
    if (!ctx.alive()) return;
    put(working, headRow,
      r.error ? empty("Nothing is running.", r.error) : h("div", { class: "empty" }, "Nothing is running."),
      c.data?.sessions?.length ? h("div", { class: "rows" }, c.data.sessions.map(recentRow)) : null);
  };
  drawWorking();
  for (const t of ["thread.started", "thread.finished", "thread.stopped", "thread.tool"]) ctx.on(t, () => { clearTimeout(wt); wt = window.setTimeout(drawWorking, 300); });
  let wt = 0;

  // Learned today
  const drawLearned = async () => {
    // The box's own catalogue: it only maps Memory's sessions to projects, so the Mac is not asked for 500 rows.
    const [f, cat] = await Promise.all([attempt("memory.facts", { limit: 200 }), attempt("projects.catalog", { limit: 500, machines: "local" })]);
    if (!ctx.alive()) return;
    const projectOf = new Map((cat.data?.sessions || []).map(s => [s.id, s.projects?.[0] || null]));
    const names = new Map((await attempt("projects.list")).data?.projects?.map(p => [p.slug, p.name]) || []);
    const t0 = startOfToday();
    const facts = (f.data?.facts || []).filter(x => (x.seen || x.since || 0) >= t0);
    const right = link("/memory", { class: "lbl", style: { textDecoration: "none", color: "var(--text-2)" } }, "Open Memory →");
    const headRow = head("Memory learned today", right, "recall");
    /** @type {HTMLElement} */ (headRow.firstChild).id = "learned-h";
    if (f.error) { put(learned, headRow, empty("Memory is not available.", f.error)); return; }
    if (!facts.length) {
      const total = (f.data?.facts || []).length;
      put(learned, headRow, total ? h("div", { class: "empty" }, `Nothing new today. Memory holds ${plural(total, "fact")}.`)
        : h("div", { class: "empty" }, "Nothing learned yet. Memory learns people and what links them from your indexed sessions.", indexHistoryInline()));
      return;
    }
    put(learned, headRow, h("div", { class: "rows" }, facts.slice(0, 8).map(x => factRow(x, projectOf, names))));
  };
  drawLearned();
  ctx.on("memory.curated", drawLearned);

  // Recent projects: a way back in without the rail, for a phone or a narrow window.
  const drawRecent = async () => {
    const r = await attempt("projects.list");
    if (!ctx.alive()) return;
    // Each opens its board on this machine, so a Mac's projects (listed under Projects) are left out.
    const list = [...(r.data?.projects || [])].filter(p => !isMac(p)).sort((a, b) => (b.last || 0) - (a.last || 0)).slice(0, 4);
    const headRow = head("Recent projects");
    /** @type {HTMLElement} */ (headRow.firstChild).id = "recent-h";
    if (r.error) { put(recentProjects); return; }
    // Only a Mac's projects: nothing to open here. None at all: say so, with the way to make one.
    if (!list.length && (r.data?.projects || []).length) { put(recentProjects); return; }
    if (!list.length) { put(recentProjects, headRow, h("div", { class: "empty" }, "No projects yet. A project is a folder, its threads and the people in it.", createProjectInline())); return; }
    put(recentProjects, headRow, h("div", { class: "rows" }, list.map(p =>
      h("div", { class: "work-row" },
        h("span", { class: "initial", "aria-hidden": "true" }, icon("projects", 14)),
        h("div", { class: "work-main" },
          h("div", { class: "work-title" }, link(`/projects/${encodeURIComponent(p.slug)}`, { class: "link quiet ellipsis" }, p.name)),
          h("div", { class: "code ellipsis" }, plural(p.threads, "thread"))),
        h("div", { class: "code faint work-since" }, p.last ? since(p.last) : "")))));
  };
  drawRecent();
}

/** One held item: a draft at the Gate, or a question from a session. */
function needCard(n) {
  const where = [n.projectName, n.threadName].filter(Boolean).join(" · ");
  const threadHref = n.thread ? (n.project ? `/projects/${encodeURIComponent(n.project)}/${encodeURIComponent(n.thread)}` : `/threads/${encodeURIComponent(n.thread)}`) : null;
  const status = h("div", { class: "small muted", role: "status" });
  const buttons = h("div", { class: "need-actions" });
  // A held draft or approval is edited in place: every field is an input that reads as text.
  const f = n.kind === "draft" && n.gate?.draft ? form(gateFields({ to: n.gate.to, draft: n.gate.draft })) : null;
  const act = async (opt) => {
    const bad = opt.decision === "approve" && f ? f.error() : null;
    if (bad) { put(status, bad); return; }
    for (const b of buttons.querySelectorAll("button")) /** @type {HTMLButtonElement} */ (b).disabled = true;
    put(status);
    try { await needs.answer(n, opt, f && f.changed() ? f.edited() : null); }
    catch (e) {
      put(status, problem(e));
      for (const b of buttons.querySelectorAll("button")) /** @type {HTMLButtonElement} */ (b).disabled = false;
    }
  };
  // A question has choices, drawn where it was asked: the session's card answers it.
  const qHref = n.kind === "question" ? sessionHref(n) : null;
  // A Mac session's ask or question is answered on that Mac: no buttons here.
  const mac = elsewhere(n);
  if (mac) put(buttons, h("span", { class: "small muted" }, `Answer it on ${mac}`), h("div", { style: { flexGrow: "1" } }),
    threadHref ? link(threadHref, { class: "link small", style: { color: "var(--text-2)" } }, "Open the thread") : null);
  else if (n.kind === "question") put(buttons,
    qHref ? link(qHref, { class: "btn btn-primary" }, "Answer in the session") : null,
    h("button", { type: "button", class: "btn btn-ghost", onclick: () => act({ label: "Decline", decision: "deny" }) }, "Decline"));
  else put(buttons,
    n.options.map((o, i) => h("button", { type: "button",
      class: "btn" + (o.primary ? " btn-primary" : "") + (i === n.options.length - 1 && !o.primary ? " btn-ghost" : ""),
      onclick: () => act(o) }, o.label)),
    h("div", { style: { flexGrow: "1" } }),
    threadHref && n.kind === "ask" ? link(threadHref, { class: "link small", style: { color: "var(--text-2)" } }, "Open the thread") : null);

  const heading = n.kind === "ask"
    ? h("h3", null, `May ${n.agent || "this session"} run `, h("code", { class: "need-cmd" }, n.command || ""), "?")
    : n.kind === "question" ? h("h3", null, n.questions?.[0]?.question || n.title)
    : h("h3", null, n.title);
  return h("div", { class: "need-row" },
    h("div", { class: "need-time mono" }, clock(n.at)),
    h("article", { class: "held need" + (n.kind === "draft" ? " is-draft" : "") },
      h("div", { class: "need-top" }, heading, h("span", { class: "small muted nowrap" }, where)),
      n.why ? h("p", { class: "need-why" }, n.why) : null,
      n.kind === "draft" ? heldBody(n, f) : null,
      buttons, status),
    // Phone: a compact card that opens the full item (PhoneNow, PhoneApprove, PhoneDraft).
    link(`/needs/${encodeURIComponent(n.id)}`, { class: "held need-compact" },
      h("div", { class: "need-compact-top" },
        h("span", { class: "lbl beacon" }, h("span", { class: "dot beacon" }), n.kind === "draft" ? "Held at the Gate" : "Permission"),
        h("span", { class: "code" }, [n.agent, since(n.at)].filter(Boolean).join(" · "))),
      h("div", { class: "need-compact-title" },
        n.kind === "draft" ? h("span", null, compactTitle(n)) : h("span", null, "May I run ", h("code", null, n.command || "")),
        icon("right")),
      where ? h("div", { class: "small muted" }, where) : null));
}

/** The content of a held item: the editable fields, or the summary when the content could not be read. */
function heldBody(n, f) {
  const g = n.gate;
  const recalled = g?.recalled || g?.sources?.[0]?.text || "";
  if (!f) {
    return h("div", { class: "need-body" },
      g?.summary ? h("p", { class: "need-text" }, g.summary) : null,
      h("p", { class: "small muted" }, g?.error ? `The full draft cannot be shown here: ${problem(g.error)}` : "The full draft cannot be shown here."));
  }
  // A previous Send was approved but the sender failed: it came back held, with the edit kept.
  return h("div", { class: "need-body" },
    g?.error ? h("p", { class: "need-why need-error" }, `Held again: ${problem(g.error)}`) : null,
    f.el,
    recalled ? h("div", { class: "need-recalled" }, h("span", { class: "dot recall", "aria-hidden": "true" }),
      h("span", null, g.recalled ? g.recalled : `From memory: ${recalled}`)) : null);
}

/** An error from the Gate, in plain words. */
function problem(e) {
  const x = /** @type {any} */ (e);
  if (x?.missing) return `The ${x.module} module is not running, so this cannot be answered here yet.`;
  if (x?.code === "denied" || /denied/i.test(String(x?.message || x))) return "The Gate does not let the Deck read or answer this yet. Answer it from the terminal or chat.";
  return String(x?.message || x);
}

function compactTitle(n) {
  const g = n.gate;
  if (!g || g.kind === "send") return `Email to ${g?.toName || g?.to?.join(", ") || "someone"}`;
  return g.kind === "spend" ? `Spend through ${g.via}` : `Delete through ${g.via}`;
}

function workRow(t) {
  // A Mac thread's project and agent are the Mac's: it opens read-only by id, and has no Watch here.
  const mac = isMac(t);
  const href = t.project && !mac ? `/projects/${encodeURIComponent(t.project)}/${encodeURIComponent(t.id)}` : `/threads/${encodeURIComponent(t.id)}`;
  return h("div", { class: "work-row" },
    h("span", { class: "initial", "aria-hidden": "true" }, initial(t.agent || t.name)),
    h("div", { class: "work-agent" }, t.agent || "you"),
    h("div", { class: "work-main" },
      h("div", { class: "work-title" }, link(href, { class: "link quiet ellipsis" }, t.name || t.id), machineChip(t), t.projectName ? h("span", { class: "small faint" }, t.projectName) : null),
      h("div", { class: "code ellipsis" }, t.activity || "")),
    h("div", { class: "code faint work-since" }, since(t.started)),
    mac ? null : link(t.agent ? `/agents/${encodeURIComponent(t.agent)}` : href, { class: "btn btn-ghost btn-sm work-watch" }, icon("watch", 14), "Watch"),
    h("span", { class: "work-chev phone-only", "aria-hidden": "true" }, icon("right")));
}

function recentRow(s) {
  // A Mac session's projects are the Mac's own slugs, not boards here: it opens by id.
  const href = s.projects?.[0] && !isMac(s) ? `/projects/${encodeURIComponent(s.projects[0])}/${encodeURIComponent(s.id)}` : `/threads/${encodeURIComponent(s.id)}`;
  return h("div", { class: "work-row" },
    h("span", { class: "initial", "aria-hidden": "true" }, icon("chat", 12)),
    h("div", { class: "work-main" },
      h("div", { class: "work-title" }, link(href, { class: "link quiet ellipsis" }, s.label || s.title || s.id), machineChip(s)),
      h("div", { class: "code ellipsis" }, base(s.cwd), s.turns ? `  ·  ${plural(s.turns, "turn")}` : "")),
    h("div", { class: "code faint work-since" }, when(s.last)));
}

function factRow(f, projectOf, names) {
  const slug = f.ref?.session ? projectOf.get(f.ref.session) : null;
  const src = f.ref?.session ? (slug ? `/projects/${encodeURIComponent(slug)}/${encodeURIComponent(f.ref.session)}` : `/threads/${encodeURIComponent(f.ref.session)}`) : null;
  const pin = h("button", { type: "button", class: "ibtn", "aria-label": "Pin: " + f.text, "aria-pressed": "false" }, icon("pin"));
  const mute = h("button", { type: "button", class: "ibtn", "aria-label": "Mute: " + f.text, "aria-pressed": "false" }, icon("mute"));
  const steer = (btn, tool) => btn.addEventListener("click", async () => {
    const on_ = btn.getAttribute("aria-pressed") !== "true";
    const r = await attempt(tool, { node: f.subject?.id || f.id, off: !on_ });
    if (!r.error) btn.setAttribute("aria-pressed", String(on_));
  });
  steer(pin, "memory.pin");
  steer(mute, "memory.mute");
  return h("div", { class: "fact-row" },
    h("span", { class: "dot recall", "aria-hidden": "true" }),
    h("div", { class: "fact-main" },
      h("span", { class: "fact-text" }, f.text),
      h("span", { class: "small faint fact-src" }, "from ", src ? link(src, { class: "link", style: { color: "var(--text-2)" } }, f.source || f.ref?.name || "a thread") : (f.source || "a thread"),
        slug ? ` · ${names.get(slug) || slug}` : "")),
    pin, mute);
}
