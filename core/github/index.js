// @ts-check
// github: native "Sign in with GitHub" (device flow), repos, a project from a repo, adding a repo
// to an existing project, and per-workspace detection (ADR 0041). No explicit "link": a project's
// repos are either its primary one (set once, by github.project) or added workspaces
// (github.project.add-repo); github.project.detect reads what's on disk, nothing is recorded by
// hand.
//
// Nothing here is model-reachable in 0.1.1: connect, remove, repos and project are people plus
// two named modules (sessions, threads); the worktree tools are sessions-only and internal. No
// Gate sender is registered, because nothing here sends anything outward yet (no issues, no PRs).

import fs from "node:fs";
import path from "node:path";
import { connector } from "./connect.js";
import { MIGRATIONS, store, projectStore, forOne } from "./accounts.js";
import { prView, prMerge, prReview } from "./pr.js";
import { safeSegment, cloneRepo, worktreeAdd, worktreeRemove, originFullName, folderGitState, sanitizeRemoteUrl, defaultBranchOf, pushSession, localInit, sessionHistory, sessionUndo, sessionRedo } from "./git.js";

const str = { type: "string" };
const obj = (properties, required = []) => ({ type: "object", properties, required });
const PEOPLE = ["cli", "local", "deck", "capsule"];
/** Coarse gate: any person, or any module (narrowed per-tool below by exact caller name). */
const PEOPLE_AND_MODULES = [...PEOPLE, "module"];
// Agents can do everything the person can (0.2 charter, 30 Sep binding): an MCP caller ("mcp", or
// "mcp:agent:<name>" for a specific agent/teammate) is the person's own agent acting for them,
// never a cross-module call - this is a different axis from PEOPLE_AND_MODULES above, which is
// about which other Vyre MODULE may call a tool, not whether a model may.
const PEOPLE_AND_AGENTS = [...PEOPLE, "mcp"];
// "launch" is a team, not a module - no module.json in this repo is named that (core/switchboard's
// is "threads"). Named an allowlist entry that way once, on a guess; the reviewer caught that a
// third-party module could just name itself "sessions" or "threads" too, since a module's *name*
// is self-declared in its own manifest, never proof of where its code actually lives - only the
// registry's own firstParty flag (derived from that, lib/caller.js) is (reviewer, 5b1c69f1
// review's follow-up, and the lead independently). checkModuleCaller below requires both: the
// name is one of the ones a tool actually named, AND meta.firstParty === true.
// Reviewer's follow-up on the rename above: `threads` (the switchboard) only actually calls
// `.project.of`, `.session.worktree` and `.session.cleanup` - resolving whether a project has a
// repo, and the worktree mechanics themselves. `github.repos`, `github.project` and `.detect` are
// person surfaces only (`launch`'s screens call them as `deck`/`cli`/etc, never as a module), so
// `threads` never belonged on those three; narrowed back down.
/** Which module callers each tool actually accepts, checked against the raw meta.caller. */
const MODULE_CALLERS = {
  "github.repos": new Set(["module:sessions"]),
  "github.project.of": new Set(["module:sessions", "module:threads"]),
  "github.project.local-init": new Set(["module:projects", "module:sessions", "module:threads"]),
};
// Also accepted on `.session.worktree`/`.cleanup`, since the switchboard (`threads`) is the one
// that actually resolves a session's cwd through them (ADR 0041 section 5); kept alongside
// `sessions` for the stage/0.1.1 fold (integrator's branch already carries both).
const SESSION_ONLY = new Set(["module:sessions", "module:threads"]);

const fail = (msg, code = "bad_input", detail) => Object.assign(new Error(msg), { code, ...(detail ? { detail } : {}) });
const named = v => (typeof v === "string" && v ? v : undefined);

/**
 * Refuse a module caller this tool did not name, or one the registry didn't mark first-party.
 * A module's name is whatever its own manifest claims - on a Mac, a model can write into the
 * home modules folder, so a name match alone (`module:sessions`, say) is not proof of who is
 * actually calling; `meta.firstParty` is the registry's own signal, set from where the module's
 * code lives on disk, never something a caller can claim for itself. People are never refused
 * here (a person's own caller string, `cli`/`deck`/etc., never starts with `module:`).
 */
