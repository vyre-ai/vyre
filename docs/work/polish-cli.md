# polish-cli

Branch: work/polish-cli · Worktree: ../vyre-polish-cli · Owner session: polish-cli

## Scope

Driving Vyre from the terminal feels as native as Claude Code's own. Owns `core/cli/screen/`,
`core/cli/kit.js`, `scripts/stress-drive`, and the consistency pass over `core/cli/commands/*`.

1. `vyre` with no arguments: one live screen. Inbox (held drafts, open asks), projects, sessions
   and agents on the left; the selected session's output streaming on the right.
2. Every command: same verbs, `--json` on every read, exit codes 0/1/2, errors that name the
   next step, no stack traces, `vyre help <cmd>`.
3. `scripts/stress-drive`: 4 headless threads for 30+ minutes on the fake Claude.

## Done

- Install size (lead's top priority, user said yes): `npm i -g vyre` 750 MB -> 5.9 MB on disk
  (4.5 MB of files), tgz 1.50 MB before and after, measured on the test box from `npm pack` into an
  empty prefix. The embedder is fetched on first use into <VYRE_HOME>/embedder (pinned
  transformers 4.3.0, pruned 500 -> 105 MB), keyword search until then, `vyre recall --setup`
  to fetch now (16 s on the test box, real network, temp home). Tests: core/recall/embed-install.test.js
  (fake npm, no network). The 2 MB target: the rest is Vyre's own code, deck and docs.

## Done (2)

- vyre update keeps the pending onboarding link (lead's add): `vyre up --keep-link`,
  `onboard.link {mint:false}`, link hash and sessions survive a vyred restart. Tests:
  test/onboard.test.js (restart survival), core/cli/commands/up.test.js. 
- Commit stamp (lead assigned it to me): build.json from build-site.sh; /v1/health, system.info,
  vyre status. Test core/daemon/build.test.js.

## Doing

- `vyre threads` prints nothing; `vyre threads --help` crashes; two vyreds on a symlinked home
  (realpath the home for the pid/lock). Then the interactive `vyre` screen.

## Next

## Needs from others

- tailnet: `link.health` shape for the status line (asked).
- connectors: `vyre connect` conventions and any tool the screen should show (asked).

## Changed contracts

- onboard (owner: onboarding team): `onboard.link` takes `{mint:false}` and then returns
  `{url:null, pending, expires, port}`; loopback keeps hashes in <VYRE_HOME>/onboard-link.json.
- box/vyre: `update` ends with `cli up --keep-link`.
- daemon/system: /v1/health and system.info gain `commit`, `dirty`; scripts/build-site.sh
  stamps build.json; package.json files gains build.json.

- recall (owner: recall team): `package.json` has no optionalDependencies; `core/recall/embed.js`
  installs the library on first use (`install`, `installed`, `load({ runtime, npm })`, `PACKAGE`,
  `RANGE`, `DOWNLOAD_MB`); new tool `recall.setup` in module.json; `recall.status.vectors.ready`;
  config `recall.embedder`, `recall.npm`. docs/work/recall.md still says "optionalDependencies".
- ci/release: `scripts/release-check.sh` asserts no optional deps and an install under 10 MB.
- learn (merge): the learn CLI uses kit exits, so a refused presence is 3 and a usage slip 2
  (test/cli.test.js updated).
- Known, not mine: core/cli/commands/box.test.js "sudo with a password ... docker group" fails
  on the test box (its user is already in the docker group, so the step is never offered).
