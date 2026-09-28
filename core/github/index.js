// @ts-check
// github: native "Sign in with GitHub" (device flow), repos, and a project from a repo (ADR 0041).
//
// Nothing here is model-reachable in 0.1.1: connect, remove, repos and project are people plus
// two named modules (sessions, launch); the worktree tools are sessions-only and internal. No
// Gate sender is registered, because nothing here sends anything outward yet (no issues, no PRs).

import { connector, revoke } from "./connect.js";
import { MIGRATIONS, store, projectStore, forOne } from "./accounts.js";
import { cloneRepo, worktreeAdd, worktreeRemove } from "./git.js";

const str = { type: "string" };
const obj = (properties, required = []) => ({ type: "object", properties, required });
const PEOPLE = ["cli", "local", "deck", "capsule"];
/** Coarse gate: any person, or any module (narrowed per-tool below by exact caller name). */
const PEOPLE_AND_MODULES = [...PEOPLE, "module"];
/** Which module callers each tool actually accepts, checked against the raw meta.caller. */
const MODULE_CALLERS = {
  "github.repos": new Set(["module:sessions", "module:launch"]),
  "github.project": new Set(["module:launch"]),
  "github.project.of": new Set(["module:sessions", "module:launch"]),
};
const SESSION_ONLY = new Set(["module:sessions"]);

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
      description: "The account's repos: [{ full_name, name, owner, private, default_branch, description, updated_at, html_url }], never a clone URL with a token in it.",
      input: obj({ account: str, q: str, limit: { type: "integer" } }),
      callers: PEOPLE_AND_MODULES,
      run: async ({ account: a, q, limit }, meta = {}) => {
        checkModuleCaller("github.repos", meta, MODULE_CALLERS["github.repos"]);
        const acct = forOne(accounts.all(), named(a));
        const token = await ctx.vault.fetch(acct.item, { field: "token" });
        const n = Number.isInteger(limit) ? Math.min(100, Math.max(1, limit)) : 30;
        const repos = await listRepos(token, n);
        const words = named(q) ? q.toLowerCase() : null;
        const filtered = words ? repos.filter(r => r.full_name.toLowerCase().includes(words) || (r.description || "").toLowerCase().includes(words)) : repos;
        return filtered.slice(0, n);
      },
    });

    /** GET /user/repos, paginated to at least `want` rows or two pages, whichever is less work. */
    async function listRepos(token, want) {
      const out = [];
      for (let page = 1; page <= 3 && out.length < want; page++) {
        const res = await fetch(`https://api.github.com/user/repos?affiliation=owner,collaborator,organization_member&sort=updated&per_page=100&page=${page}`,
          { headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json" }, signal: AbortSignal.timeout(15_000) });
        if (!res.ok) throw fail(`GitHub answered ${res.status} listing repos.`, "refused");
        const rows = await res.json();
        if (!Array.isArray(rows) || !rows.length) break;
        for (const r of rows) out.push({ full_name: r.full_name, name: r.name, owner: r.owner && r.owner.login, private: Boolean(r.private),
          default_branch: r.default_branch, description: r.description || null, updated_at: r.updated_at, html_url: r.html_url,
          clone_url: r.clone_url });
        if (rows.length < 100) break;
      }
      return out;
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
        const res = await fetch(`https://api.github.com/repos/${full_name}`, { headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json" }, signal: AbortSignal.timeout(15_000) });
        if (!res.ok) throw fail(`GitHub answered ${res.status} for ${full_name}.`, "refused");
        const info = await res.json();
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
