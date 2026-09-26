// @ts-check
// Lessons, a tab in Memory (/memory?tab=lessons; ADR 0007, decision 13). What Vyre learned from
// the user's corrections, in four groups: Proposed (waiting for a yes), Active, Retired (folded
// away), and Proposed skills when the learning module offers them.
//
// Making Vyre stricter is free; making it looser needs a person (decision 11). Accept, Retire,
// Relax and a skill's Install and Dismiss go through withPresence (memory-presence.js): when vyred
// answers `presence_required`, a sheet shows what is about to change and asks for the passkey.
// With no passkey, the row says the terminal command instead of failing quietly. Edit tightens or rewords only; an
// edit that would weaken a lesson comes back refused, and the refusal is shown as it is.
//
// Follows lesson.* events and repaints only the row they name. Tools: learn.lessons, learn.stats,
// learn.skills, learn.accept, learn.edit, learn.retire, learn.relax, learn.skill-install,
// learn.skill_retire.

import { h, put, link, empty } from "../js/dom.js";
import { attempt } from "../js/api.js";
import { when, plural } from "../js/fmt.js";
import { groupLessons, scopeWords, countsLine, checkWords, verdictOf, lowerLevels, presenceText, presenceCommand, lessonSummary, skillSummary, SOURCE, turnHref } from "./memory-data.js";
import { withPresence } from "./memory-presence.js";

/** This tab's stylesheet, added once, before the first paint. */
let styled = null;
function style() {
  if (!styled) styled = new Promise(resolve => {
    const l = h("link", { rel: "stylesheet", href: "/css/views/memory-lessons.css" });
    l.addEventListener("load", resolve);
    l.addEventListener("error", resolve);
    document.head.append(l);
  });
  return styled;
}

/** "Accept this in a terminal: vyre learn accept 7, or from the Capsule" with the command in mono. */
function cmdWords(text) {
  const m = /^(.*?: )(vyre [^,]+)(.*)$/.exec(text);
  return m ? [m[1], h("span", { class: "code" }, m[2]), m[3]] : text;
}

/** What a row says after a presence flow ended without the change, or after any other refusal. */
function presenceWords(e, tool, id) {
  if (e.state === "cancelled") return "Cancelled. Nothing changed.";
  if (e.state === "no_passkey" || e.code === "presence_required") return cmdWords(presenceText(tool, id, false));
  if (e.state) return String(e.message);
  if (e.code === "no_such_tool") return `This needs a newer learning module (${tool} is not there yet).`;
  return e.missing ? `The ${e.module} module is not running on this machine.` : String(e.message);
}

const listOf = d => (Array.isArray(d) ? d : Array.isArray(d?.lessons) ? d.lessons : Array.isArray(d?.skills) ? d.skills : []);

/**
 * @param {HTMLElement} root
 * @param {any} ctx the view's context (on, alive)
 * @param {{ onCount: (n: number) => void, names: () => Map<string, string> }} o
 */
