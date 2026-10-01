// @ts-check
// Ask: talk to the assistant or any agent. Board: PhoneAsk (phone). On desktop the same thing as
// a centred column.
//
// Tools: agents.list, agents.ask {agent, text, surface?, wait?} (switchboard's real reply is
// {agent, thread, text, ok, cost_usd?, note?, ask?}: no recall step, so "answer" reads `text`;
// `ok:false` with empty text is not a tool error, it means the turn stopped short, e.g. `ask` is
// a raised permission the thread is waiting on, answered from the thread itself via its "Open
// thread" link). memory.relevant {text} for "From memory" hints while typing (unrelated to the
// reply itself). Events: thread.text, to fill an answer that streams in after agents.ask's own
// wait times out.
//
// agents.history does not exist as a switchboard tool; the call below degrades to an empty log
// rather than a crash (attempt() treats a missing tool as "module not running", which understates
// it here since agents IS running, only this one lookup is not). The recalledBlock/"Ask a model"
// path (x.recalled) never triggers today, since nothing sets it; left in place for when a
// recall-first answer exists, rather than ripped out for a feature switchboard may still add.

import { h, put, link } from "../js/dom.js";
import { attempt } from "../js/api.js";
import { mark, wordmark } from "../js/icons.js";
import { clock } from "../js/fmt.js";

const threadHref = (thread, project) => project ? `/projects/${encodeURIComponent(project)}/${encodeURIComponent(thread)}` : `/threads/${encodeURIComponent(thread)}`;
const why = err => err?.missing
  ? (err.module === "switchboard" ? "Sessions are not available on this box, so agents cannot answer here yet." : `The ${err.module} module is not running on this machine.`) // internal-word: the module id, compared in code and never drawn
  : String(err?.message || err || "");
const day = t => { const d = new Date(t); return `${d.getDate()} ${d.toLocaleDateString(undefined, { month: "short" })}`; };
const secs = ms => `${(Number(ms) / 1000).toFixed(1)} s`;

/** The send arrow, drawn here (icons.js has no up arrow). */
function upArrow() {
  const NS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(NS, "svg");
  for (const [k, v] of Object.entries({ width: "18", height: "18", viewBox: "0 0 24 24", fill: "none", "aria-hidden": "true" })) svg.setAttribute(k, v);
  const p = document.createElementNS(NS, "path");
  for (const [k, v] of Object.entries({ d: "M12 19V5.5M6.5 11L12 5.5L17.5 11", stroke: "currentColor", "stroke-width": "2", "stroke-linecap": "round", "stroke-linejoin": "round" })) p.setAttribute(k, v);
  svg.append(p);
  return svg;
}

