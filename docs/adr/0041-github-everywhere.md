---
title: ADR 0041: GitHub everywhere
summary: How Vyre signs in to GitHub, lists repos, turns one into a project, and gives every session its own worktree and branch.
audience: builders
owner: github
status: proposed
---

# ADR 0041: GitHub everywhere

Status: proposed, 28 Sep 2026 · Workstream: github · Code: `core/github/`, `lib/git-safe.js`
(existing, owner: sessions), `core/projects/` (existing, owner: federation), `deck/views/connections.js` (existing, owner: launch)

## The problem

A person's real work lives in GitHub repos. Today Vyre can run `git` inside a folder someone
already cloned (`lib/git-safe.js`), and the vault already knows a `github` provider for a pasted
PAT (`core/vault/providers.js`), but there is no sign-in, no repo list, no way to turn "here is my
repo" into a Vyre project, and no isolation between two sessions working the same project at once.
0.1.1 scope (the user, 28 Sep): device-flow sign-in in onboarding and Settings, a repo list, a
project made from a repo, and a worktree plus branch per session. PRs, issues, git settings,
Touch ID on big moves and a GitHub App are 0.1.2, design only.

An OAuth App named "Vyre" is already registered, Device Flow enabled, user tokens non-expiring.
Client ID `Ov23ct6h9OU5wJHjbqBl` (public). The secret lives in the vault env
(`VYRE_GITHUB_OAUTH_CLIENT_SECRET`) but device flow never reads it: RFC 8628 needs only the client
id. It exists so a later web/confirmation flow could use it; `github`'s code never reads that env
var in 0.1.1.

## Decision

### 1. One module, `core/github/`

Requires `vault`. Registers no Gate sender in 0.1.1: nothing here sends anything outward (no
issues, no comments, no PRs yet), so there is nothing for the Gate to hold. Cloning and pushing a
person's own work branch is a write to a repo the person already owns, the same trust level as
`git push` from a terminal today.

### 2. Sign-in: device flow, vault-only token, PERSON_ONLY

