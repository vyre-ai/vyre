// @ts-check
// A shared "pick a GitHub repo" sheet (ADR 0041, github's final contract, work/github fb31a36e):
// search, paging, a private badge, last updated. Three callers share this one picker rather than
// three copies: Projects' "New project" > "From a GitHub repo", a project's Repos section >
// "Add a repo", and Chat's move-to-project menu > "New project from a GitHub repo…".
//
// No account connected: says so, with a link to Settings > Connections (github's own card,
// deck/views/connections.js) rather than trying to grow a sign-in flow inside the sheet.
// github.repos paging (github final contract): { repos, page, limit, more }. This picker keeps
// requesting page+1 on "Show more", replacing nothing, so a slow typist never loses earlier rows.
import { h, put, link } from "./dom.js";
import { attempt } from "./api.js";
import { icon } from "./icons.js";
import { when } from "./fmt.js";
import { openSheet } from "./sheet.js";

let styled = false;
function style() {
  if (styled || typeof document === "undefined" || !document.head) return;
  styled = true;
  document.head.append(h("link", { rel: "stylesheet", href: "/css/github-repo-picker.css" }));
}

/** @typedef {{ full_name: string, name: string, owner: string, private: boolean, default_branch: string, description: string|null, updated_at: string|null, html_url: string }} Repo */

/**
 * @param {{ title?: string, onPick: (repo: Repo, account: string) => void, attempt?: typeof attempt }} o
 * @returns {{ close: () => void }}
 */
export function openGithubRepoPicker(o) {
  style();
  const call = o.attempt || attempt;
  return openSheet({
    title: o.title || "Choose a GitHub repo",
    label: o.title || "Choose a GitHub repo",
    build(body, close) {
      const state = { accounts: /** @type {{ name: string, login: string }[]} */ ([]), account: "", q: "", page: 1, repos: /** @type {Repo[]} */ ([]), more: false, loading: false };
      const acctSel = /** @type {HTMLSelectElement} */ (h("select", { class: "input", "aria-label": "GitHub account", hidden: true }));
      const q = /** @type {HTMLInputElement} */ (h("input", { class: "input", type: "search", autocomplete: "off", spellcheck: "false", placeholder: "Search your repos", "aria-label": "Search repos" }));
      const list = h("div", { class: "rows gh-pick-list" });
      const more = h("button", { type: "button", class: "btn btn-ghost btn-sm", hidden: true }, "Show more");
      const status = h("div", { class: "small muted", role: "status" });

      const load = async (/** @type {boolean} */ append) => {
        if (state.loading) return;
        state.loading = true;
        if (!append) { state.page = 1; put(list, h("div", { class: "empty" }, "Loading…")); }
        const r = await call("github.repos", { account: state.account || undefined, q: state.q || undefined, page: state.page, limit: 30 });
        state.loading = false;
        if (r.error) { put(list, h("div", { class: "empty" }, r.error.missing ? "GitHub isn't connected here yet." : (r.error.message || "Could not list repos."))); more.hidden = true; return; }
        const rows = Array.isArray(r.data?.repos) ? r.data.repos : [];
        state.repos = append ? [...state.repos, ...rows] : rows;
        state.more = !!r.data?.more;
        drawList();
      };
      const drawList = () => {
        more.hidden = !state.more;
        if (!state.repos.length) { put(list, h("div", { class: "empty" }, state.q ? "No repos match that search." : "No repos found.")); return; }
        put(list, state.repos.map(repo => h("button", { type: "button", class: "gh-pick-row", onclick: () => { o.onPick(repo, state.account); close(); } },
          h("span", { class: "gh-pick-name" }, repo.full_name, repo.private ? h("span", { class: "tag gh-pick-private" }, icon("lock", 11), "Private") : null),
          repo.description ? h("span", { class: "small muted ellipsis" }, repo.description) : null,
          h("span", { class: "small faint" }, repo.updated_at ? `Updated ${when(new Date(repo.updated_at).getTime())}` : ""))));
      };
      more.addEventListener("click", () => { state.page++; load(true); });
      let t = 0;
      q.addEventListener("input", () => { state.q = q.value.trim(); clearTimeout(t); t = setTimeout(() => load(false), 300); });
      acctSel.addEventListener("change", () => { state.account = acctSel.value; load(false); });

      put(body, h("div", { class: "gh-pick" }, acctSel, q, list, h("div", { class: "gh-pick-more" }, more), status));

      const acctErrText = err => (err.missing ? "GitHub isn't connected here yet." : (err.message || "Could not load GitHub accounts."));
      (async () => {
        const r = await call("github.accounts");
        if (r.error) { put(list, h("div", { class: "empty" }, acctErrText(r.error))); return; }
        state.accounts = Array.isArray(r.data) ? r.data : [];
        if (!state.accounts.length) {
          const a = link("/settings#connections", { class: "link" }, "Connect one in Settings");
          a.addEventListener("click", () => close()); // fires alongside link()'s own navigation handler
          put(list, h("div", { class: "empty" }, "No GitHub account connected yet. ", a));
          return;
        }
        if (state.accounts.length > 1) {
          acctSel.hidden = false;
          put(acctSel, state.accounts.map(a => h("option", { value: a.name }, a.name)));
        }
        state.account = state.accounts[0].name;
        load(false);
      })();
    },
  });
}
