// @ts-check
// github: native "Sign in with GitHub" (device flow), repos, and a project from a repo (ADR 0041).
//
// Nothing here is model-reachable in 0.1.1: connect, remove, repos and project are people plus
// two named modules (sessions, launch); the worktree tools are sessions-only and internal. No
// Gate sender is registered, because nothing here sends anything outward yet (no issues, no PRs).

import { connector, revoke } from "./connect.js";
import { MIGRATIONS, store, projectStore, forOne } from "./accounts.js";
import { cloneRepo, worktreeAdd, worktreeRemove, readOrigin, originFullName, remoteUrl, remoteAdd, folderGitState } from "./git.js";

const str = { type: "string" };
const obj = (properties, required = []) => ({ type: "object", properties, required });
const PEOPLE = ["cli", "local", "deck", "capsule"];
/** Coarse gate: any person, or any module (narrowed per-tool below by exact caller name). */
const PEOPLE_AND_MODULES = [...PEOPLE, "module"];
/** Which module callers each tool actually accepts, checked against the raw meta.caller. */
const MODULE_CALLERS = {
  "github.repos": new Set(["module:sessions", "module:launch"]),
  "github.project": new Set(["module:launch"]),
  // module:threads is core/switchboard, where a new thread's worktree is made and cleaned up (79bd2bf1).
  "github.project.of": new Set(["module:sessions", "module:threads", "module:launch"]),
  "github.project.detect": new Set(["module:launch"]),
};
const SESSION_ONLY = new Set(["module:sessions", "module:threads"]);

const fail = (msg, code = "bad_input") => Object.assign(new Error(msg), { code });
const named = v => (typeof v === "string" && v ? v : undefined);