`github.connect {name}` (people only, PERSON_ONLY) starts RFC 8628:
`POST https://github.com/login/device/code` with `client_id` and `scope=repo` (decision 4).
Returns `{ id, user_code, verification_uri, verification_uri_complete, expires_in, interval }`.
The person types `user_code` at `verification_uri` (Deck: shown as text; onboarding and phone:
`verification_uri_complete` as a tappable link, opens Safari/Chrome, works over cellular with no
Vyre listener involved unlike Google's loopback). Vyre polls
`POST https://github.com/login/oauth/access_token` on its own timer at `interval` (backs off on
`slow_down`, stops on `authorization_pending` timeout at `expires_in`, one open poll per sign-in,
cleared the moment it ends), exactly like `google/connect.js`'s loopback listener exists only
while a sign-in is open. On success: the token goes straight into a new vault item `github-<name>`
(`kind: "pat"`, the existing kind; `field: token`), granted to `github` only, the same shape as
`google-<name>`; nothing else ever holds it. A `GET /user` call gets the login and avatar url,
`github.added {name, login}` is emitted, and the account is added the way `google.add` adds one:
one row in `github_accounts (name, login, avatar_url, item, added)`.

`github.connect.cancel {id}` and the sign-in's own 15-minute expiry both end it the way a Google
sign-in ends. There is no `.finish` here: a device-flow browser never lands back on Vyre, so there
is nothing to paste. `github.accounts` lists `{name, login, avatar_url}`, never a token.
`github.remove {name}` disconnects; the vault item stays (the vault's own grant to revoke, as
`google.remove`'s comment already says for Google).

Vault catalog change: `providers.js`'s `github` entry moves from `how: "field"` (paste a PAT) to
a second entry `github-oauth` with `how: "oauth"` and `next: { tool: "github.connect" }`, mirroring
`google-oauth`. The pasted-PAT path stays for anyone who wants to hand Vyre a fine-grained token by
hand instead of signing in (unattended boxes, a token scoped narrower than `repo`); Settings offers
both.

### 3. Repos: `github.repos`

`github.repos {account?, q?, limit?}` calls `GET /user/repos?affiliation=owner,collaborator,
organization_member&sort=updated&per_page=100`, paginated to `limit` (default 30, max 100),
filtered client-side by `q` against `full_name` and `description`. Returns
`[{ full_name, name, owner, private, default_branch, description, updated_at, html_url }]`, never
a clone URL with a token in it. `account` picks the connected account when there is more than one
(the same `forRead`/`forWait` shape as Google's).

**Scope decision: `repo`.** An OAuth App's device-flow scope is fixed at the request that minted
the token (unlike a GitHub App, there is no per-repo installation), so the choice is between
`public_repo` (too narrow: the person's own private repos, which is most of the point, would be
invisible) and `repo` (full read/write on every repo the account can reach, private included).
0.1.1 takes `repo`, named exactly as that to the person at sign-in time (GitHub's own consent
screen already says "Full control of private repositories"; Vyre repeats it in the onboarding
copy, not just relies on GitHub's screen). 0.1.2's GitHub App (already on the later roadmap, see
ADR TBD) replaces this with per-repo installation tokens scoped to only the repos the person
picks; that is the fix for the breadth, not a narrower OAuth scope today.

### 4. A project from a repo

Federation's existing tools do the work; `github` only clones. `github.project {name, repo,
account?}`:
1. `github.repos` to resolve `repo` (`owner/name` or a full URL) to its clone URL and default
   branch, for the resolved account.
2. Clone into `<projects dir>/<repo name>` (`config.js`'s `boxProjectsDir()`/local equivalent;
   `<repo name>` de-duplicated the way `scanEnv` de-dupes names) with `lib/git-safe.js`'s
   `gitAsync`, the only way this module runs git, ever. Authentication for a private clone never
   touches the remote URL or the repo's own config (both persist to disk and would leak the
   account across every future git call in that folder): a per-call `GIT_ASKPASS` script and an
   env var holding the token are set only for this one `clone`/`fetch`/`push` invocation, read
   once by the script and never written anywhere. This is a small addition to `git-safe.js`
   (`gitWithAskpass(dir, args, tokenProvider)`), owned by `sessions` (git-safe's owner);
   `github` calls it, never reimplements auth.
3. `ctx.call("projects.create", { name, home: clonedPath })`, or when the person already has a
   project and just wants to attach the repo, `projects.add-workspace`. `github` never writes to
   `projects`' own tables; it only calls its tools, per the module contract.
4. The project row remembers the repo (`github_projects (project, account, full_name,
   default_branch)`, keyed by the project's slug), so later steps (worktree-per-session, and
   0.1.2's PRs and git settings) know which project is a GitHub project without asking again.

### 5. A worktree and branch per session

Ownership split, through the registry only: `sessions` decides *when* (a session starting in a
project `github_projects` knows about); `github` does the git mechanics.

- `github.session.worktree { project, session }` (internal, called by `sessions` at session
  start, never by a model): if the project is not a GitHub project, returns `null` (sessions then
  uses the project's home folder directly, as today). Otherwise: `git worktree add
  <project>/.sessions/<session-short-id> -b vyre/<session-short-id> <default_branch>`
  through `git-safe`, and returns the new path. `sessions` sets the session's cwd there.
- `github.session.cleanup { project, session }` (internal, called by `sessions` when a thread is
  archived or its project changes): `git worktree remove`. The branch is left in place — a
  session's work is never deleted by ending the session — unless the worktree has zero commits
  ahead of its base, in which case the branch is pruned too (nothing to lose).
- `.sessions/` is repo-local and machine-local: it is written to the project's own `.git/info/
  exclude` once (never the repo's committed `.gitignore`, which is the person's file) so `git
  status` in the person's own clone of the same repo never shows Vyre's worktrees.
- Every git call here, with no exception, goes through `lib/git-safe.js`: no fsmonitor, no
  hooks, no network config from the repo, exactly the existing contract.

This is additive to `sessions`' own contract (ADR 0030): a "project has a repo" fact `sessions`
reads through `ctx.call("github.project.of", { project })`, never a direct table read.

### 6. Manifest and tools (0.1.1)

`module.json`: `requires: ["vault"]`, `does.tools`: `github.connect`, `github.connect.cancel`,
`github.accounts`, `github.remove`, `github.repos`, `github.project`, `github.project.of`,
`github.session.worktree` (internal), `github.session.cleanup` (internal). `watches.emits`:
`github.added`, `github.removed`, `github.connected`, `github.connect-failed`. `shows.deck`:
`settings:connections` (joins Google there, not a new screen). `needs.vault`: `["per-connection"]`.

## Consequences

- No token is ever pasted by hand for the common case; the fine-grained-PAT path stays for people
  who want it.
- `repo` scope is broad. Named plainly to the person, and superseded by the GitHub App in 0.1.2,
  not hidden behind a narrower-sounding request today.
- A worktree per session means two sessions in one project never fight over the working tree or a
  half-finished `git add`, and each gets a real branch a person can push and open a PR from by
  hand today, before Vyre does it from chat in 0.1.2.
- `.sessions/` worktrees are invisible to the person's own `git status` in the same clone.

## Rejected

- **A GitHub App instead of device flow, now.** Right shape for 0.1.2 (per-repo installs, short-
  lived tokens, PR/issue/check webhooks), but device flow with a non-expiring user token is the
  fast path to "signed in" for 0.1.1 and does not block the later move: the App can mint its own
  tokens for repos it is installed on and the OAuth path stays for accounts that never install it.
- **Cloning with the token in the remote URL.** Persists to `.git/config` on disk and to every
  `git remote -v`; the askpass-per-call approach never touches disk.
- **One shared worktree per project, session-locked.** Serializes every session in a project
  behind whichever one is running; a worktree per session is the same cost `sessions` already pays
  for isolation elsewhere (ADR 0030) and needs no lock.
