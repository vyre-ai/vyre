// @ts-check
// The email thread card (docs/design/system/components/email-thread.md): a thread an agent found or
// is discussing, read in context. render kind "email_thread" {subject, messages:[{from, to, at,
// snippet, body, attachments?}], labels?, link?}. Newest message first and open; every earlier one
// folds to a line and opens in place. Reading mail is not an outward act, so nothing here calls a
// tool: Reply and Open in Mail hand a link to ctx.open (they open in the Deck, or on a phone in the
// app), and nothing on this card sends.
//
// Every word in a message came from outside, so it is only ever a text node: no markup, no remote
// image (an attachment is a name and a size), quoted reply text folded, and a link is a button
// that shows its address and goes through ctx.open when the person presses it.

import { h, put } from "../../js/dom.js";
import { icon } from "../../js/icons.js";
import { when, plural, initial } from "../../js/fmt.js";
import { ensureCss, shell, head, untrusted } from "./kit.js";

/** Lines of the newest message a phone shows before "Show all". */
export const PHONE_LINES = 12;
const URL_RE = /(https?:\/\/[^\s<>"')\]]+)/g;
const WROTE_RE = /^\s*On .{6,120} wrote:\s*$/;

/** "Sam Reyes <sam@northwind.test>" as { name, addr }. @param {any} s */
export function person(s) {
  const t = String(s ?? "").trim();
  const m = /^"?([^"<]*?)"?\s*<([^>]+)>$/.exec(t);
  const addr = m ? m[2].trim() : /@/.test(t) ? t : "";
  return { name: (m ? m[1].trim() : "") || (addr ? addr.split("@")[0] : t) || "Unknown", addr };
}

/**
 * The words of a body without the quoted reply under it: everything from an "On ... wrote:" line
 * (or the first line that starts with ">") down is the quote.
 * @param {string} body @returns {{ text: string, quoted: string }}
 */
export function splitQuote(body) {
  const lines = String(body ?? "").replace(/\r\n?/g, "\n").split("\n");
  let cut = lines.findIndex((l, i) => WROTE_RE.test(l) || (/^\s*>/.test(l) && !(i > 0 && WROTE_RE.test(lines[i - 1]))));
  if (cut < 0) return { text: lines.join("\n").trimEnd(), quoted: "" };
  return { text: lines.slice(0, cut).join("\n").trimEnd(), quoted: lines.slice(cut).join("\n").trim() };
}

