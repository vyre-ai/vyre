---
title: ADR 0041: GitHub everywhere
summary: How Vyre signs in to GitHub, lists repos, turns one into a project, and gives every session its own worktree and branch.
audience: builders
owner: github
status: draft
---

# ADR 0041: GitHub everywhere

Status: draft, 28 Sep 2026, Workstream: github, Code: `core/github/`, `lib/git-safe.js`
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

`github.remove {name}` (reviewer: a live non-expiring `repo` token must not just sit in the vault
once disconnected) fetches the item, calls `DELETE /applications/{client_id}/token` with HTTP
basic auth `client_id:client_secret` and `{ "access_token": token }` as the body, the one call in
this module that reads `VYRE_GITHUB_OAUTH_CLIENT_SECRET`, which revokes the token at GitHub, then
deletes the vault item and drops the account row. A revoke that fails (GitHub unreachable, already
revoked) still removes the account and item locally and says so plainly, so a person is never
stuck with a connected-looking account whose token doesn't work; it never leaves the token behind
silently. Rotation needs no new code: `health.js`'s `judge()` already treats kind `pat` as a
typed credential (`old`, `rotate`, `reused`, `breached` all apply to it via `secretsOf`), and
`remind.js` already turns those into a planner todo; storing the item as `kind: "pat"` is enough.

Vault catalog change: `providers.js`'s `github` entry moves from `how: "field"` (paste a PAT) to
a second entry `github-oauth` with `how: "oauth"` and `next: { tool: "github.connect" }`, mirroring
`google-oauth`. The pasted-PAT path stays for anyone who wants to hand Vyre a fine-grained token by
hand instead of signing in (unattended boxes, a token scoped narrower than `repo`); Settings offers
both.

### 3. Repos: `github.repos`