/** Refuse a module caller this tool did not name. People are never refused here. */
function checkModuleCaller(tool, meta, allowed) {
  const caller = String((meta && meta.caller) || "");
  if (caller.startsWith("module:") && !allowed.has(caller)) {
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
    const clientId = process.env.VYRE_GITHUB_OAUTH_CLIENT_ID || "Ov23ct6h9OU5wJHjbqBl";

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
      description: "Disconnect a GitHub account: revokes the token at GitHub, then removes the vault item and the account. A failed revoke still removes the account locally and says so, rather than leaving a connected-looking account with a token that may not work.",
      input: obj({ name: str }, ["name"]),
      callers: PEOPLE,
      run: async ({ name }) => {
        const acct = accounts.get(name);
        if (!acct) return { removed: false };
        let revoked = { revoked: false, error: "no client secret configured" };
        const clientSecret = process.env.VYRE_GITHUB_OAUTH_CLIENT_SECRET;
        if (clientSecret) {
          let token;
          try { token = await ctx.vault.fetch(acct.item, { field: "token" }); } catch {}
          if (token) revoked = await revoke({ clientId, clientSecret, token });
        }
        await ctx.call("vault.delete", { name: acct.item }).catch(() => {});
        accounts.remove(name);
        ctx.events.emit("github.removed", { name });
        return revoked.revoked ? { removed: true, revoked: true } : { removed: true, revoked: false, warning: `the account was removed, but the token may still work at GitHub: ${revoked.error}` };
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

    /** GET /repos/{full_name}, mapped down to what link/detect/project need, or null (not found, no access). */
    async function getRepo(token, full_name) {
      const res = await fetch(`https://api.github.com/repos/${full_name}`, { headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json" }, signal: AbortSignal.timeout(15_000) });
      if (!res.ok) return null;
      const r = await res.json();
      return { full_name: r.full_name, name: r.name, default_branch: r.default_branch, clone_url: r.clone_url, html_url: r.html_url, private: Boolean(r.private) };
    }

    /** A project's home folder: the one this module already recorded, or asked of `projects` by slug/name. */
    async function homeOf(project) {
      const known = projects.get(project);
      if (known) return known.home;
      const p = await projectRow(project);
      return p ? p.home : null;
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

    /** The GitHub account that can reach `full_name`, or null - checked once per full_name, first match wins. */
    async function accountFor(full_name, cache) {
      if (cache.has(full_name)) return cache.get(full_name);
      let match = null;
      for (const acct of accounts.all()) {
        let token;
        try { token = await ctx.vault.fetch(acct.item, { field: "token" }); } catch { continue; }
        const info = await getRepo(token, full_name).catch(() => null);
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
      description: "Make a project from a repo: clones it, then makes a new project or attaches it to an existing one. `repo` is owner/name or a full GitHub URL.",
      input: obj({ name: str, repo: str, project: str, account: str }, ["repo"]),
      callers: PEOPLE_AND_MODULES,
      run: async ({ name, repo, project, account: a }, meta = {}) => {
        checkModuleCaller("github.project", meta, MODULE_CALLERS["github.project"]);
        const acct = forOne(accounts.all(), named(a));
        const token = await ctx.vault.fetch(acct.item, { field: "token" });
        const full_name = repoName(repo);
        const info = await getRepo(token, full_name);
        if (!info) throw fail(`GitHub does not show a repo at ${full_name} for ${acct.login}.`, "refused");
        const projectsDir = ctx.config && ctx.config.projectsDir;
        if (!projectsDir) throw fail("this device has no projects folder configured", "config");
        const cloned = await cloneRepo({ projectsDir, name: info.name, url: info.clone_url, token });
        const out = project
          ? await ctx.call("projects.add-workspace", { project, folder: cloned.path })
          : await ctx.call("projects.create", { name: name || info.name, home: cloned.path });
        if (out.error) throw fail(out.error.message, out.error.code || "failed");
        const slug = (out.data && out.data.slug) || project;
        projects.put({ project: slug, account: acct.name, full_name, default_branch: info.default_branch, home: cloned.path }, now());
        return { project: slug, home: cloned.path, full_name, default_branch: info.default_branch };
      },
    });

    ctx.tool("github.project.detect", {
      description: "Per workspace: for each folder a project owns (its home plus every workspace it was given), whether it's a git repo, its remotes, and for any remote that's a GitHub URL, owner/repo plus whether one of the connected accounts can reach it. Read-only: local-only git reads (no network git call, no token used for git), plus one GitHub REST call per distinct repo found across every remote, cached so the same repo is never checked twice. Changes nothing, needed whichever way the project/repo model lands.",
      input: obj({ project: str }, ["project"]),
      callers: PEOPLE_AND_MODULES,
      run: async ({ project }, meta = {}) => {
        checkModuleCaller("github.project.detect", meta, MODULE_CALLERS["github.project.detect"]);
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
            remotes.push({ name: r.name, url: r.url, full_name, match });
          }
          workspaces.push({ folder, isRepo: true, remotes });
        }
        return { project, workspaces };
      },
    });

    ctx.tool("github.project.link", {
      description: "Link an EXISTING project to a GitHub repo. `repo` is owner/name or a full GitHub URL. Without confirm: if the project's folder is a git repo whose origin already points at that repo, the link is just recorded and nothing on disk changes. Otherwise NOTHING is changed - the folder's current origin (or its absence, or that it isn't a git repo at all) is reported back along with a proposed action: adding the repo as a remote named \"github\". Call again with confirm: true to actually add that remote (never overwrites or removes an existing remote of any name, never force) and record the link.",
      input: obj({ project: str, repo: str, account: str, confirm: { type: "boolean" } }, ["project", "repo"]),
      callers: PEOPLE,
      run: async ({ project, repo, account: a, confirm }) => {
        const home = await homeOf(project);
        if (!home) throw fail(`no project named ${project}`, "not_found");
        const acct = forOne(accounts.all(), named(a));
        const token = await ctx.vault.fetch(acct.item, { field: "token" });
        const full_name = repoName(repo);
        const info = await getRepo(token, full_name);
        if (!info) throw fail(`GitHub does not show a repo at ${full_name} for ${acct.login}.`, "refused");
        const record = () => { projects.put({ project, account: acct.name, full_name, default_branch: info.default_branch, home }, now()); ctx.events.emit("github.project.linked", { project, full_name }); };

        const state = await readOrigin(home);
        if (!state.isRepo) {
          return { linked: false, action: "none", reason: "not_a_repo", home,
            message: `${home} is not a git repository yet, so there is no remote to add. Clone or run git init there first.` };
        }
        if (state.origin && originFullName(state.origin) === full_name) {
          record();
          return { linked: true, recorded: true, matched: "origin", full_name, default_branch: info.default_branch, home };
        }
        if (!confirm) {
          return { linked: false, action: "add-remote", remote: "github", url: info.clone_url, origin: state.origin, full_name,
            default_branch: info.default_branch,
            message: state.origin
              ? `this folder's origin is ${state.origin}, not ${full_name}. Add ${full_name} as a remote named "github"?`
              : `this folder has no origin remote. Add ${full_name} as a remote named "github"?` };
        }
        const existingGithub = await remoteUrl(home, "github");
        if (existingGithub) {
          if (originFullName(existingGithub) !== full_name) {
            throw fail(`this folder already has a remote named "github" pointing at ${existingGithub}; nothing was changed`, "remote_exists");
          }
        } else {
          await remoteAdd(home, "github", info.clone_url);
        }
        record();
        return { linked: true, recorded: true, matched: existingGithub ? "github-remote" : "added-remote", remote: "github", full_name, default_branch: info.default_branch, home };
      },
    });

    ctx.tool("github.project.unlink", {
      description: "Forget a project's GitHub link. Never touches git: no remote is removed and the folder is untouched - only the recorded link is dropped.",
      input: obj({ project: str }, ["project"]),
      callers: PEOPLE,
      run: async ({ project }) => {
        const had = projects.get(project);
        const removed = projects.remove(project);
        if (removed) ctx.events.emit("github.project.unlinked", { project });
        return { unlinked: removed, was: had ? { full_name: had.full_name, home: had.home } : null };
      },
    });

    ctx.tool("github.session.worktree", {
      internal: true,
      description: "Sessions only: a worktree and branch for a session in a GitHub project, or null when the project has no repo.",
      input: obj({ project: str, session: str }, ["project", "session"]),
      callers: ["module"],
      run: async ({ project, session }, meta = {}) => {
        checkModuleCaller("github.session.worktree", meta, SESSION_ONLY);
        const repo = projects.get(project);
        if (!repo) return null;
        return worktreeAdd({ repoDir: repo.home, session, defaultBranch: repo.default_branch });
      },
    });

    ctx.tool("github.session.cleanup", {
      internal: true,
      description: "Sessions only: remove a session's worktree, but ONLY when nothing would be lost (no uncommitted change, no untracked file, no commit missing from the default branch and every remote). Otherwise nothing is removed and github.cleanup-needed is emitted with what's at stake, for a person to decide by hand.",
      input: obj({ project: str, session: str }, ["project", "session"]),
      callers: ["module"],
      run: async ({ project, session }, meta = {}) => {
        checkModuleCaller("github.session.cleanup", meta, SESSION_ONLY);
        const repo = projects.get(project);
        if (!repo) return { removed: false };
        const out = await worktreeRemove({ repoDir: repo.home, session, defaultBranch: repo.default_branch });
        if (out.needsConfirm) {
          ctx.events.emit("github.cleanup-needed", { project, session, path: out.path, branch: out.branch, dirty: out.dirty, commits: out.commits });
        }
        return out;
      },
    });

    return { async stop() { signIn.stop(); } };
  },
};

/** owner/name or a GitHub URL, to "owner/name". */
function repoName(repo) {
  const s = String(repo || "").trim();
  const m = /^(?:https?:\/\/github\.com\/)?([^/\s]+)\/([^/\s.]+?)(?:\.git)?\/?$/.exec(s);
  if (!m) throw fail(`repo must be owner/name or a github.com URL, not "${s.slice(0, 60)}"`);
  return `${m[1]}/${m[2]}`;
}
