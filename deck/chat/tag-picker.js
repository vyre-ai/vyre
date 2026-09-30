// @ts-check
// The "#" tag picker, one component for the composer and the new-session sheet: one universal tag over
// everything a message can mention (mentions.search: vault items, artifacts, files, repos, projects; names
// and hints only, never a value), grouped by kind in the shared list menu. A pick writes `#Name` into the
// words (quoted when it has spaces) and remembers {kind, id}; a chip under the box shows each tag still in the
// text, with a way to take it out; take() gives the turn's `mentions: [{kind, id, name}]` and forgets them.
// Where "#" is the first character it opens too: "Save a memory" is /remember now.

import { h } from "../js/dom.js";
import { icon } from "../js/icons.js";
import { findVaultMention, applyVault, vaultTokens } from "./core/composer-state.js";
import { keysLine } from "./pickers.js";

/** The order groups show in; a kind the box adds later follows, by name. */
const TAG_ORDER = ["vault", "artifact", "drive", "github", "project", "session", "teammate"];

/** mentions.search's answer as one flat list: results, or groups of results. Names and hints only. @param {any} d */
export function tagRows(d) {
  const list = Array.isArray(d) ? d : Array.isArray(d?.results) ? d.results : Array.isArray(d?.groups) ? d.groups.flatMap((/** @type {any} */ g) => (g?.results || g?.items || []).map((/** @type {any} */ x) => ({ kind: g.kind, ...x }))) : [];
  const rank = (/** @type {string} */ k) => { const n = TAG_ORDER.indexOf(k); return n < 0 ? TAG_ORDER.length : n; };
  return list.map((/** @type {any} */ x) => ({ kind: String(x?.kind ?? ""), id: String(x?.id ?? x?.name ?? ""), name: String(x?.name ?? ""), hint: String(x?.hint ?? ""), label: String(x?.label ?? x?.kind ?? "") }))
    .filter((/** @type {any} */ x) => x.kind && x.id && x.name)
    .sort((/** @type {any} */ a, /** @type {any} */ b) => rank(a.kind) - rank(b.kind) || a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name));
}

/**
 * @param {{ ta: HTMLTextAreaElement, menu: import("./pickers.js").ListMenu, caret: () => number, setValue: (v: string, at?: number) => void,
 *   attempt: (tool: string, input?: any) => Promise<{ data?: any, error?: any }>, use?: (tool: string, fn: () => Promise<any>) => Promise<any> }} o
 */
export function tagPicker({ ta, menu, caret, setValue, attempt, use = (_t, fn) => fn() }) {
  /** What was picked, by the name written after the "#". */
  const tags = /** @type {Map<string, { kind: string, id: string, name: string }>} */ (new Map());
  let seq = 0, timer = /** @type {any} */ (null);

  /** Open (or refresh) the picker for the "#" at the caret. @param {import("./core/composer-state.js").MentionRange} range */
  function show(range) {
    clearTimeout(timer);
    const mine = ++seq;
    // A short wait so a fast typist asks once; no query still lists what is at hand.
    timer = setTimeout(async () => {
      const r = await use("mentions.search", () => attempt("mentions.search", { q: range.query, limit: 30 }));
      if (mine !== seq) return;
      // No provider on this box, or the text moved on while it searched: nothing is offered that does not work.
      if (r.error || !findVaultMention(ta.value, caret())) { if (menu.kind === "vault") menu.close(); return; }
      const rows = tagRows(r.data).slice(0, 24);
      menu.setKind("vault");
      menu.open(rows.map(v => ({ key: v.kind + ":" + v.id, group: v.label || v.kind, value: v, render: () => [h("span", { class: "cv-menu-name" }, "#" + v.name),
        v.hint ? h("span", { class: "cv-menu-hint" }, v.hint) : null] })),
      row => pick(row.value), "Tag", rows.length ? keysLine(["↑↓", "move"], ["⏎", "tag"], ["Esc", "close"]) : "Nothing by that name");
    }, 120);
    timer?.unref?.();
  }
  /** @param {{ kind: string, id: string, name: string }} v */
  function pick(v) {
    const range = findVaultMention(ta.value, caret());
    menu.close();
    if (!range) return;
    tags.set(v.name, { kind: v.kind, id: v.id, name: v.name });
    const r = applyVault(ta.value, range, v.name);
    setValue(r.text, r.caret);
    ta.focus();
  }
  /** Each "#name" still in the draft that was picked here. */
  const chips = () => (tags.size ? vaultTokens(ta.value, new Set(tags.keys())).map(t => ({ ...t, ...tags.get(t.name) })) : []);

  return {
    show, pick, chips,
    /** The "#" at the caret, if any, opens the picker; true when it did. */
    suggest() { const vm = findVaultMention(ta.value, caret()); if (vm) { show(vm); return true; } return false; },
    /** The chips as one row of small buttons, or null with no tag in the text. @param {string} [cls] */
    chipsEl(cls = "composer-scopes composer-vault") {
      const vts = chips();
      if (!vts.length) return null;
      return h("span", { class: cls, role: "list", "aria-label": "Tags on this message" },
        vts.map(t => h("span", { class: "btn btn-ghost btn-sm composer-scope composer-vault-chip", role: "listitem", "data-vault": t.name, "data-kind": t.kind, title: t.kind === "vault" ? "This message can use #" + t.name + " for this session. The value is never shown." : "#" + t.name + " goes with this message" },
          icon(t.kind === "vault" ? "key" : "file", 12), "#" + t.name,
          h("button", { type: "button", "aria-label": "Remove #" + t.name, onclick: () => { const cur = chips().find(x => x.name === t.name); if (cur) setValue((ta.value.slice(0, cur.start) + ta.value.slice(cur.end)).replace(/  +/g, " "), cur.start); ta.focus(); } }, "×"))));
    },
    /** The turn's mentions, and forget them. */
    take() { const m = chips().map(t => ({ kind: t.kind, id: t.id, name: t.name })); tags.clear(); return m; },
    clear() { tags.clear(); },
    signature: () => chips().map(t => t.name),
  };
}