/** "412 KB" from a byte count, or a size that is already words. @param {any} n */
function sizeWord(n) {
  if (typeof n !== "number" || !(n >= 0)) return n ? String(n) : "";
  return n >= 1_048_576 ? `${(n / 1_048_576).toFixed(1)} MB` : n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n} B`;
}

/** @param {any} data @returns {any[]} newest first: by time when every message has one, else the given order reversed */
function ordered(data) {
  const ms = Array.isArray(data?.messages) ? data.messages.filter((/** @type {any} */ m) => m && typeof m === "object") : [];
  const ts = ms.map((/** @type {any} */ m) => new Date(m.at).getTime());
  return ts.every(Number.isFinite) ? ms.map((m, i) => ({ m, t: ts[i] })).sort((a, b) => b.t - a.t).map(x => x.m) : ms.slice().reverse();
}

/**
 * @param {any} data render payload
 * @param {{ phone?: boolean, open?: (href: string) => void, retry?: () => void }} [ctx]
 */
export function emailThread(data, ctx = {}) {
  ensureCss("email-thread");
  const el = /** @type {any} */ (shell("cv-email-thread", "Email thread"));
  const open = new Set(/** @type {number[]} */ ([]));
  const state = { all: false, quotes: new Set(/** @type {number[]} */ ([])), fresh: true };

  /** Text with its addresses as inert buttons that open through ctx.open. @param {string} s */
  function words(s) {
    return String(s).split(URL_RE).map((part, i) => i % 2 === 0 ? part
      : h("button", { class: "cv-et-link", type: "button", title: part, onclick: () => ctx.open?.(part) }, part));
  }

  /** @param {string} text @param {boolean} cap */
  function prose(text, cap) {
    const lines = text.split("\n");
    const cut = cap && !state.all && lines.length > PHONE_LINES;
    const shown = (cut ? lines.slice(0, PHONE_LINES) : lines).join("\n");
    const paras = shown.split(/\n{2,}/).map(p => p.trim()).filter(Boolean);
    return [...paras.map(p => h("p", { class: "cv-et-p" }, words(untrusted(p)))),
      cut ? h("button", { class: "btn btn-ghost btn-sm cv-et-more", type: "button", onclick: () => { state.all = true; draw(); } }, `Show all ${lines.length} lines`) : null];
  }

  /** @param {any} m @param {number} i @param {boolean} latest @param {boolean} single */
  function row(m, i, latest, single) {
    const from = person(m.from);
    const isOpen = single || latest || open.has(i);
    const raw = String(m.body ?? m.snippet ?? "");
    const { text, quoted } = splitQuote(raw);
    const line = String(m.snippet || text || raw).replace(/\s+/g, " ").trim();
    const top = (tag, props) => h(tag, { class: "cv-et-top", ...props },
      h("span", { class: "cv-et-av", "aria-hidden": "true" }, initial(from.name)),
      h("span", { class: "cv-et-name ellipsis", title: from.addr || null }, untrusted(from.name, 120)),
      isOpen ? null : h("span", { class: "cv-et-line ellipsis" }, untrusted(line, 200)),
      h("span", { class: "cv-et-sp" }),
      Number.isFinite(new Date(m.at).getTime()) ? h("span", { class: "cv-et-at" }, when(m.at)) : null);
    if (!isOpen) return h("li", { class: "cv-et-msg cv-et-folded" },
      top("button", { type: "button", "aria-expanded": "false", onclick: () => { open.add(i); draw(); } }));
    const atts = Array.isArray(m.attachments) ? m.attachments : [];
    return h("li", { class: "cv-et-msg" + (latest ? " cv-et-latest" : "") },
      single || latest ? top("div") : top("button", { type: "button", "aria-expanded": "true", onclick: () => { open.delete(i); draw(); } }),
      m.to ? h("div", { class: "cv-et-to" }, "to ", untrusted(Array.isArray(m.to) ? m.to.map((/** @type {any} */ t) => person(t).name).join(", ") : person(m.to).name, 200)) : null,
      h("div", { class: "cv-et-body" }, prose(text, !!ctx.phone && latest)),
      quoted ? h("div", { class: "cv-et-quote" },
        h("button", { class: "cv-et-qbtn", type: "button", "aria-expanded": String(state.quotes.has(i)),
          onclick: () => { if (state.quotes.has(i)) state.quotes.delete(i); else state.quotes.add(i); draw(); } },
        state.quotes.has(i) ? "Hide quoted text" : "Show quoted text"),
        state.quotes.has(i) ? h("pre", { class: "cv-et-qtext" }, untrusted(quoted, 6000)) : null) : null,
      atts.length ? h("div", { class: "cv-et-atts" }, atts.map((/** @type {any} */ a) => h("div", { class: "cv-et-att" },
        icon("file", 14), h("span", { class: "cv-et-attname ellipsis" }, untrusted(a?.name ?? a, 120)), a?.size ? h("span", { class: "cv-et-attsize" }, sizeWord(a.size)) : null))) : null);
  }

  function draw() {
    const msgs = ordered(data);
    const subject = untrusted(data?.subject || "(no subject)", 200);
    const single = msgs.length === 1;
    if (data?.error) {
      put(el, head({ icon: "mail", title: subject }),
        h("div", { class: "cv-et-err", role: "alert" }, h("span", { class: "cv-mark cv-mark-failed", "aria-hidden": "true" }), "Couldn't read this thread",
          ctx.retry ? h("button", { class: "btn btn-ghost btn-sm", type: "button", onclick: () => ctx.retry?.() }, "Retry") : null));
      return;
    }
    if (data?.loading) {
      put(el, head({ icon: "mail", title: subject }),
        h("div", { class: "cv-et-skel", "aria-busy": "true" }, h("span", { class: "cv-et-bar" }), h("span", { class: "cv-et-bar cv-et-bar-short" })));
      return;
    }
    const last = msgs[0];
    const back = last ? person(last.from) : null;
    const replyTo = last?.from ? [String(last.from)] : [];
    put(el,
      head({ icon: "mail", title: subject, meta: single ? null : plural(msgs.length, "message") }),
      Array.isArray(data?.labels) && data.labels.length ? h("div", { class: "cv-et-labels" }, data.labels.map((/** @type {any} */ l) => h("span", { class: "tag" }, untrusted(l, 40)))) : null,
      h("ul", { class: "cv-et-list", role: "list" }, msgs.map((m, i) => row(m, i, i === 0, single))),
      h("div", { class: "cv-et-foot" },
        // Reply opens the compose card in the Deck, prefilled; this card sends nothing itself.
        back ? h("button", { class: "btn cv-et-reply", type: "button", "data-act": "reply",
          onclick: () => ctx.open?.(`compose:reply?to=${encodeURIComponent(replyTo.join(","))}&subject=${encodeURIComponent(/^re:/i.test(subject) ? subject : "Re: " + subject)}`) }, "Reply") : null,
        typeof data?.link === "string" && /^https:\/\//.test(data.link)
          ? h("button", { class: "btn btn-ghost cv-et-mail", type: "button", "data-act": "mail", onclick: () => ctx.open?.(data.link) }, "Open in Mail") : null));
  }

  el.update = (/** @type {any} */ d) => { data = d; draw(); };
  draw();
  return el;
}
