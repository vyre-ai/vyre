---
title: Testing
summary: How Vyre's tests are organised, the helpers and fakes they use, how to run one area, and how the idle budgets are checked.
audience: builders, agents
owner: e2e
status: stable
---

# Testing

Vyre's tests use the built-in `node:test` runner and nothing else. Unit tests sit beside their code as `*.test.js`; tests that cross modules live in `test/`. Every test gets its own throwaway `VYRE_HOME`, and none may touch your real `~/.vyre`, your real transcripts or your screen. This page covers how the suite is laid out, the helpers that keep it off your machine, and how to run a part of it.

## What `npm test` runs

`npm test` is `node --test` over these globs, from `package.json`:

```
core/**/*.test.js
test/**/*.test.js
deck/**/*.test.js
modules/**/*.test.js
local/*/*.test.js
local/*/lib/*.test.js
```

A new test file anywhere under those paths is picked up without registering it.

Two lifecycle scripts wrap the run. `pretest` and `posttest` run `test/tmp-guard.mjs`, the leak guard. It fails the run when a test left something behind:

- a folder under this checkout's scratch folder (below) that appeared during the run;
- a new `vyre-*`, `vy-*`, `vssh-*` or `computerd-*` entry left bare in `$TMPDIR`. Only entries that did not exist before the run and changed after it began count, so another worktree's old leftovers do not fail yours. `vyre-presence-<uid>`, the Touch ID helper's build cache, is meant to stay and is never counted.

For a leaked test home, the guard names the test file and the test that made it.

## The scratch folder

`test/scratch.mjs` exports `SCRATCH`: the one folder under `$TMPDIR` that tests in this checkout may create directories in. Its name is `vt-` plus six hex characters hashed from the checkout's path, so two worktrees running the suite at once never see each other's folders. It is short on purpose: a test's `vyred` puts its unix socket under its `VYRE_HOME`, and macOS limits a socket path to about 100 bytes.

Make temp folders under `SCRATCH`, never bare in `os.tmpdir()`, and remove them in `t.after`. A module that saves on a timer (a 500 ms debounce, say) must save or stop before the test removes its folder, or the timer makes the folder again after the test ends.

`test/scratch.mjs` also sets `VYRE_TMPDIR` to `SCRATCH`, for this process and every `vyre` or `vyred` a test spawns. Product code that makes its own temp folders (backup staging in `core/names/backup.js`, image thumbnails in `core/files/index.js`) puts them under `VYRE_TMPDIR` when it is set, so those stay inside `SCRATCH` too.

`tempHome` writes one line per home to `<SCRATCH>.homes` (the folder, the test file, the test name). The file sits beside `SCRATCH`, not in it, so it survives the home's removal; the leak guard reads it to name the test behind a leak.

> [!SNAG] tmp-guard fails with a folder you did not make
> A sibling worktree running an older suite at the same moment can leave a bare `vyre-*` entry that lands inside your run's window. The guard prints the entry's name; if no test in your checkout makes a folder with that prefix, rerun `npm test` once the other run is done.

## Helpers

`test/helpers.js` is the only way a test gets a home:

| Helper | What it does |
| --- | --- |
| `tempHome(t)` | Makes a folder under `SCRATCH`, sets `VYRE_HOME` to it for the test, and restores it after. Throws if the folder would be the real `~/.vyre`. After the test it stops any `vyred` the test started in that home, then removes the folder. |
| `writeModule(root, name, manifest, source)` | Writes a module folder (`module.json` and `index.js`) for loader and contract tests. |
| `present` | A presence verifier that always finds a person, for testing what a tool does after approval. Presence's own tests use the real one. |
| `upPresent(home)` | Starts `vyred` in a child process for a temp home with `present` as its verifier (`test/fixtures/vyred-present.js`, which refuses any home outside the temp folder). |

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { tempHome } from "../../test/helpers.js";