function checkModuleCaller(tool, meta, allowed) {
  const caller = String((meta && meta.caller) || "");
  if (!caller.startsWith("module:")) return;
  if (!allowed.has(caller) || meta.firstParty !== true) {
    throw fail(`${tool} is the person's own door plus ${[...allowed].join(", ")}, not ${caller}'s`, "denied");
  }
}

/** @type {{ start(ctx: any): Promise<{ stop(): Promise<void> }> }} */
export default {
  async start(ctx) {
    ctx.store.migrate(MIGRATIONS);
    const accounts = store(ctx.store.db);
    const projects = projectStore(ctx.store.db);
    const now = () => Date.now();
    // GitHub CLI's own public client id (0.2, lead ruling 30 Sep - "the user asked for GitHub's
    // own managed app"): declared safe to embed in GitHub CLI's own source, the same id every
    // `gh auth login` uses. No app of Vyre's, no secret to hold, and no verification question,
    // since it's GitHub's own first-party app, not ours. A fine-grained personal access token,
    // pasted instead of signing in, is the narrower alternative (github.connect's own docs).
    const clientId = process.env.VYRE_GITHUB_OAUTH_CLIENT_ID || "178c6fc778ccc68e1d6a";

    const signIn = connector({
      clientId,
      taken: name => Boolean(accounts.get(name)),
      // The item a sign-in will make must be free, or one this module made before.
      blocked: async item => {
        const r = await ctx.call("vault.list", { filter: item });
        const old = r.data?.items?.find(x => x.name === item);
        return old && old.origin !== "module:github" ? `the vault already has an item named ${item} that Vyre's GitHub sign-in did not make; rename or delete it first` : null;
      },
      save: async (item, fields) => {
        const r = await ctx.call("vault.put", { name: item, kind: "pat", description: "GitHub sign-in (made by Vyre)", fields, grants: ["github"] });
        if (r.error) throw fail(`could not save the sign-in in the vault: ${r.error.message}`, r.error.code || "vault");
      },
      add: async acct => {
        accounts.put(acct, now());
        ctx.events.emit("github.added", { name: acct.name, login: acct.login });
      },
      emit: (type, payload) => ctx.events.emit(type, payload),
      log: (m, x) => ctx.log(m, x),
    });

    ctx.tool("github.connect", {
      description: `Start "Sign in with GitHub": a device-flow code. Returns { id, user_code, verification_uri, verification_uri_complete?, expires_in, interval }: show the code and open verification_uri (or verification_uri_complete on a phone). Vyre polls on its own until the person finishes or it expires; nothing else to call. Asks for the "repo" scope (full read/write on every repo the account can reach): GitHub's device flow has no narrower option; a later release moves to a GitHub App with per-repo access.`,
      input: obj({ name: str }, ["name"]),
      callers: PEOPLE,
      run: input => signIn.start(input),
    });

    ctx.tool("github.connect.cancel", {
      description: "Cancel an open sign-in.",
      input: obj({ id: str }, ["id"]),
      callers: PEOPLE,
      run: input => signIn.cancel(input),
    });

    ctx.tool("github.accounts", {
      description: "The GitHub accounts Vyre can use: name, login and avatar, never a token.",
      input: obj({}),
      callers: PEOPLE,
      run: async () => accounts.all().map(a => ({ name: a.name, login: a.login, avatar_url: a.avatar_url })),
    });

    ctx.tool("github.remove", {
      description: "Disconnect a GitHub account: removes Vyre's own vault item and account row. Never revokes the token at GitHub (0.2, lead ruling 30 Sep): the sign-in shares GitHub CLI's own client id with every real `gh` install, so revoking it would sign the person's own gh out on every other machine and CI runner too. The token itself, and whether it still works elsewhere, stays the person's own business, at github.com/settings/applications if they ever want it gone entirely.",
      input: obj({ name: str }, ["name"]),
      callers: PEOPLE,
      run: async ({ name }) => {
        const acct = accounts.get(name);
        if (!acct) return { removed: false };
        await ctx.call("vault.delete", { name: acct.item }).catch(() => {});
        accounts.remove(name);
        ctx.events.emit("github.removed", { name });
        return { removed: true };
      },
    });

    ctx.tool("github.repos", {
      description: "The account's repos, for a picker: { repos: [{ full_name, name, owner, private, default_branch, description, updated_at, html_url }], page, limit, more }, never a clone URL with a token in it. Without q, page is GitHub's own paging (page 1, 2, ... at limit per page, newest-updated first). With q (matched against full_name and description), page/limit paginate the matches instead, since GitHub's own listing has no text search.",
      input: obj({ account: str, q: str, limit: { type: "integer" }, page: { type: "integer" } }),
      callers: PEOPLE_AND_MODULES,
      run: async ({ account: a, q, limit, page }, meta = {}) => {
        checkModuleCaller("github.repos", meta, MODULE_CALLERS["github.repos"]);
        const acct = forOne(accounts.all(), named(a));
        const token = await ctx.vault.fetch(acct.item, { field: "token" });
        const n = Number.isInteger(limit) ? Math.min(100, Math.max(1, limit)) : 30;
        const p = Number.isInteger(page) && page > 0 ? page : 1;
        const words = named(q) ? q.toLowerCase() : null;
        if (!words) {
          const rows = await listReposPage(token, p, n);
          return { repos: rows, page: p, limit: n, more: rows.length === n };
        }
        // No server-side text search exists on /user/repos: scan pages (newest-updated first)
        // until there are enough matches to answer this page, with a little headroom to know
        // whether a next page exists, capped so one search can never fetch without bound.
        const matches = [];
        const want = p * n + 1;
        for (let gp = 1; gp <= 10 && matches.length < want; gp++) {
          const rows = await listReposPage(token, gp, 100);
          for (const r of rows) if (r.full_name.toLowerCase().includes(words) || (r.description || "").toLowerCase().includes(words)) matches.push(r);
          if (rows.length < 100) break;
        }
        const start = (p - 1) * n;
        return { repos: matches.slice(start, start + n), page: p, limit: n, more: matches.length > start + n };
      },
    });

    /** One page of GET /user/repos, newest-updated first, mapped to the picker's shape. */
    async function listReposPage(token, page, perPage) {
      const res = await fetch(`https://api.github.com/user/repos?affiliation=owner,collaborator,organization_member&sort=updated&per_page=${perPage}&page=${page}`,
        { headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json" }, signal: AbortSignal.timeout(15_000) });
      if (!res.ok) throw fail(`GitHub answered ${res.status} listing repos.`, "refused");
      const rows = await res.json();
      if (!Array.isArray(rows)) return [];
      return rows.map(r => ({ full_name: r.full_name, name: r.name, owner: r.owner && r.owner.login, private: Boolean(r.private),
        default_branch: r.default_branch, description: r.description || null, updated_at: r.updated_at, html_url: r.html_url,
        clone_url: r.clone_url }));
    }

    /** GET /repos/{full_name} raw, mapped down to what detect/project/add-repo need. */
    function mapRepo(r) {
      return { full_name: r.full_name, name: r.name, default_branch: r.default_branch, clone_url: r.clone_url, html_url: r.html_url, private: Boolean(r.private) };
    }

    /**
     * GET /repos/{full_name}: `{ info, tokenBroken }`. `info` is null when the repo isn't found
     * (or isn't reachable) either way. `tokenBroken` is true exactly when the account's own
     * credentialed request came back 401 - GitHub validates whatever credential is offered
     * before ever falling back to public access, so a broken or revoked token 401s outright even
     * for a repo anyone could read anonymously. That anonymous retry still runs (so a dead token
     * doesn't block reading a public repo), but `tokenBroken` is never dropped on the floor: a
     * caller that resolves a repo *through an account* (`accountFor`, `github.project`,
     * `.add-repo`) must emit `github.token-invalid` and, for `accountFor`, never credit that
     * account with reaching the repo just because the anonymous read happened to work (reviewer,
     * 119ef290 review, LOW - the anonymous retry must not silently hide a revoked token).
     */
    async function getRepo(token, full_name) {
      const url = `https://api.github.com/repos/${full_name}`;
      const accept = "application/vnd.github+json";
      const authed = await fetch(url, { headers: { authorization: `Bearer ${token}`, accept }, signal: AbortSignal.timeout(15_000) });
      if (authed.status !== 401) return { info: authed.ok ? mapRepo(await authed.json()) : null, tokenBroken: false };
      if (!token) return { info: null, tokenBroken: false };
      const anon = await fetch(url, { headers: { accept }, signal: AbortSignal.timeout(15_000) });
      return { info: anon.ok ? mapRepo(await anon.json()) : null, tokenBroken: true };
    }

    /**
     * `github.project`/`.add-repo`'s shared repo resolution: emits `github.token-invalid` when
     * the account's own token is what failed, and throws a distinct, clear error ("reconnect
     * this account") rather than a vague "not found" when that broken token is *also* why the
     * repo couldn't be read at all (most likely a private repo the anonymous fallback can't see).
     */
    async function resolveRepo(acct, token, full_name) {
      const { info, tokenBroken } = await getRepo(token, full_name);
      if (tokenBroken) ctx.events.emit("github.token-invalid", { name: acct.name });
      if (info) return info;
      throw tokenBroken
        ? fail(`${acct.name}'s GitHub sign-in isn't working anymore; reconnect it and try again.`, "token_invalid")
        : fail(`GitHub does not show a repo at ${full_name} for ${acct.login}.`, "refused");
    }

    /** Every folder a project owns (home plus every workspace), deduplicated, or null when there is no such project. */
    async function projectFolders(project) {
      const p = await projectRow(project);
      if (!p) return null;
      return [...new Set([p.home, ...(p.workspaces || [])])];
    }

    /** The `projects` module's own row for a slug or name, asked through its contract, never its table. */
    async function projectRow(project) {
      const r = await ctx.call("projects.list", {});
      if (r.error) throw fail(r.error.message, r.error.code || "failed");
      const rows = (r.data && r.data.projects) || [];
      return rows.find(x => x.slug === project || x.name === project) || null;
    }

    /**
     * `from_thread`'s shape (a UUID) AND that the chat actually exists (`threads.get`, the same
     * lookup `projects.create`'s own validation uses, `native-core`) - both checked BEFORE ever
     * cloning, so a typo or a made-up id fails fast with a plain error instead of only surfacing
     * once `projects.create` gets to it after a real clone has already happened (lead + reviewer,
     * 9cf93817/e723df32 review: the earlier fix deleted the clone on that later failure instead,
     * which broke the user's binding no-auto-delete rule - reverted; see `github.project`'s own
     * failure handling below for what replaced it).
     */
    async function checkedThreadId(from_thread) {
      const s = named(from_thread);
      if (!s) return undefined;
      if (!UUID_RE.test(s)) throw fail(`from_thread must be a chat's id (a UUID), not "${s.slice(0, 60)}"`);
      const r = await ctx.call("threads.get", { thread: s, limit: 1 });
      if (r.error || !r.data || !r.data.thread) throw fail(`from_thread names a chat that doesn't exist: ${s}`, "not_found");
      return s;
    }

    /**
     * The GitHub account that can reach `full_name`, or null - checked once per full_name, first
     * match wins. An account whose token is broken is never credited with reaching anything here,
     * even when the repo happens to be public and an anonymous read would have worked: `detect`
     * showing "this account can reach it" is exactly the false confidence a revoked or expired
     * token must not get away with (reviewer, 119ef290 review, LOW).
     */
    async function accountFor(full_name, cache) {
      if (cache.has(full_name)) return cache.get(full_name);
      let match = null;
      for (const acct of accounts.all()) {
        let token;
        try { token = await ctx.vault.fetch(acct.item, { field: "token" }); } catch { continue; }
        const { info, tokenBroken } = await getRepo(token, full_name).catch(() => ({ info: null, tokenBroken: false }));
        if (tokenBroken) { ctx.events.emit("github.token-invalid", { name: acct.name }); continue; }
        if (info) { match = { account: acct.name, full_name: info.full_name, default_branch: info.default_branch }; break; }
      }
      cache.set(full_name, match);
      return match;
    }

    ctx.tool("github.project.of", {
      description: "Which GitHub account and repo a project came from, or null.",
      input: obj({ project: str }, ["project"]),
      callers: PEOPLE_AND_MODULES,
      run: async ({ project }, meta = {}) => {
        checkModuleCaller("github.project.of", meta, MODULE_CALLERS["github.project.of"]);
        return projects.get(project) || null;
      },
    });

    ctx.tool("github.project", {
      description: "Make a BRAND-NEW project from a repo: clones it and creates the project, recording the repo as the project's primary GitHub repo (what a session's worktree is made from, ADR 0041 section 5). `repo` is owner/name or a full GitHub URL. `from_thread?` is an existing chat's id (a UUID, checked for shape and existence before anything is cloned), passed straight through to `projects.create` (which validates and normalises it again on its own side): the new project's avatar_seed becomes that chat's id and the chat is filed into it, so starting a GitHub project from a loose chat keeps its tile instead of getting a fresh one. If `projects.create` still fails after the clone, the clone is left exactly as it is (the user's binding no-auto-delete rule) and its path is in the error, for a person to use or remove by hand. To add a repo to a project that already exists instead, use github.project.add-repo.",
      input: obj({ name: str, repo: str, account: str, from_thread: str }, ["repo"]),
      callers: PEOPLE,
      run: async ({ name, repo, account: a, from_thread }) => {
        const fromThread = await checkedThreadId(from_thread);
        const acct = forOne(accounts.all(), named(a));
        const token = await ctx.vault.fetch(acct.item, { field: "token" });
        const full_name = repoName(repo);
        const info = await resolveRepo(acct, token, full_name);
        const projectsDir = ctx.config && ctx.config.projectsDir;
        if (!projectsDir) throw fail("this device has no projects folder configured", "config");
        const cloned = await cloneRepo({ projectsDir, name: info.name, url: info.clone_url, token });
        const out = await ctx.call("projects.create", { name: name || info.name, home: cloned.path, ...(fromThread ? { from_thread: fromThread } : {}) });
        if (out.error) {
          throw fail(`${out.error.message} The clone at ${cloned.path} was left in place, nothing here deletes it automatically; use it or remove it yourself.`,
            out.error.code || "failed", { path: cloned.path });
        }
        const slug = out.data && out.data.slug;
        projects.put({ project: slug, account: acct.name, full_name, default_branch: info.default_branch, home: cloned.path }, now());
        return { project: slug, home: cloned.path, full_name, default_branch: info.default_branch };
      },
    });

    ctx.tool("github.project.add-repo", {
      description: "Add a GitHub repo to an EXISTING project as a brand-new workspace folder: clones it fresh under the projects folder and registers it through projects.add-workspace. Never touches the project's other folders. `repo` is owner/name or a full GitHub URL; `folder?` names the new folder (defaults to the repo's own name, a `-2`/`-3` suffix if that name is already taken). If `projects.add-workspace` fails after the clone, the clone is left exactly as it is (the user's binding no-auto-delete rule) and its path is in the error. This repo does not become the project's primary GitHub repo (that's set once, by github.project or the project's own first repo) - a session's worktree is still made from the primary repo; a worktree for an added repo is 0.1.2. People only, never a model.",
      input: obj({ project: str, repo: str, account: str, folder: str }, ["project", "repo"]),
      callers: PEOPLE,
      run: async ({ project, repo, account: a, folder }) => {
        const row = await projectRow(project);
        if (!row) throw fail(`no project named ${project}`, "not_found");
        const acct = forOne(accounts.all(), named(a));
        const token = await ctx.vault.fetch(acct.item, { field: "token" });
        const full_name = repoName(repo);
        const info = await resolveRepo(acct, token, full_name);
        const projectsDir = ctx.config && ctx.config.projectsDir;
        if (!projectsDir) throw fail("this device has no projects folder configured", "config");
        const cloned = await cloneRepo({ projectsDir, name: named(folder) || info.name, url: info.clone_url, token });
        const out = await ctx.call("projects.add-workspace", { project, folder: cloned.path });
        if (out.error) {
          throw fail(`${out.error.message} The clone at ${cloned.path} was left in place, nothing here deletes it automatically; use it or remove it yourself.`,
            out.error.code || "failed", { path: cloned.path });
        }
        return { project, folder: cloned.path, full_name, default_branch: info.default_branch };
      },
    });

    ctx.tool("github.project.detect", {
      description: "Per workspace: for each folder a project owns (its home plus every workspace it was given), whether it's a git repo, its remotes, and for any remote that's a GitHub URL, owner/repo plus whether one of the connected accounts can reach it. Read-only: local-only git reads (no network git call, no token used for git), plus one GitHub REST call per distinct repo found across every remote, cached so the same repo is never checked twice. Changes nothing, needed whichever way the project/repo model lands.",
      input: obj({ project: str }, ["project"]),
      callers: PEOPLE,
      run: async ({ project }) => {
        const folders = await projectFolders(project);
        if (!folders) throw fail(`no project named ${project}`, "not_found");
        const cache = new Map();
        const workspaces = [];
        for (const folder of folders) {
          const state = await folderGitState(folder);
          if (!state.isRepo) { workspaces.push({ folder, isRepo: false, remotes: [] }); continue; }
          const remotes = [];
          for (const r of state.remotes) {
            const full_name = originFullName(r.url);
            const match = full_name ? await accountFor(full_name, cache) : null;
            // Never the raw URL: a folder cloned by hand as https://user:TOKEN@github.com/...
            // would otherwise send that credential straight back out through this tool
            // (reviewer, e5a612c0 review, MEDIUM).
            remotes.push({ name: r.name, url: sanitizeRemoteUrl(r.url), full_name, match });
          }
          workspaces.push({ folder, isRepo: true, remotes });
        }
        return { project, workspaces };
      },
    });

    /**
     * A project's repo folder and default branch, for the worktree tools below - ANY git repo,
     * not just one `github.project` cloned (0.2, charter "projects work with or without GitHub").
     * A `github_projects` row (has `default_branch` recorded already) is used when there is one;
     * otherwise the project's own home folder is read directly: `folderGitState` says whether
     * it's a repo at all, `defaultBranchOf` reads its own default branch off disk. Returns null
     * when the project doesn't exist, isn't a repo yet, or has no resolvable default branch.
     */
    async function repoOf(project) {
      const known = projects.get(project);
      if (known) return { home: known.home, defaultBranch: known.default_branch };
      const row = await projectRow(project);
      if (!row) return null;
      const state = await folderGitState(row.home);
      if (!state.isRepo) return null;
      const defaultBranch = await defaultBranchOf(row.home);
      return defaultBranch ? { home: row.home, defaultBranch } : null;
    }

    ctx.tool("github.session.worktree", {
      internal: true,
      description: "Sessions only: a worktree and branch for a session in any project whose home is a git repo (GitHub's or local-only), or null when the project has no repo yet.",
      input: obj({ project: str, session: str }, ["project", "session"]),
      callers: ["module"],
      run: async ({ project, session }, meta = {}) => {
        checkModuleCaller("github.session.worktree", meta, SESSION_ONLY);
        const repo = await repoOf(project);
        if (!repo) return null;
        return worktreeAdd({ repoDir: repo.home, session, defaultBranch: repo.defaultBranch });
      },
    });

    ctx.tool("github.session.cleanup", {
      internal: true,
      description: "Sessions only: remove a session's worktree, but ONLY when nothing would be lost (with deleted: true, for a deleted chat, its commits and uncommitted changes are first kept under the undo ref, so only ignored files such as .env can stop it) (no uncommitted change, no untracked file, no commit missing from the default branch and every remote). Otherwise nothing is removed and github.cleanup-needed is emitted with what's at stake, for a person to decide by hand.",
      input: obj({ project: str, session: str, deleted: { type: "boolean" } }, ["project", "session"]),
      callers: ["module"],
      run: async ({ project, session, deleted }, meta = {}) => {
        checkModuleCaller("github.session.cleanup", meta, SESSION_ONLY);
        const repo = await repoOf(project);
        if (!repo) return { removed: false };
        const out = await worktreeRemove({ repoDir: repo.home, session, defaultBranch: repo.defaultBranch, deleted: Boolean(deleted) });
        if (out.needsConfirm) {
          ctx.events.emit("github.cleanup-needed", { project, session, path: out.path, branch: out.branch, dirty: out.dirty, commits: out.commits });
        }
        return out;
      },
    });

    ctx.tool("github.session.push", {
      description: "Push a session's own branch, and only that branch, to the same name on the project's primary GitHub repo (github_projects, not a workspace repo - only the account recorded there is ever used, never `.git/config`, which an agent's own shell can edit). Never force, refuses a non-fast-forward remote rather than overwrite it, and scans the outgoing commits for a known secret shape first, refusing with the file and line on a hit; pass allow_secret: true (the person's own \"push it anyway\") to push past that specific check once. People and their agents; a model caller pushes only its own session, never another one.",
      input: obj({ project: str, session: str, allow_secret: { type: "boolean" } }, ["project", "session"]),
      callers: PEOPLE_AND_AGENTS,
      run: async ({ project, session, allow_secret }) => {
        const repo = projects.get(project);
        if (!repo) throw fail(`${project} has no primary GitHub repo to push to (a workspace repo added with github.project.add-repo isn't pushed through this tool yet)`, "not_found");
        const acct = accounts.get(repo.account);
        if (!acct) throw fail(`the account that made this project (${repo.account}) isn't connected anymore; reconnect it`, "no_account");
        const token = await ctx.vault.fetch(acct.item, { field: "token" });
        const out = await pushSession({ repoDir: repo.home, session, defaultBranch: repo.default_branch, token, allowSecret: Boolean(allow_secret) });
        if (out.blocked === "secret") throw fail(`a ${out.pattern} was found in the outgoing commits, at ${out.file}:${out.line}; push again with allow_secret: true if this is really meant to go`, "secret_found", out);
        if (out.blocked === "non_fast_forward") throw fail(`the remote branch has commits this one doesn't; pull or rebase before pushing: ${out.detail}`, "non_fast_forward");
        return out;
      },
    });

    /**
     * The project's primary repo and its recorded account's token, for the PR tools. Only the
     * account on the project's own row is ever used (never .git/config, never "whichever works").
     */
    async function prTarget(project) {
      const repo = projects.get(project);
      if (!repo) throw fail(`${project} has no primary GitHub repo (pull requests are on the primary repo only)`, "not_found");
      const acct = accounts.get(repo.account);
      if (!acct) throw fail(`the account that made this project (${repo.account}) isn't connected anymore; reconnect it`, "no_account");
      const token = await ctx.vault.fetch(acct.item, { field: "token" });
      return { token, full_name: repo.full_name, login: acct.login };
    }
    /** Outward writes: a person's own call always runs; an agent's only when the Gate marked it asked (meta.asked, from the person's own words). */
    function requireAsked(tool, meta = {}) {
      const caller = String(meta.caller || "");
      if (!caller.startsWith("mcp")) return;
      if (!meta.asked) throw fail(`${tool} changes the pull request on GitHub, so it runs when you ask for it; ask and it will go`, "held");
    }
    const prErr = (e, target) => {
      if (e && e.code === "token_invalid") ctx.events.emit("github.token-invalid", { name: target.account });
      return e;
    };

    ctx.tool("github.project.pr.get", {
      description: "A pull request on the project's primary repo, shaped for the Deck's PR review card (title, branch, checks, files with patches, comments). Comments and the body are outside text. Read only.",
      input: obj({ project: str, pr: { type: "integer" } }, ["project", "pr"]),
      callers: PEOPLE_AND_AGENTS,
      run: async ({ project, pr }) => {
        const t = await prTarget(project);
        try { return await prView({ ...t, pr, project }); } catch (e) { throw prErr(e, t); }
      },
    });

    ctx.tool("github.project.pr.merge", {
      description: "Merge a pull request on the project's primary repo (merge, squash or rebase; default merge). Never deletes the branch. Outward: a person's own click runs it; an agent's call runs only when the person asked for it.",
      input: obj({ project: str, pr: { type: "integer" }, method: str, thread: str }, ["project", "pr"]),
      callers: PEOPLE_AND_AGENTS,
      run: async ({ project, pr, method }, meta = {}) => {
        requireAsked("github.project.pr.merge", meta);
        const t = await prTarget(project);
        try { return await prMerge({ ...t, pr, method }); } catch (e) { throw prErr(e, t); }
      },
    });

    ctx.tool("github.project.pr.review", {
      description: "Review a pull request on the project's primary repo: event APPROVE, REQUEST_CHANGES or COMMENT with a body, or a reply to one review comment (in_reply_to). Outward: a person's own click runs it; an agent's call runs only when the person asked for it.",
      input: obj({ project: str, pr: { type: "integer" }, event: str, body: str, in_reply_to: { type: "integer" }, thread: str }, ["project", "pr", "event"]),
      callers: PEOPLE_AND_AGENTS,
      run: async ({ project, pr, event, body, in_reply_to }, meta = {}) => {
        requireAsked("github.project.pr.review", meta);
        const t = await prTarget(project);
        try { return await prReview({ ...t, pr, event, body, in_reply_to }); } catch (e) { throw prErr(e, t); }
      },
    });
    ctx.tool("github.project.local-init", {
      description: "Give a project undo and per-session isolation with no GitHub: make its folder a git repo (main, one starting commit, no remote) so each session gets its own worktree and branch. A folder that already has commits is left exactly as it is. Secret-looking files (.env, keys) are kept out of the starting commit and listed in left_out. Refuses a folder that sits inside another repo. People, their agents, and projects/sessions when they create one.",
      input: obj({ project: str }, ["project"]),
      callers: [...PEOPLE_AND_AGENTS, "module"],
      run: async ({ project }, meta = {}) => {
        checkModuleCaller("github.project.local-init", meta, MODULE_CALLERS["github.project.local-init"]);
        const row = await projectRow(project);
        if (!row) throw fail(`no project named ${project}`, "not_found");
        const out = await localInit(row.home);
        if (!out.already) ctx.events.emit("github.local-init", { project, branch: out.branch });
        return out;
      },
    });
    ctx.tool("github.session.history", {
      description: "A session's own commits (newest first, { sha, subject }) and how many uncommitted changes its worktree has: what Undo can go back over. Read only. Works for GitHub and local-only projects alike.",
      input: obj({ project: str, session: str }, ["project", "session"]),
      callers: [...PEOPLE_AND_AGENTS, "module"],
      run: async ({ project, session }, meta = {}) => {
        checkModuleCaller("github.session.history", meta, SESSION_ONLY);
        const repo = await repoOf(project);
        if (!repo) throw fail(`${project} has no git repo`, "not_found");
        return sessionHistory({ repoDir: repo.home, session, defaultBranch: repo.defaultBranch });
      },
    });

    ctx.tool("github.session.undo", {
      description: "Undo a session's commits: back to `to` (a commit id from github.session.history; that commit and everything after it come off) or, without `to`, all the way to where the session started. Nothing is deleted: the tip is saved first and github.session.redo puts it back. Uncommitted changes are kept first as one marked commit under the saved ref, so redo brings everything back; no refusal. Never touches the default branch, never a remote.",
      input: obj({ project: str, session: str, to: str }, ["project", "session"]),
      callers: [...PEOPLE_AND_AGENTS, "module"],
      run: async ({ project, session, to }, meta = {}) => {
        checkModuleCaller("github.session.undo", meta, SESSION_ONLY);
        const repo = await repoOf(project);
        if (!repo) throw fail(`${project} has no git repo`, "not_found");
        // Undo mid-turn: stop whatever is still working in this session's worktree first, so
        // nothing writes while the commits come off. threads.interrupt-in stops the turn only (the
        // chat stays) and waits. A missing tool (sessions not landed) or an idle session is fine;
        // any other refusal stops the undo rather than racing a running turn.
        const cwd = path.join(repo.home, ".sessions", safeSegment(session, "session id"));
        if (fs.existsSync(cwd)) {
          const stopped = await ctx.call("threads.interrupt-in", { cwd });
          if (stopped.error && !/unknown|not_found|no_such|no such/i.test(`${stopped.error.code || ""} ${stopped.error.message || ""}`)) {
            throw fail(`could not stop the running turn before undo: ${stopped.error.message || stopped.error.code}`, stopped.error.code || "failed");
          }
        }
        const out = await sessionUndo({ repoDir: repo.home, session, defaultBranch: repo.defaultBranch, to: named(to) });
        ctx.events.emit("github.session.undone", { project, session, undone: out.undone });
        return out;
      },
    });

    ctx.tool("github.session.redo", {
      description: "Put back what the latest (or numbered) github.session.undo took off. Only when the session has not moved on since; otherwise refused and the saved commits stay kept.",
      input: obj({ project: str, session: str, n: { type: "integer" } }, ["project", "session"]),
      callers: [...PEOPLE_AND_AGENTS, "module"],
      run: async ({ project, session, n }, meta = {}) => {
        checkModuleCaller("github.session.redo", meta, SESSION_ONLY);
        const repo = await repoOf(project);
        if (!repo) throw fail(`${project} has no git repo`, "not_found");
        return sessionRedo({ repoDir: repo.home, session, n });
      },
    });

    return { async stop() { signIn.stop(); } };
  },
};

// GitHub's own charset for owner/name (reviewer, e5a612c0 review, LOW): the old `[^/\s]+` for
// owner let a value like "../user" resolve to /repos/user once put in an api.github.com path;
// name keeps an explicit "." / ".." exclusion below since its charset (unlike owner's) has dots.
const REPO_RE = /^(?:https?:\/\/github\.com\/)?([A-Za-z0-9-]{1,39})\/([A-Za-z0-9._-]{1,100}?)(?:\.git)?\/?$/;

/** owner/name or a GitHub URL, to "owner/name". */
function repoName(repo) {
  const s = String(repo || "").trim();
  const m = REPO_RE.exec(s);
  if (!m || m[2] === "." || m[2] === "..") throw fail(`repo must be owner/name or a github.com URL, not "${s.slice(0, 60)}"`);
  return `${m[1]}/${m[2]}`;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