export default async function lessons(root, ctx, o) {
  await style();
  let stopped = false;
  const alive = () => !stopped && ctx.alive();
  const st = { dirty: false, lessons: /** @type {any[]} */ ([]), stats: null, skills: /** @type {any[]|null} */ (null), error: null };
  const status = h("p", { class: "small muted ml-status", role: "status" });
  const groups = {
    proposed: h("div", { class: "ml-rows", role: "list", "aria-labelledby": "ml-h-proposed" }),
    active: h("div", { class: "ml-rows", role: "list", "aria-labelledby": "ml-h-active" }),
    retired: h("div", { class: "ml-rows", role: "list", "aria-labelledby": "ml-h-retired" }),
  };
  const heads = {
    proposed: h("span", { class: "ml-count beacon" }), active: h("span", { class: "ml-count" }), retired: h("span", { class: "ml-count" }),
  };
  const retired = /** @type {HTMLDetailsElement} */ (h("details", { class: "ml-group ml-retired" },
    h("summary", { class: "ml-head" }, h("h2", { class: "lbl", id: "ml-h-retired" }, "Retired"), heads.retired), groups.retired));
  const skillsBox = h("section", { class: "ml-group", hidden: true, "aria-labelledby": "ml-h-skills" });
  const sections = {
    proposed: h("section", { class: "ml-group" }, h("div", { class: "ml-head" }, h("h2", { class: "lbl beacon", id: "ml-h-proposed" }, "Proposed"), heads.proposed), groups.proposed),
    active: h("section", { class: "ml-group" }, h("div", { class: "ml-head" }, h("h2", { class: "lbl", id: "ml-h-active" }, "Active"), heads.active), groups.active),
  };
  const wrap = h("div", { class: "ml" });

  async function read() {
    const [r, s, k] = await Promise.all([attempt("learn.lessons", { status: "all" }), attempt("learn.stats", {}), attempt("learn.skills", {})]);
    if (!alive()) return false;
    st.error = r.error || null;
    st.lessons = listOf(r.data);
    st.stats = s.data || null;
    st.skills = k.error ? null : listOf(k.data);
    return true;
  }

  function drawAll() {
    if (st.error) { put(root, h("div", { class: "mem-pad" }, empty("Lessons are kept by the learning module.", st.error))); o.onCount(0); return; }
    const g = groupLessons(st.lessons);
    const skills = (st.skills || []).filter(x => !x.status || x.status === "proposed");
    if (!st.lessons.length && !skills.length) {
      put(root, h("div", { class: "mem-pad" }, h("div", { class: "empty mem-empty" },
        h("p", null, "No lessons yet."),
        h("p", { class: "small faint" }, "When you correct Vyre, it proposes a lesson here. Say yes and it is enforced from the next turn."))));
      o.onCount(0);
      return;
    }
    for (const k of /** @type {const} */ (["proposed", "active", "retired"])) put(groups[k], g[k].map(l => lessonRow(l)));
    counts();
    drawSkills(skills);
    put(wrap,
      h("p", { class: "ml-note" }, "What Vyre learned from your corrections. A lesson with a check is enforced by the hooks; one broken again moves up a level. Making a lesson stricter is yours to do here; loosening one needs you in person."),
      status,
      g.proposed.length ? sections.proposed : null,
      sections.active, retired, skillsBox);
    put(root, h("div", { class: "mem-pad ml-pad" }, wrap));
  }
  function counts() {
    const g = groupLessons(st.lessons);
    put(heads.proposed, g.proposed.length ? String(g.proposed.length) : "");
    put(heads.active, String(g.active.length));
    put(heads.retired, String(g.retired.length));
    if (!g.active.length && !groups.active.childElementCount) put(groups.active, h("p", { class: "small faint ml-none" }, "None yet. A proposal you accept moves here."));
    retired.hidden = !g.retired.length;
    o.onCount(g.proposed.length);
    if (g.proposed.length && !sections.proposed.isConnected && wrap.isConnected) status.after(sections.proposed);
    if (!g.proposed.length) sections.proposed.remove();
  }

  // ---- one lesson ----------------------------------------------------------------------------
  function lessonRow(l) {
    const el = h("div", { class: "ml-row", role: "listitem", "data-id": String(l.id), "data-status": l.status });
    const msg = h("p", { class: "small muted ml-row-status", role: "status" });
    const src = l.source || {};
    const verdict = verdictOf(st.stats, l.id);
    const href = turnHref(src.session ? { session: src.session, seq: src.seq } : null);
    const show = () => put(el,
      h("div", { class: "ml-main" },
        h("div", { class: "ml-rule" }, l.rule),
        l.when && l.when !== "always" ? h("div", { class: "small muted ml-when" }, "When ", l.when) : null,
        h("div", { class: "ml-meta" },
          h("span", { class: "tag ml-level lv-" + l.level }, l.level),
          checkWords(l.check) ? h("span", { class: "tag", title: l.check?.label || "" }, checkWords(l.check)) : h("span", { class: "tag ml-quiet" }, "no check"),
          h("span", { class: "small muted" }, scopeWords(l.scope, o.names()))),
        h("div", { class: "ml-counts" },
          h("span", { class: "code" }, countsLine(l)),
          verdict ? h("span", { class: "ml-verdict v-" + verdict.verdict.replace(/\s+/g, "-") }, verdict.text) : null),
        h("div", { class: "small faint ml-src" },
          "From ", SOURCE[src.kind] || src.kind || "a thread",
          href ? [" · ", link(href, { class: "link quiet" }, Number.isInteger(src.seq) ? `that turn` : "that thread")] : null,
          l.created ? `, ${when(l.created)}` : "",
          src.text && src.text !== l.rule ? h("span", { class: "ml-said" }, `“${String(src.text).slice(0, 140)}${String(src.text).length > 140 ? "…" : ""}”`) : null)),
      h("div", { class: "ml-act" }, actions()),
      msg);
    const actions = () => {
      if (l.status === "proposed") return [
        h("button", { type: "button", class: "btn btn-sm", onclick: () => act("learn.accept", { id: l.id }, "Accepted. It applies from the next turn.", "Accept") }, "Accept"),
        h("button", { type: "button", class: "btn btn-ghost btn-sm", onclick: edit }, "Edit"),
        h("button", { type: "button", class: "btn btn-ghost btn-sm", onclick: () => act("learn.retire", { id: l.id }, "Declined.", "Decline") }, "Decline")];
      if (l.status === "retired") return [h("span", { class: "small faint" }, l.updated ? `Retired ${when(l.updated)}` : "Retired")];
      const lower = lowerLevels(l.level);
      return [
        h("button", { type: "button", class: "btn btn-ghost btn-sm", onclick: edit }, "Edit"),
        h("button", { type: "button", class: "btn btn-ghost btn-sm", disabled: !lower.length, title: lower.length ? "" : "Already at remind, the lightest level", onclick: relax }, "Relax"),
        h("button", { type: "button", class: "btn btn-ghost btn-sm", onclick: () => confirmRetire() }, "Retire")];
    };

    /** Call a presence tool: the sheet asks for the passkey; a cancel leaves the row as it was. */
    const act = async (tool, input, done, verb) => {
      for (const b of el.querySelectorAll(".ml-act button")) /** @type {HTMLButtonElement} */ (b).disabled = true;
      put(msg);
      try {
        const r = await withPresence(tool, input, { summary: lessonSummary(verb, l, o.names(), input.level), command: presenceCommand(tool, l.id) });
        if (!alive()) return;
        if (r && r.id !== undefined && r.status) Object.assign(l, r);
        put(status, done);
        await refresh(l.id);
      } catch (err) {
        if (!alive()) return;
        const e = /** @type {any} */ (err);
        show();
        put(msg, presenceWords(e, tool, l.id));
      }
    };
    const confirmRetire = () => {
      put(el,
        h("div", { class: "ml-main" }, h("div", { class: "ml-rule" }, l.rule), h("div", { class: "small muted" }, "Retire this lesson? Vyre stops applying it, and it keeps its counts.")),
        h("div", { class: "ml-act" },
          h("button", { type: "button", class: "btn btn-sm", onclick: () => act("learn.retire", { id: l.id }, "Retired.", "Retire") }, "Retire"),
          h("button", { type: "button", class: "btn btn-ghost btn-sm", onclick: show }, "Cancel")),
        msg);
      /** @type {HTMLElement|null} */ (el.querySelector(".ml-act button"))?.focus();
    };
    const relax = () => {
      const lower = lowerLevels(l.level);
      let level = lower[lower.length - 1];
      const seg = h("div", { class: "seg", role: "group", "aria-label": "Lower to" });
      const drawSeg = () => put(seg, lower.map(v => h("button", { type: "button", "aria-pressed": String(v === level), onclick: () => { level = v; drawSeg(); } }, v)));
      drawSeg();
      put(el,
        h("div", { class: "ml-main" }, h("div", { class: "ml-rule" }, l.rule),
          h("div", { class: "ml-relax" }, h("span", { class: "small muted" }, `Now ${l.level}. Lower it to`), seg)),
        h("div", { class: "ml-act" },
          h("button", { type: "button", class: "btn btn-sm", onclick: () => act("learn.relax", { id: l.id, level }, `Relaxed to ${level}.`, "Relax") }, "Relax"),
          h("button", { type: "button", class: "btn btn-ghost btn-sm", onclick: show }, "Cancel")),
        msg);
      /** @type {HTMLElement|null} */ (seg.querySelector("button"))?.focus();
    };
    const edit = () => {
      const rule = /** @type {HTMLTextAreaElement} */ (h("textarea", { class: "ed-in ml-in", rows: "1", "aria-label": "Rule", spellcheck: "true" }));
      rule.value = l.rule;
      const whenIn = /** @type {HTMLInputElement} */ (h("input", { class: "ed-in ml-in ml-in-when", type: "text", "aria-label": "When it applies", autocomplete: "off" }));
      whenIn.value = l.when || "always";
      const grow = () => { rule.style.height = "auto"; rule.style.height = rule.scrollHeight + "px"; };
      rule.addEventListener("input", grow);
      const save = async () => {
        const input = { id: l.id };
        if (rule.value.trim() && rule.value.trim() !== l.rule) input.rule = rule.value.trim();
        if (whenIn.value.trim() && whenIn.value.trim() !== (l.when || "always")) input.when = whenIn.value.trim();
        if (Object.keys(input).length === 1) { show(); return; }
        const x = await attempt("learn.edit", input);
        if (!alive()) return;
        if (x.error) {
          const e = x.error;
          put(msg, e.code === "presence_required" || /relax/i.test(String(e.message))
            ? `That would loosen the lesson, so it needs Relax, which needs you in person. ${String(e.message)}`
            : e.missing ? `The ${e.module} module is not running on this machine.` : String(e.message));
          return;
        }
        Object.assign(l, x.data && x.data.id !== undefined ? x.data : input);
        put(status, "Saved.");
        replace(l);
      };
      put(el,
        h("form", { class: "ml-edit", onsubmit: (/** @type {Event} */ e) => { e.preventDefault(); save(); },
          onkeydown: (/** @type {KeyboardEvent} */ e) => {
            if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); show(); }
            else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); save(); }
          } },
          h("div", { class: "ed-row" }, h("span", { class: "lbl ed-lbl" }, "Rule"), rule),
          h("div", { class: "ed-row" }, h("span", { class: "lbl ed-lbl" }, "When"), whenIn),
          h("div", { class: "ml-edit-act" },
            h("button", { type: "submit", class: "btn btn-sm" }, "Save", h("span", { class: "kbd mem-cx-kbd", "aria-hidden": "true" }, "⌘⏎")),
            h("button", { type: "button", class: "btn btn-ghost btn-sm", onclick: show }, "Cancel"))),
        msg);
      requestAnimationFrame(() => { grow(); rule.focus(); });
    };
    show();
    return el;
  }

  // ---- proposed skills -----------------------------------------------------------------------
  function drawSkills(skills) {
    if (!st.skills) { skillsBox.hidden = true; return; }
    skillsBox.hidden = !skills.length;
    put(skillsBox,
      h("div", { class: "ml-head" }, h("h2", { class: "lbl", id: "ml-h-skills" }, "Proposed skills"), h("span", { class: "ml-count" }, String(skills.length))),
      h("div", { class: "ml-rows", role: "list" }, skills.map(k => {
        const msg = h("p", { class: "small muted ml-row-status", role: "status" });
        const el = h("div", { class: "ml-row", role: "listitem", "data-skill": String(k.id) });
        const run = async (tool, done, verb) => {
          put(msg);
          try {
            await withPresence(tool, { id: k.id }, { summary: skillSummary(verb, k), command: presenceCommand(tool, k.id) });
            if (!alive()) return;
            put(status, done);
            await refresh();
          } catch (err) { if (alive()) put(msg, presenceWords(/** @type {any} */ (err), tool, k.id)); }
        };
        const steps = Array.isArray(k.steps) ? k.steps : [];
        put(el,
          h("div", { class: "ml-main" },
            h("div", { class: "ml-rule mono" }, k.name || `skill ${k.id}`),
            k.description ? h("div", { class: "small muted" }, k.description) : null,
            h("div", { class: "ml-counts" }, h("span", { class: "code" }, [steps.length ? plural(steps.length, "step") : null, k.sessions ? `seen clean in ${plural(k.sessions, "session")}` : null].filter(Boolean).join(" · ")))),
          h("div", { class: "ml-act" },
            h("button", { type: "button", class: "btn btn-sm", onclick: () => run("learn.skill-install", "Installed.", "Install") }, "Install"),
            h("button", { type: "button", class: "btn btn-ghost btn-sm", onclick: () => run("learn.skill_retire", "Dismissed.", "Dismiss") }, "Dismiss")),
          msg);
        return el;
      })));
  }

  // ---- events: repaint only the row they name ------------------------------------------------
  function replace(l) {
    const old = root.querySelector(`.ml-row[data-id="${CSS.escape(String(l.id))}"]`);
    const group = l.status === "proposed" ? groups.proposed : l.status === "retired" ? groups.retired : groups.active;
    const fresh = lessonRow(l);
    if (old && old.parentElement === group) old.replaceWith(fresh);
    else { old?.remove(); group.querySelector(".ml-none")?.remove(); group.append(fresh); }
    counts();
  }
  async function refresh(id) {
    if (document.hidden) { st.dirty = true; return; }
    const before = new Map(st.lessons.map(l => [String(l.id), JSON.stringify(l)]));
    const [r, s] = await Promise.all([attempt("learn.lessons", { status: "all" }), attempt("learn.stats", {})]);
    if (!alive() || r.error) return;
    st.lessons = listOf(r.data);
    st.stats = s.data || st.stats;
    if (!wrap.isConnected) { drawAll(); return; }
    const seen = new Set();
    for (const l of st.lessons) {
      seen.add(String(l.id));
      if (id === undefined ? before.get(String(l.id)) !== JSON.stringify(l) : String(l.id) === String(id)) replace(l);
    }
    for (const k of before.keys()) if (!seen.has(k)) root.querySelector(`.ml-row[data-id="${CSS.escape(k)}"]`)?.remove();
    counts();
  }
  for (const t of ["lesson.proposed", "lesson.learned", "lesson.caught", "lesson.broken", "lesson.escalated", "lesson.retired", "lesson.dormant"]) {
    ctx.on(t, e => { if (!stopped) refresh(e.payload?.lesson ?? e.payload?.id); });
  }
  for (const t of ["skill.proposed", "skill.installed", "skill.retired"]) ctx.on(t, async () => {
    if (stopped || document.hidden) { st.dirty = true; return; }
    const k = await attempt("learn.skills", {});
    if (!alive()) return;
    st.skills = k.error ? null : listOf(k.data);
    drawSkills((st.skills || []).filter(x => !x.status || x.status === "proposed"));
  });
  const onVisible = async () => { if (!document.hidden && st.dirty && !stopped) { st.dirty = false; if (await read()) drawAll(); } };
  document.addEventListener("visibilitychange", onVisible);

  const stop = () => { stopped = true; document.removeEventListener("visibilitychange", onVisible); };
  ctx.cleanup(stop);
  if (await read()) drawAll();
  return { stop };
}