test("a project keeps its name", async t => {
  const home = tempHome(t);
  // ... start what you need against `home` ...
});
```

## Fakes for outside services

No test runs the real `claude`, `ssh`, `docker` or a browser. Each outside program is reached through an environment variable that a test points at a fake:

| Variable | Replaces | Read in |
| --- | --- | --- |
| `VYRE_CLAUDE_BIN` | `claude` | `core/switchboard`, `core/onboard` |
| `VYRE_SSH_BIN` | `ssh` | `core/cli/ssh.js` |
| `VYRE_OPEN_BIN` | the command that opens a browser | `vyre up`, `vyre box` |
| `VYRE_HANDS_BIN` | the macOS accessibility helper | `local/hands-mac` |

The fakes themselves:

- `core/switchboard/testing/fake-claude.js`: a `claude` that speaks `stream-json`, so the Switchboard and agents run end to end against a real `vyred`.
- `core/computers/driver/fake.js`: an in-memory Docker driver that enforces the Engine's state rules (no pausing a stopped container), so a pool bug fails here as it would on the box.
- `test/journey/`: the install journey rig. `rig.js` builds a fresh Mac and a fresh Linux server as two temp homes on this machine, with fake `ssh` and `docker` and a port forward. The `vyred` on each side, `vyre box add`, `vyre up`, the installer and the onboarding page are real. `test/journey.test.js` drives it.
- `test/fixtures/corpus.js`: a small fictional corpus (alex, Harlow Legal, Northwind Bakery, the agents juno and kit), written as real Claude Code transcripts for the transcripts adapter and Recall.
- `deck/fixtures/*.json`: canned tool replies for Deck views.

The rule from the spec still holds: anything that talks to Claude Code or a network is also exercised for real once before it merges. A fake proves the logic, not the integration.

The suite also runs on Linux. Where Node has no Argon2id (before 24.7), the vault tests' cheap password key uses scrypt at its test floor instead (`TEST_KDF` in `core/vault/testing.js`), and the tests of the real Capsule helpers skip off macOS.

## Dialogs

A test must never raise anything on the screen: a Touch ID prompt, a keychain prompt, a browser tab, the Capsule. `dialogsAllowed()` in `core/config/dialogs.js` is the one check, and the code that could raise one asks it first. It returns false:

- when `VYRE_NO_DIALOGS=1`, always;
- under `node --test` (it sees `NODE_TEST_CONTEXT`, which child processes inherit), unless `VYRE_TEST_DIALOGS=1` is set by a person at the machine running one test on purpose;
- when `VYRE_HOME` is anything but `~/.vyre`, unless `VYRE_ALLOW_DIALOGS=1`.

A refused dialog returns the error code `no_dialog`. Set `VYRE_NO_DIALOGS=1` in any script that runs a real `vyred` unattended.

## Run part of the suite

```
node --test core/vault/*.test.js                 # one area
node --test test/journey.test.js                 # the install journey
node --test --test-name-pattern "pass" core/vault/*.test.js   # tests whose name matches
node --test test/docs-check.test.js test/docs-build.test.js   # the docs tooling
```

Run from the repository root. A targeted run skips the `tmp-guard` wrapper, so check `SCRATCH` yourself if you suspect a leak.

## Measured, not only passed

- `npm run perf-check` (`scripts/perf-check`) holds `vyred` to the idle budget in [Section 2 of the spec](../architecture/spec.md#2-principles), principle 8. It builds a throwaway home, seeds the fixture corpus plus a synthetic one of about 20,000 turns, starts a real `vyred`, waits for indexing to finish, then samples it for 60 seconds of idle. It fails on CPU above budget, more than 50 MB of heap in use after a full GC, a settled resident size over 150 MB or a startup peak over 200 MB in the first 30 seconds (both on the Node the box ships), or any timer that repeats faster than once a minute. CI runs it after `npm test`. See [Performance](../architecture/performance.md).
- `npm run eval:memory` (`scripts/eval-memory.js`) scores memory on a fictional world: whether facts are right, and that none leaks from one project to another. `test/eval/memory-eval.test.js` runs it under `npm test` against `test/eval/memory-baseline.json`; `npm run eval:memory -- --write-baseline` rewrites the baseline.
- `npm run docs:check` holds these docs to their contract. See [Writing the docs](../CONTRIBUTING-DOCS.md).

## CI

`.github/workflows/test.yml` runs `npm test` and then `npm run perf-check` on Ubuntu and macOS, with Node 22 and 24, on every push and pull request.

## Where to go next

- [Contributing](index.md)
- [Writing a module](../build/writing-a-module.md)