`github.repos {account?, q?, limit?, page?}` returns `{ repos: [{ full_name, name, owner,
private, default_branch, description, updated_at, html_url }], page, limit, more }`, everything a
picker needs (name, owner, the private flag, when it was last updated, its default branch) and a
next-page signal, never a clone URL with a token in it. Without `q`, `page`/`limit` are GitHub's
own paging on `GET /user/repos?...&sort=updated&per_page=<limit>&page=<page>` directly, newest-
updated first. With `q` (matched client-side against `full_name` and `description`, since
`/user/repos` has no text search of its own), the same call scans pages (capped at 10, so one
search can never fetch without bound) collecting matches, then paginates the matches themselves
by `page`/`limit`; `more` says whether another page of matches exists either way. `account` picks
the connected account when there is more than one (the same `forRead`/`forWait` shape as
Google's). `callers`: people (`cli`, `local`, `deck`, `capsule`) plus `module:sessions` and
`module:launch` only, this lists every private repo the account can reach, so it is never
model-reachable, the same as `github.connect`/`.remove`/`.project`. No tool in this module that a
model can call ever touches the token: reads (`repos`) are person/module-only, and there is no
model-reachable write in 0.1.1 (clone and worktree creation run only from `github.project`, itself
person/module-only). Any future model-reachable push or PR tool goes through the Gate, unheld
access is not on the table for it.

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
   `<repo name>` sanitised, `[A-Za-z0-9._-]` only, no leading dot, no `..`, and de-duplicated
   the way `scanEnv` de-dupes names) with `lib/git-safe.js`'s new `gitWithAskpass`, the only way
   this module runs git that needs a network call, ever.

   Authentication for the clone never touches the remote URL or the repo's own config (both
   persist to disk and would leak the account across every future git call in that folder). Two
   things the reviewer caught, both fixed and tested (`lib/git-safe-askpass.test.js`):
   - **The token never sits in an env var.** A child process's environment is readable by any
     same-uid process (`ps eww` on a Mac). The askpass script is handed the token over a
     one-time, already-open pipe fd (`GIT_ASKPASS_TOKEN_FD` names only the fd *number*, never a
     value, as an env var), read once and printed, then the script is gone: it lives in a `0700`
     temp dir made fresh per call and removed the moment the call ends.
   - **`credential.helper` must not run at all.** macOS ships `credential.helper=osxkeychain` in
     git's system config, and many people set one globally too, though `git-safe.js`'s
     `GIT_CONFIG_NOSYSTEM`/`GIT_CONFIG_GLOBAL=devNull` already rule out both scopes, so the actual
     residual risk proven in the test is a **repo-local** helper (in the destination's own
     `.git/config`, a scope neither of those two touches): without an override, a successful
     askpass would hand the token straight to it, and it would be reused silently by every later
     `git push` in that folder, a model's own terminal `git push` included. Every call adds `-c
     credential.helper=` (git's documented way to clear a configured helper list) on top of
     `git-safe.js`'s existing `SAFE_GIT_ARGS`. `credential.interactive` is left alone: its `false`
     value (confusingly) *disables* asking rather than disabling a stored answer, which would
     defeat askpass entirely; `GIT_TERMINAL_PROMPT=0` (already forced) is what stops a raw
     terminal prompt without touching the askpass path.
   - **Only `https` is reachable, nothing else.** `git-safe.js`'s inherited `protocol.allow=never`
     blocks every transport by default; `gitWithAskpass` adds `protocol.https.allow=always` on
     top, so `file`, `git`, `ext` and a submodule's own transport all stay blocked even for this
     call (tested: a local repo path is refused exactly like any other non-https source).
   - **One username for every account.** `credential.username` is fixed to `x-access-token`
     (GitHub's own convention: any non-empty username works with a PAT as the password), so git
     only ever prompts askpass once, for the password. Without this it asks twice, once for the
     username, once for the password, and the fd, read once, would answer the first ask and
     leave the second empty. Tested via `git credential fill` (the exact credential-resolution
     path a clone takes), so nothing here depends on reaching real GitHub in a test.

   This is a small, tested addition to `git-safe.js` (`gitWithAskpass(dir, args, { token,
   username?, stdin? })`), sent to `sessions` (git-safe.js's owner) as a self-contained new-file
   diff for review, their branch doesn't carry `git-safe.js` yet and a full merge mid-task was
   too large to do safely, so they review it standalone and the integrator reconciles it against
   main's copy at the stage/0.1.1 fold, the same as everything else piling up there. `github`
   calls it and never reimplements auth.

   **A mistake made and reported while building this**: an early hand-written debug script ran
   `git credential fill` directly, outside `git-safe.js`'s isolation, to check whether the
   askpass script was reached. Skipping `GIT_CONFIG_NOSYSTEM`/`GIT_CONFIG_GLOBAL=devNull` let this
   machine's real stored GitHub credential answer instead, printing a real username and PAT into
   tool output that is now in this session's transcript. Reported to the reviewer and the lead
   immediately; the value was not reused or sent anywhere; a rotation is recommended. The actual
   `gitWithAskpass` code path was never affected (it always goes through the real isolation), the
   leak was in a throwaway debug script that has since been deleted.
3. `ctx.call("projects.create", { name, home: clonedPath })`. `github` never writes to `projects`'
   own tables; it only calls its tools, per the module contract.
4. The project row remembers the repo (`github_projects (project, account, full_name,
   default_branch)`, keyed by the project's slug), so later steps (worktree-per-session, and
   0.1.2's PRs and git settings) know which project is a GitHub project without asking again. This
   is the project's **primary** GitHub repo, set exactly once, here: a session's worktree (section
   5) is always made from it. `github.project.add-repo` (4a) adds further repos to a project as
   plain workspaces and never touches this row.

`github.project` makes a brand-new project. Attaching a repo to a project that already exists is
a different tool (4a), not a `project` input here: an earlier draft let `github.project` do both
(`project?` param, `projects.add-workspace` when given), but that let a second, non-primary repo
silently overwrite the `github_projects` row meant for the session-worktree repo, so it was split
before either path shipped. `callers` for `github.project`: people plus `module:launch` (the
onboarding "connect a repo" step). Never a model.

### 4a. Adding a repo to an EXISTING project

**Decided, 28 Sep 2026: there is no explicit "link".** An earlier draft (`github.project.link`/
`.unlink`, a `confirm: true` step that added a remote named `github` to an existing folder) was
built, tested and then dropped once the user settled the project/repo model: a project's repos
are either its one primary repo (4, set once, what a session's worktree is made from) or
workspaces it owns, each its own real clone, never a remote grafted onto a folder that already
exists. Nothing records "this folder is linked" by hand; `github.project.detect` (4b) reads what
is actually on disk, every time.

The one GitHub action on an existing project is `github.project.add-repo {project, repo,
account?, folder?}`, people only (`callers: PEOPLE`), never a module and never a model: clone the
repo, fresh, as a brand-new workspace folder, exactly the way `github.project` clones a project's
first folder (`getRepo` to resolve `repo`, `cloneRepo`/`gitWithAskpass`, no token on disk, no
remote grafted onto anything that already exists). `folder?` names the new folder (`freeFolder`'s
own `-2`/`-3` suffix if that name is taken); the default is the repo's own name. The new folder is
registered through `ctx.call("projects.add-workspace", { project, folder })`, federation's own
tool, the same one `github.project` already had sign-off for (`module:github` on
`MAPPING_ALLOWED`, sha 624edc76). `add-repo` never writes the `github_projects` row: the added
repo is a workspace, not the project's primary repo, so it changes nothing about which repo a
session's worktree comes from (section 5), and never touches the project's other folders.
A worktree for an added, non-primary repo is 0.1.2, same as before.

**Tested live, once, on testbox** (`core/github/index.live.test.js`, off by default, opt in with
`VYRE_LIVE_GITHUB=1`, never on the Mac): `github.project` and `.add-repo` really clone GitHub's
own tiny public demo repo (`octocat/Hello-World`) end to end, with a made-up account and a
placeholder token the whole way through, never a real credential. It drove one real fix: `getRepo`
(the shared `GET /repos/{full_name}` helper) used to 401 outright on a broken or placeholder
token, even for a repo anyone could read anonymously, since GitHub validates whatever credential
is offered before ever falling back to public access; it now retries once with no credential at
all when the first attempt 401s, so a bad token no longer wrongly reports a public repo as
inaccessible. The clone itself needed no such fix: GitHub serves a public repo's git-http
endpoints anonymously, so `gitWithAskpass` never even reaches its own askpass script for one, a
placeholder token or not. The live test also checks the clone's own `.git/config` for a
`credential.helper` afterward (there should be none) as a second, concrete proof next to
`git-safe-askpass.test.js`'s existing ones.

### 4b. Detecting a project's repos, per workspace

`github.project.detect {project}` is how a surface knows what's already there, since nothing is
ever recorded by hand (4a): for EVERY folder a project owns (its home plus every workspace it was
given, `projects.list`'s own `home`/`workspaces`, deduplicated), is it a git repo, what remotes
does it have, and for any remote that's a GitHub URL, does one of the connected accounts reach
it. Entirely read-only and local for the git side (`folderGitState`/`listRemotes`, `core/github/
git.js`, no network git call, no token used for git at all), plus at most one `getRepo` REST call
per distinct repo found across every remote in every workspace (cached by `full_name`, so the
same repo behind two remotes, or the same repo in two workspaces, is only ever checked once). It
costs nothing to call speculatively the moment a project opens.

`callers`: people plus `module:launch` (onboarding, or a project view, can offer "add this repo?"
per workspace without the person typing anything). Returns `{ project, workspaces: [{ folder,
isRepo, remotes: [{ name, url, full_name, match }] }] }`. `remotes` is `[]` for a folder that
isn't a git repo at all. `full_name` is `owner/name` when a remote's URL parses as github.com
(`originFullName`, `core/github/git.js`), `null` for anything else (a `gitlab.com` remote, say).
`match` is `{ account, full_name, default_branch }` for the first connected account that can
reach that repo, or `null` when the remote isn't GitHub, or is a repo none of the connected
accounts can see (someone else's fork, an account not yet connected).

### 5. A worktree and branch per session

Ownership split, through the registry only: `sessions` decides *when*; `github` does the git
mechanics, fully built and tested (`core/github/git.test.js`), needing no token or network
allowance at all (a worktree is a local operation on a repo already on disk).

`sessions` corrected the trigger against their real lifecycle (there is no "archived" or
project-change event today; `thread.started` is real, emitted by the Switchboard):
- **Start**: on `thread.started` (or `harness.brief`'s own `{session, cwd, source}` hook), if
  `ctx.call("github.project.of", { project })` says the project has a repo, call
  `github.session.worktree { project, session }` and use its `path` as the session's cwd instead
  of the project's home folder.
- **End**: on `thread.stopped` or `thread.finished` (from `lib/thread-status.js`'s
  `THREAD_STATUSES`; `sessions` picks the exact one(s) when they build the hook), call
  `github.session.cleanup { project, session }`.

- `github.session.worktree { project, session }` (`internal: true`, callers `["module:sessions"]`
  only, never a model, never a person surface directly): if the project is not a GitHub project,
  returns `null` (sessions then uses the project's home folder directly, as today). Otherwise:
  the session id is reduced to a safe short id first (git's own check-ref-format rules, no
  leading `.` or `-`, no `..` anywhere, no trailing `.`, since this becomes a path segment and a
  branch name), then `git worktree add <repo>/.sessions/<safe-id> -b vyre/<safe-id>
  <default_branch>` through `git-safe`, and returns the new path. `sessions` sets the session's
  cwd there.
- `github.session.cleanup { project, session }` (same caller restriction). **The user's binding
  rule: no auto-delete, ever; deletion is always previewed.** The worktree is removed, and its
  branch pruned, only when nothing would be lost: no uncommitted change, no untracked **or
  ignored** file (`git status --porcelain --ignored`, plain `--porcelain` skips ignored files,
  and a plain `git worktree remove` deletes them without complaint; in a session's worktree those
  are exactly the things that matter, a `.env`, build output, a downloaded dataset, a local
  database, the reviewer's MEDIUM on the first cut), and no commit that isn't already on the
  default branch or some remote (`git rev-list refs/heads/<branch> --not
  refs/heads/<default_branch> --remotes`; the `refs/heads/` form guards against a value ever
  being misread as an option, belt-and-braces on top of `safeSegment` already refusing a leading
  dash, `git branch -d` itself only accepts the short name, not that form, so it keeps it).
  If any of those is true, **nothing is removed**, the worktree and branch are left exactly as
  they were, and `github.cleanup-needed { project, session, path, branch, dirty, commits }` is
  emitted with what's at stake, for a surface to show "Clean up this session's worktree?" and the
  person to decide by hand. `git worktree remove --force` and `git branch -D` never appear
  anywhere in this path; the removal that does happen uses their plain, non-force forms, which
  independently refuse if the check above ever turns out to be wrong, a second backstop, not a
  substitute for the check.
- `.sessions/` is repo-local and machine-local: it is written to the project's own `.git/info/
  exclude` once (never the repo's committed `.gitignore`, which is the person's file) so `git
  status` in the person's own clone of the same repo never shows Vyre's worktrees.
- Every git call here, with no exception, goes through `lib/git-safe.js`: no fsmonitor, no
  hooks, no network config from the repo, exactly the existing contract.

This is additive to `sessions`' own contract (ADR 0030): a "project has a repo" fact `sessions`
reads through `ctx.call("github.project.of", { project })`, never a direct table read.

**Built by sessions (79bd2bf1): cleanup fires only on canonical status `finished`**, never
`stopped` or `paused` (`lib/thread-status.js`), since both of those are resumable on their
existing cwd and `threads.send` on resume never re-resolves it, cleaning up on them would strand
the resume. This is the right, conservative default for 0.1.1, decided jointly: an ordinary
interactive session, which typically ends `stopped` rather than `finished`, keeps its worktree
indefinitely under today's hook. Nothing breaks (disk isn't reclaimed, not correctness), but it is
a real gap. **Deferred to 0.1.2**: a periodic sweep for worktrees whose session has neither a live
thread nor a resumable `stopped`/`paused` status. Owner: `github` (sessions, 28 Sep: "it's
reading your own .sessions/ directories against thread status, and threads.list already gives
you what you'd need... without a new tool from me"). Not started; 0.1.2.

### 6. Manifest, tools and callers (0.1.1)

`module.json`: `requires: ["vault"]`, `does.tools`: `github.connect`, `github.connect.cancel`,
`github.accounts`, `github.remove`, `github.repos`, `github.project`, `github.project.add-repo`,
`github.project.of`, `github.project.detect`, `github.session.worktree` (internal),
`github.session.cleanup` (internal). `watches.emits`: `github.added`, `github.removed`,
`github.connected`, `github.connect-failed`, `github.cleanup-needed`. `shows.deck`:
`settings:connections` (joins Google there, not a new screen). `needs.vault`:
`["per-connection"]`.

| Tool | Callers | Model-reachable |
|---|---|---|
| `github.connect`, `.connect.cancel`, `.remove`, `.accounts` | people | never |
| `github.repos`, `github.project`, `github.project.of` | people, `module:sessions`, `module:launch` | never |
| `github.project.detect` | people, `module:launch` | never |
| `github.project.add-repo` | people only | never |
| `github.session.worktree`, `.session.cleanup` | `module:sessions` only, `internal: true` | never |

No tool a model can call in 0.1.1 touches the token, clones, or writes a worktree. Everything
that does is a person surface or one of the two named modules.

## Consequences

- No token is ever pasted by hand for the common case; the fine-grained-PAT path stays for people
  who want it.
- `repo` scope is broad. Named plainly to the person, and superseded by the GitHub App in 0.1.2,
  not hidden behind a narrower-sounding request today.
- A worktree per session means two sessions in one project never fight over the working tree or a
  half-finished `git add`, and each gets a real branch a person can push and open a PR from by
  hand today, before Vyre does it from chat in 0.1.2.
- `.sessions/` worktrees are invisible to the person's own `git status` in the same clone.
- No explicit link means no bookkeeping to go stale: `github.project.detect` always answers from
  what's actually on disk, and adding a repo (`add-repo`) is a real, fresh clone, never a remote
  grafted onto a folder that already has its own history.

## Rejected

- **`github.project.link`/`.unlink`, recording a project-to-repo link by hand.** Built, tested,
  and dropped once the user settled the model: see 4a. A project either owns a repo as its
  primary (set once, by `github.project`) or as a workspace (`add-repo`, a fresh clone); nothing
  in between needs recording, since `detect` (4b) can always read it back off disk.

- **A GitHub App instead of device flow, now.** Right shape for 0.1.2 (per-repo installs, short-
  lived tokens, PR/issue/check webhooks), but device flow with a non-expiring user token is the
  fast path to "signed in" for 0.1.1 and does not block the later move: the App can mint its own
  tokens for repos it is installed on and the OAuth path stays for accounts that never install it.
- **Cloning with the token in the remote URL.** Persists to `.git/config` on disk and to every
  `git remote -v`; the askpass-per-call approach never touches disk.
- **One shared worktree per project, session-locked.** Serializes every session in a project
  behind whichever one is running; a worktree per session is the same cost `sessions` already pays
  for isolation elsewhere (ADR 0030) and needs no lock.