/** @param {any} ctx */
export default async function ask(ctx) {
  const log = h("div", { class: "ask-log" });
  const latest = h("section", { class: "ask-latest", "aria-label": "Latest answer", "aria-live": "polite" });
  const chips = h("div", { class: "ask-chips", role: "radiogroup", "aria-label": "Ask which agent" });
  const hints = h("div", { class: "ask-hints", hidden: true, "aria-live": "polite" });
  const input = /** @type {HTMLInputElement} */ (h("input", { id: "ask-in", class: "ask-in", type: "text", autocomplete: "off", placeholder: "Ask", "aria-label": "Ask" }));
  const send = /** @type {HTMLButtonElement} */ (h("button", { type: "submit", class: "ask-send", "aria-label": "Send" }, upArrow()));
  const form = h("form", { class: "ask-capsule", "aria-label": "Ask" },
    hints,
    h("div", { class: "ask-pick" }, chips, h("div", { class: "lbl ask-type", "aria-hidden": "true" }, "Type @")),
    h("div", { class: "ask-row" }, h("label", { for: "ask-in", class: "ask-at", "aria-hidden": "true" }, "@"), input, send));

  put(ctx.root, h("div", { class: "ask" },
    h("div", { class: "phone-head" }, h("span", { class: "ask-brand" }, mark(20), wordmark(22)), h("span", { class: "code" }, location.host)),
    h("div", { class: "ask-col" }, log, latest),
    h("div", { class: "ask-dock" }, h("div", { class: "ask-dock-in" }, form))));
  const toBottom = () => { ctx.root.scrollTop = ctx.root.scrollHeight; };

  // ---- agents ------------------------------------------------------------------------------
  /** @type {any[]} */ let agents = [];
  let chosen = "";
  const choose = (name, focus = false) => {
    chosen = name;
    for (const c of chips.children) {
      const on = c.getAttribute("data-agent") === name;
      c.setAttribute("aria-checked", String(on));
      c.setAttribute("tabindex", on ? "0" : "-1");
      c.classList.toggle("on", on);
    }
    const who = name || "your assistant";
    input.placeholder = `Ask ${who}`;
    input.setAttribute("aria-label", `Ask ${who}`);
    if (focus) input.focus();
  };
  const drawChips = () => {
    put(chips, agents.map(a => h("button", { type: "button", class: "ask-chip", role: "radio", "data-agent": a.name, "aria-checked": "false",
      onclick: () => choose(a.name, true),
      onkeydown: (/** @type {KeyboardEvent} */ e) => {
        if (!["ArrowRight", "ArrowLeft", "ArrowDown", "ArrowUp"].includes(e.key)) return;
        e.preventDefault();
        const i = agents.findIndex(x => x.name === chosen);
        const n = agents[(i + (e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : -1) + agents.length) % agents.length];
        choose(n.name);
        /** @type {HTMLElement|null} */ (chips.querySelector(`[data-agent="${CSS.escape(n.name)}"]`))?.focus();
      } }, `@${a.name}`)));
  };

  const [al, hist] = await Promise.all([attempt("agents.list"), attempt("agents.history", { limit: 6 })]);
  if (!ctx.alive()) return;
  const list = Array.isArray(al.data) ? al.data : al.data?.agents || [];
  agents = [...list].sort((a, b) => (a.kind === "assistant" ? 0 : 1) - (b.kind === "assistant" ? 0 : 1));
  drawChips();
  /** @type {HTMLElement} */ (chips.parentElement).hidden = !agents.length;
  const to = ctx.query.get("to");
  choose(agents.find(a => a.name === to)?.name || agents[0]?.name || to || "");

  // ---- conversation ------------------------------------------------------------------------
  const past = Array.isArray(hist.data) ? [...hist.data].sort((a, b) => (a.at || 0) - (b.at || 0)) : [];
  let current = /** @type {any} */ (null);
  if (past.length) {
    current = past.pop();
    put(log, past.map(earlier));
    drawLatest(current);
  } else {
    put(latest, h("div", { class: "ask-empty" },
      h("h1", { class: "h3" }, agents.length ? "Ask anything about your work." : "Ask your assistant or an agent."),
      h("p", { class: "muted" }, "Memory answers first when it can, and says so. No model is used for those."),
      hist.error?.missing || al.error?.missing ? h("span", { class: "code" }, why(hist.error || al.error)) : null));
  }
  toBottom();

  /** An earlier exchange, small. */
  function earlier(x) {
    const answer = x.recalled?.answer || x.answer || x.modelText;
    return h("section", { class: "ask-earlier", "aria-label": "Earlier" },
      h("div", { class: "lbl" }, `You to ${x.agent} · ${clock(x.at)}`),
      h("div", { class: "ask-q" }, x.text),
      answer ? h("div", { class: "ask-a" }, x.recalled?.answer ? h("span", { class: "dot recall", title: "From memory", "aria-label": "From memory" }) : null, answer) : null);
  }

  /** The latest exchange, large: the question, then the answer or where it stands. */
  function drawLatest(x) {
    const acts = h("div", { class: "ask-acts" });
    const status = h("div", { class: "small muted ask-status", role: "status" }, x.status || "");
    const model = h("div", { class: "ask-model" });
    const answerText = x.answer && !x.recalled ? h("div", { class: "ask-answer" }, x.answer) : null;
    x.el = { status, model };
    if (x.modelText) put(model, h("div", { class: "lbl" }, `${x.agent} · With a model`), h("div", { class: "ask-answer" }, x.modelText));
    put(latest,
      h("div", { class: "ask-head" },
        h("div", { class: "lbl" }, `You to ${x.agent} · ${clock(x.at)}`),
        h("h1", { class: "h3 ask-title" }, x.text)),
      x.recalled ? recalledBlock(x.recalled) : null,
      answerText,
      model,
      acts,
      status);
    if (x.thread) acts.append(link(threadHref(x.thread, x.project), { class: "btn ask-btn" }, "Open thread"));
    if (x.recalled && !x.modelAsked) {
      acts.append(h("button", { type: "button", class: "btn ask-btn", onclick: () => askModel(x) }, "Ask a model"));
    }
    if (!acts.childElementCount) acts.hidden = true;
  }

  function recalledBlock(r) {
    const sources = Array.isArray(r.sources) ? r.sources : [];
    return h("div", { class: "recalled ask-recalled" },
      h("div", { class: "ask-rtop" }, h("div", { class: "lbl recall" }, "From memory · No model used"),
        r.ms != null ? h("div", { class: "code" }, secs(r.ms)) : null),
      h("div", { class: "ask-ranswer" }, r.answer),
      sources.length ? h("ol", { class: "ask-srcs", "aria-label": "Sources" }, sources.map((s, i) => {
        const meta = [s.threadName || s.thread || "", [s.who, s.at ? day(s.at) : ""].filter(Boolean).join(", ")].filter(Boolean).join(" · ");
        return h("li", { class: "ask-src" },
          h("span", { class: "ask-n", "aria-hidden": "true" }, String(i + 1)),
          h("div", { class: "ask-stext" },
            h("div", null, s.text),
            s.thread ? link(threadHref(s.thread, s.project), { class: "ask-smeta" }, meta) : h("div", { class: "ask-smeta" }, meta)));
      })) : null);
  }

  async function askModel(x) {
    x.modelAsked = true;
    drawLatest(x);
    put(x.el.status, `Asking ${x.agent} with a model.`);
    const r = await attempt("agents.ask", { agent: x.agent, text: x.text, model: true });
    if (!ctx.alive() || current !== x) return;
    if (r.error) { x.modelAsked = false; drawLatest(x); put(x.el.status, why(r.error)); return; }
    if (r.data?.thread) { x.thread = r.data.thread; x.project = r.data.project || x.project; }
    x.waiting = r.data?.thread || null;
    drawLatest(x);
    if (typeof r.data?.answer === "string" && r.data.answer) modelAnswer(x, r.data.answer);
    else put(x.el.status, `Sent to ${x.agent}. The answer shows here when it comes.`);
  }

  function modelAnswer(x, text) {
    x.modelText = text;
    put(x.el.model, h("div", { class: "lbl" }, `${x.agent} · With a model`), h("div", { class: "ask-answer" }, text));
    put(x.el.status);
    toBottom();
  }

  // An answer can arrive later, in the agent's thread.
  ctx.on("thread.text", e => {
    const x = current;
    const p = { ...(e.payload || {}), thread: e.thread || e.payload?.thread };
    if (!x || !x.waiting || p.thread !== x.waiting || p.role === "user" || !p.text) return;
    if (x.modelAsked) { modelAnswer(x, p.text); return; }
    x.answer = p.text;
    drawLatest(x);
    toBottom();
  });

  // ---- composer ----------------------------------------------------------------------------
  /** Typing "@name " switches agent and takes the name out of the text. */
  const mention = () => {
    const m = /(^|\s)@([\w-]+)\s/.exec(input.value);
    if (!m) return;
    const a = agents.find(x => x.name.toLowerCase() === m[2].toLowerCase());
    if (!a) return;
    const at = m.index + m[1].length;
    input.value = (input.value.slice(0, at) + input.value.slice(at + m[2].length + 2)).replace(/^\s+/, "");
    choose(a.name);
  };

  let hintSeq = 0, hintT = 0;
  const drawHints = async () => {
    const text = input.value.trim();
    const n = ++hintSeq;
    if (text.length < 4) { hints.hidden = true; return; }
    const r = await attempt("memory.relevant", { text });
    if (!ctx.alive() || n !== hintSeq) return;
    const facts = (Array.isArray(r.data) ? r.data : []).slice(0, 3);
    if (!facts.length) { hints.hidden = true; put(hints); return; }
    put(hints, h("div", { class: "lbl recall" }, "From memory"),
      h("ul", { class: "ask-hlist" }, facts.map(f => h("li", null,
        h("span", { class: "ask-htext" }, f.text),
        f.ref?.session ? link(threadHref(f.ref.session), { class: "ask-hsrc" }, f.ref.name || f.source || "thread") : null))));
    hints.hidden = false;
  };
  input.addEventListener("input", () => { mention(); clearTimeout(hintT); hintT = window.setTimeout(drawHints, 250); });
  ctx.cleanup(() => clearTimeout(hintT));

  form.addEventListener("submit", async e => {
    e.preventDefault();
    mention();
    const text = input.value.trim();
    if (!text || send.disabled) return;
    const agent = chosen || "assistant";
    if (current) log.append(earlier(current));
    const x = { at: Date.now(), agent, text, status: `Asking ${agent}.` };
    current = x;
    drawLatest(x);
    input.value = "";
    hintSeq++; hints.hidden = true;
    send.disabled = true;
    toBottom();
    const r = await attempt("agents.ask", { agent, text });
    if (!ctx.alive()) return;
    send.disabled = false;
    if (current !== x) return;
    if (r.error) { x.status = why(r.error); drawLatest(x); input.value = input.value || text; return; }
    // agents.ask's real reply is {agent,thread,text,ok,note?,ask?}: no recall step, "answer" is
    // "text". ok:false with no text means it stopped short (a permission question, or the thread
    // stopped) rather than a tool-call failure, so it is not r.error.
    const d = r.data || {};
    const text_ = typeof d.text === "string" ? d.text : "";
    Object.assign(x, { thread: d.thread || null, project: d.project || null, answer: text_ || null, ask: d.ask || null });
    x.status = text_ ? "" : d.ask ? `${agent} needs a permission answered before it can reply.` : d.note || `Sent to ${agent}. The answer shows here when it comes.`;
    x.waiting = text_ ? null : x.thread;
    drawLatest(x);
    toBottom();
  });

  if (to) input.focus();
}
