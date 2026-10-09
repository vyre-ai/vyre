import { httpFetch } from "../../lib/http.js";
// @ts-check
// Pull request reads and the two outward writes (merge, review), over GitHub's REST API with the
// project's own recorded account token. `prView` maps GitHub's answers to the payload the Deck's
// PR review card draws (CHAT.md, github -> native-core): nothing here invents a field.

const API = "https://api.github.com";
const H = token => ({ authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" });
const err = (msg, code, detail) => Object.assign(new Error(msg), { code, ...(detail ? { detail } : {}) });

async function gh(token, method, path, body) {
  const res = await httpFetch(`${API}${path}`, {
    method, headers: { ...H(token), ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(20_000),
  });
  if (res.status === 401) throw err("GitHub sign-in isn't working anymore; reconnect the account", "token_invalid");
  const text = await res.text();
  let json = null; try { json = text ? JSON.parse(text) : null; } catch { /* not json */ }
  if (!res.ok) {
    const code = res.status === 404 ? "not_found" : res.status === 405 || res.status === 409 || res.status === 422 ? "refused" : "failed";
    throw err(`GitHub said ${res.status}: ${(json && json.message) || text.slice(0, 200)}`, code, { status: res.status });
  }
  return json;
}

export const prNumber = pr => {
  const n = Number(pr);
  if (!Number.isInteger(n) || n < 1) throw err(`pr must be a pull request number, not "${String(pr).slice(0, 40)}"`, "bad_input");
  return n;
};

const CHECK_STATE = { queued: "pending", pending: "pending", in_progress: "running", waiting: "pending", requested: "pending" };
const FAIL = new Set(["failure", "timed_out", "cancelled", "action_required", "startup_failure", "stale"]);
/** A check run's state as pending|running|passed|failed. */
export function checkState(r) {
  if (r.status && r.status !== "completed") return CHECK_STATE[r.status] || "running";
  return FAIL.has(r.conclusion) ? "failed" : "passed";
}
const FILE_STATUS = { added: "added", removed: "removed", renamed: "renamed", modified: "modified", changed: "modified", copied: "added" };

/**
 * The PR review card's payload. `login` is the connected account's login (its comments are `person`);
 * `agentLogins` are never known here, so anyone else is `outside` (untrusted external text).
 */
export async function prView({ token, full_name, pr, project, login }) {
  const n = prNumber(pr);
  const base = `/repos/${full_name}`;
  const p = await gh(token, "GET", `${base}/pulls/${n}`);
  const [files, revs, issue, runs] = await Promise.all([
    gh(token, "GET", `${base}/pulls/${n}/files?per_page=100`),
    gh(token, "GET", `${base}/pulls/${n}/comments?per_page=100`),
    gh(token, "GET", `${base}/issues/${n}/comments?per_page=100`),
    gh(token, "GET", `${base}/commits/${p.head.sha}/check-runs?per_page=100`).catch(() => ({ check_runs: [] })),
  ]);
  const by = u => (u && login && u.login === login ? "person" : "outside");
  return {
    kind: "pr_review", project, pr: n, title: p.title, summary: p.body || "",
    branch: { from: p.head.ref, to: p.base.ref },
    state: p.merged ? "merged" : p.state === "closed" ? "closed" : "open",
    merged_by: p.merged_by ? p.merged_by.login : null, merged_at: p.merged_at || null,
    html_url: p.html_url, mergeable: p.mergeable ?? null,
    checks: (runs.check_runs || []).map(r => ({ name: r.name, state: checkState(r), url: r.html_url || null })),
    files: (files || []).map(f => ({
      path: f.filename, status: FILE_STATUS[f.status] || "modified", additions: f.additions, deletions: f.deletions,
      ...(f.patch ? { patch: f.patch } : {}), ...(f.blob_url ? { href: f.blob_url } : {}),
      ...(!f.patch && f.additions + f.deletions === 0 && f.status !== "renamed" ? { binary: true } : {}),
    })),
    comments: [
      ...(revs || []).map(c => ({ id: c.id, author: c.user && c.user.login, by: by(c.user), path: c.path, line: c.line ?? c.original_line ?? undefined, text: c.body })),
      ...(issue || []).map(c => ({ id: c.id, author: c.user && c.user.login, by: by(c.user), text: c.body })),
    ],
  };
}

/** Merge a PR (never deletes the branch). `method` is merge|squash|rebase, default merge. */
export async function prMerge({ token, full_name, pr, method = "merge" }) {
  if (!["merge", "squash", "rebase"].includes(method)) throw err("method must be merge, squash or rebase", "bad_input");
  const n = prNumber(pr);
  const r = await gh(token, "PUT", `/repos/${full_name}/pulls/${n}/merge`, { merge_method: method });
  return { merged: Boolean(r && r.merged), sha: r && r.sha, message: r && r.message };
}

/** A review (APPROVE, REQUEST_CHANGES, COMMENT), or a reply to one review comment when `in_reply_to` is set. */
export async function prReview({ token, full_name, pr, event, body, in_reply_to }) {
  const n = prNumber(pr);
  if (!["APPROVE", "REQUEST_CHANGES", "COMMENT"].includes(event)) throw err("event must be APPROVE, REQUEST_CHANGES or COMMENT", "bad_input");
  const text = typeof body === "string" ? body.trim() : "";
  if (event !== "APPROVE" && !text) throw err("a comment or change request needs text", "bad_input");
  if (in_reply_to != null) {
    const id = Number(in_reply_to);
    if (!Number.isInteger(id) || id < 1) throw err("in_reply_to must be a review comment id", "bad_input");
    const r = await gh(token, "POST", `/repos/${full_name}/pulls/${n}/comments/${id}/replies`, { body: text });
    return { id: r.id, event: "COMMENT", url: r.html_url };
  }
  const r = await gh(token, "POST", `/repos/${full_name}/pulls/${n}/reviews`, { event, ...(text ? { body: text } : {}) });
  return { id: r.id, event, state: r.state, url: r.html_url };
}

/**
 * Open a pull request from a pushed branch. `head` is the branch name on the repo itself (a
 * session's vyre/<id> branch, pushed first with github.session.push); `base` defaults to the
 * project's default branch. GitHub answers 422 when the branch isn't there yet, reported as refused.
 */
export async function prOpen({ token, full_name, head, base, title, body, draft }) {
  const t = typeof title === "string" ? title.trim() : "";
  if (!t || t.length > 256) throw err("a pull request needs a title of at most 256 characters", "bad_input");
  if (!/^[A-Za-z0-9._\/-]{1,200}$/.test(String(head || "")) || String(head).startsWith("-") || String(head).includes("..")) throw err("head must be a branch name", "bad_input");
  if (!/^[A-Za-z0-9._\/-]{1,200}$/.test(String(base || "")) || String(base).startsWith("-") || String(base).includes("..")) throw err("base must be a branch name", "bad_input");
  if (head === base) throw err("head and base are the same branch", "bad_input");
  const r = await gh(token, "POST", `/repos/${full_name}/pulls`, { title: t, head, base, ...(typeof body === "string" && body ? { body } : {}), ...(draft ? { draft: true } : {}) });
  return { pr: r.number, url: r.html_url, state: r.state, draft: Boolean(r.draft), head, base };
}

/** Latest review state per reviewer, newest wins; a bare comment never overrides an approval or a change request. */
function latestReviews(reviews) {
  const by = new Map();
  for (const r of reviews || []) {
    if (!r.user || !["APPROVED", "CHANGES_REQUESTED", "DISMISSED", "COMMENTED"].includes(r.state)) continue;
    const prev = by.get(r.user.login);
    if (r.state === "COMMENTED" && prev && prev !== "COMMENTED") continue;
    by.set(r.user.login, r.state);
  }
  return [...by].map(([login, state]) => ({ by: login, state: state === "APPROVED" ? "approved" : state === "CHANGES_REQUESTED" ? "changes_requested" : state === "DISMISSED" ? "dismissed" : "commented" }));
}

/**
 * Where a pull request stands: state, whether it merges cleanly, its checks and reviews, and one
 * `ready` verdict (open, not a draft, mergeable, no check failed or still running, nobody asked for
 * changes). Read only; no text from the PR's own body or comments.
 */
export async function prStatus({ token, full_name, pr, project }) {
  const n = prNumber(pr);
  const base = `/repos/${full_name}`;
  const p = await gh(token, "GET", `${base}/pulls/${n}`);
  const [runs, reviews] = await Promise.all([
    gh(token, "GET", `${base}/commits/${p.head.sha}/check-runs?per_page=100`).catch(() => ({ check_runs: [] })),
    gh(token, "GET", `${base}/pulls/${n}/reviews?per_page=100`).catch(() => []),
  ]);
  const checks = (runs.check_runs || []).map(r => ({ name: r.name, state: checkState(r), url: r.html_url || null }));
  const count = s => checks.filter(c => c.state === s).length;
  const rv = latestReviews(reviews);
  const state = p.merged ? "merged" : p.state === "closed" ? "closed" : "open";
  const ready = state === "open" && !p.draft && p.mergeable === true && count("failed") === 0 && count("running") === 0 && count("pending") === 0 && !rv.some(r => r.state === "changes_requested");
  return {
    project, pr: n, state, draft: Boolean(p.draft), mergeable: p.mergeable ?? null, mergeable_state: p.mergeable_state || null,
    branch: { from: p.head.ref, to: p.base.ref }, html_url: p.html_url,
    checks, checks_summary: { passed: count("passed"), failed: count("failed"), running: count("running"), pending: count("pending") },
    reviews: rv, ready,
  };
}

/** Every comment on a PR (conversation, inline review comments, review bodies), oldest first. Text is OUTSIDE text. */
export async function prComments({ token, full_name, pr, project, login, since }) {
  const n = prNumber(pr);
  const base = `/repos/${full_name}`;
  const [issue, inline, reviews] = await Promise.all([
    gh(token, "GET", `${base}/issues/${n}/comments?per_page=100`),
    gh(token, "GET", `${base}/pulls/${n}/comments?per_page=100`),
    gh(token, "GET", `${base}/pulls/${n}/reviews?per_page=100`).catch(() => []),
  ]);
  const by = u => (u && login && u.login === login ? "person" : "outside");
  const all = [
    ...(issue || []).map(c => ({ id: c.id, kind: "conversation", url: c.html_url, author: c.user && c.user.login, by: by(c.user), text: c.body || "", at: c.created_at })),
    ...(inline || []).map(c => ({ id: c.id, kind: "inline", url: c.html_url, author: c.user && c.user.login, by: by(c.user), path: c.path, line: c.line ?? c.original_line ?? undefined, in_reply_to: c.in_reply_to_id ?? undefined, text: c.body || "", at: c.created_at })),
    ...(reviews || []).filter(r => r.body).map(r => ({ id: r.id, kind: "review", url: r.html_url, state: String(r.state || "").toLowerCase(), author: r.user && r.user.login, by: by(r.user), text: r.body, at: r.submitted_at })),
  ].sort((a, b) => String(a.at).localeCompare(String(b.at)));
  const cut = typeof since === "string" && since ? all.filter(c => String(c.at) > since) : all;
  return { project, pr: n, outside: true, comments: cut };
}

const issueRow = i => ({ number: i.number, title: i.title, state: i.state, author: i.user && i.user.login, labels: (i.labels || []).map(l => (typeof l === "string" ? l : l.name)), comments: i.comments, url: i.html_url, updated_at: i.updated_at });

/** Open (or closed, or all) issues of a repo, newest activity first; pull requests are left out. Titles are outside text. */
export async function issueList({ token, full_name, project, state = "open", q, limit = 30 }) {
  if (!["open", "closed", "all"].includes(state)) throw err("state must be open, closed or all", "bad_input");
  const max = Math.min(Math.max(Number(limit) || 30, 1), 50);
  let items;
  if (typeof q === "string" && q.trim()) {
    const term = q.trim().replace(/[^A-Za-z0-9 ._-]/g, " ").slice(0, 100);
    const r = await gh(token, "GET", `/search/issues?per_page=${max}&sort=updated&q=${encodeURIComponent(`${term} repo:${full_name} is:issue ${state === "all" ? "" : `is:${state}`}`.trim())}`);
    items = r.items || [];
  } else {
    items = await gh(token, "GET", `/repos/${full_name}/issues?state=${state}&per_page=${max}&sort=updated`);
  }
  return { project, outside: true, issues: (items || []).filter(i => !i.pull_request).slice(0, max).map(issueRow) };
}

/** One issue with its first comments. Body and comments are OUTSIDE text. */
export async function issueGet({ token, full_name, project, issue, login }) {
  const n = prNumber(issue);
  const base = `/repos/${full_name}/issues/${n}`;
  const i = await gh(token, "GET", base);
  if (i.pull_request) throw err(`#${n} is a pull request; use github.project.pr.get`, "bad_input");
  const cs = await gh(token, "GET", `${base}/comments?per_page=50`).catch(() => []);
  return { project, outside: true, ...issueRow(i), body: i.body || "", assignees: (i.assignees || []).map(a => a.login),
    comments: (cs || []).map(c => ({ id: c.id, author: c.user && c.user.login, by: login && c.user && c.user.login === login ? "person" : "outside", text: c.body || "", at: c.created_at })) };
}

/** The numbers of the OPEN pull requests whose head is `branch` on the repo itself (a session's vyre/<id> branch). */
export async function openPrsForBranch({ token, full_name, branch }) {
  if (!/^[A-Za-z0-9._\/-]{1,200}$/.test(String(branch || "")) || String(branch).startsWith("-") || String(branch).includes("..")) throw err("branch must be a branch name", "bad_input");
  const owner = full_name.split("/")[0];
  const rows = await gh(token, "GET", `/repos/${full_name}/pulls?state=open&per_page=30&head=${encodeURIComponent(`${owner}:${branch}`)}`);
  return (rows || []).filter(r => r && r.head && r.head.ref === branch).map(r => r.number);
}
