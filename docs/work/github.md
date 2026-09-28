# github

Branch: work/github · Worktree: ../vyre-github · Owner session: github

## Done
- ADR 0041 written (docs/adr/0041-github-everywhere.md), claimed as ADR 0041 in docs/work/README.md.
- Read the existing patterns this design reuses: `core/google/connect.js` and `core/google/
  index.js` (OAuth account module shape, sign-in lifecycle, vault item ownership), `core/vault/
  providers.js` (the catalog entry a sign-in points at), `core/vault/connections.js` (surfaces
  and capabilities), `lib/git-safe.js` (the only way git runs), `core/projects/index.js`
  (`projects.create`, `projects.add-workspace`, both already built by federation).

## Doing
- ADR 0041 reviewer round done: approved with 1 HIGH (credential.helper would save the token
  after a clone; fixed with `-c credential.helper=` + `-c credential.interactive=never` on every
  askpass call) and 3 MEDIUM (declare callers on every tool — none model-reachable; revoke the
  token at GitHub on `github.remove`, not just drop the vault item; wire remind.js). Fixed in the
  ADR (commit to follow). Building now.

## Next
1. `core/github/module.json` + `core/github/index.js`: `github.connect`, `.connect.cancel`,
   `.accounts`, `.remove` (device flow, mirrors `google/connect.js`'s lifecycle but polling
   instead of a loopback listener; `.remove` revokes at GitHub via
   `DELETE /applications/{client_id}/token` before dropping the vault item).
2. `core/github/connect.js`: RFC 8628 device flow (start + internal poll timer), vault item
   `github-<name>` (kind `pat`), account row in `github_accounts`.
3. Vault: add `github-oauth` provider entry (`how: "oauth"`, `next: { tool: "github.connect" }`)
   alongside the existing pasted-PAT `github` entry in `core/vault/providers.js`; a `github-pat`
   reminder reason in `remind.js`.
4. `github.repos`, `github.project`, `github.project.of` (repo list, clone + `projects.create`/
   `add-workspace`, and the project-to-repo lookup other modules read). Callers per the ADR's
   table — never a model.
5. `lib/git-safe.js` addition (coordinate with sessions, its owner): `gitWithAskpass(dir, args,
   { fd })` — token via an inherited one-time pipe fd, never an env var; `credential.helper=` and
   `credential.interactive=never` forced on top of `SAFE_GIT_ARGS`; a test proving no helper runs
   and the token never appears in `ps` output or on disk.
6. `github.session.worktree` / `.session.cleanup` (internal, `module:sessions` only; session id
   sanitised to a safe path/branch segment before use), plus the `sessions` side that calls them
   at session start/end — coordinate with sessions before touching anything there.
7. Settings (launch) and onboarding (launch) UI: device code + verification link, connected
   state with avatar, disconnect. Not this team's code; hand off the tool shapes once cleared.

## Needs from others
- sessions: the `git-safe.js` askpass addition (`gitWithAskpass`, fd-based token, forced
  `credential.helper=`) and the session-start/end hook that calls
  `github.session.worktree`/`.cleanup` — this team proposes the shape in the ADR, sessions owns
  the file.
- federation: confirm `projects.create`/`projects.add-workspace` callers include `module:github`
  (today's caller allowlist in `core/projects/index.js` may need a module exception the same way
  `module:sync` has one for `add-workspace`).
- launch: Settings and onboarding screens once the tool shapes are cleared.

## Changed contracts
- None yet (design only, code starting now). Proposed in ADR 0041: `lib/git-safe.js` gains
  `gitWithAskpass` (fd-based token, forced no-credential-helper); `core/vault/providers.js` gains
  a `github-oauth` entry; `core/vault/remind.js` gains a `github-pat` reason;
  `core/projects/index.js`'s caller allowlist for `projects.create`/`add-workspace` may gain
  `module:github`.
