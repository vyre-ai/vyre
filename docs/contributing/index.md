---
title: Contributing
summary: How to change Vyre: where the code lives, the engineering rules every change follows, the changelog, decision records, and how to run the tests.
audience: builders, agents
owner: integrator
status: stable
---

# Contributing

Vyre is plain JavaScript on Node 22.5 or newer, with no build step for the core and almost no dependencies. This page is what you need before your first change: where things live, the rules a change is held to, and how to check it. The rules come from [Section 14 of the spec](../architecture/spec.md#14-engineering-rules); where the spec and the code disagree, one of them is a bug.

## Get the code running

```
git clone https://github.com/vyre-ai/vyre
cd vyre
npm test
```

Try a change against a throwaway home, never your real `~/.vyre`. Export `VYRE_HOME`, so every command after it uses the same home:

```
export VYRE_HOME=$(mktemp -d)
bin/vyre up --json
bin/vyre call system.echo '{"text":"hi"}'
bin/vyre down
unset VYRE_HOME
```

```output
{
  "text": "hi"
}
```

`--json` keeps `vyre up` on a Mac from asking where your box runs. A temp `VYRE_HOME` also means Vyre raises no dialogs (Touch ID, keychain, browser tabs) unless you set `VYRE_ALLOW_DIALOGS=1`. See [Testing](testing.md#dialogs).

## Where things live

| Folder | What is in it |
| --- | --- |
| `bin/` | `vyre` (the CLI entry) and `git-credential-vyre` |
| `core/` | every service inside `vyred`, one folder each, and `core/cli/commands/` for the CLI |
| `harness/` | the Claude Code plugin: hooks, the MCP server, skills, the `/vyre` command |
| `local/` | Mac-only modules: `capsule`, `hands-mac` |
| `apps/app/` | the Vyre app (Expo): web build, iPhone and Android, including `src/chat` and `screens/glass` |
| `modules/` | first-party optional modules |
| `box/` | the server's Docker stack and host wrapper |
| `site/` | vyre.run |
| `scripts/` | install, release, `perf-check`, and the docs tooling |
| `docs/` | these pages, the spec, ADRs; `docs/work/` holds internal workstream notes that are never published |
| `test/` | cross-module tests; unit tests sit beside their code as `*.test.js` |

The full tree is [Section 3 of the spec](../architecture/spec.md#3-repository-layout), and the layers are explained in [Architecture](../architecture/index.md).

## The rules every change follows

- **Tests beside the code**, with `node --test`. A bug fix comes with the test that would have caught it. Tests never touch your real `~/.vyre` or real transcripts; they get a temp `VYRE_HOME`.
- **Real data before merge.** Anything that talks to Claude Code or a network is exercised for real once before it merges, not only against a fake.
- **The changelog** is updated with every change (see below).
- **Conventional commits** (`feat:`, `fix:`, `refactor:`, `docs:`, `test:`), one concern each, committed by path (`git commit -m "..." -- <paths>`) so parallel sessions never sweep up each other's files.
- **No secrets and no personal data** in code, tests, fixtures or commits. `test/hygiene.test.js` fails when shipped code names a real person or business or holds something shaped like a key. Examples use the sample world: the user alex, Juniper Studio, Northwind Bakery, the agents juno and kit, and `example.com`.
- **Principles hold.** Public Claude Code surfaces only, local first, one process per machine, everything a module, light by default. A change that breaks one needs a spec change first. See [Section 2 of the spec](../architecture/spec.md#2-principles).
- **Every feature merges with its doc page.** A feature is not done until the page that describes it says what it does. See [Writing the docs](../CONTRIBUTING-DOCS.md).

## The changelog

`CHANGELOG.md` at the root, newest first. Every change to code lands there in the same commit, under `## Unreleased`, in plain sentences that say what changed and why. A new dependency says why it is worth having. The docs site shows it as the [Changelog](../changelog.md).

## Decision records

Write an ADR in `docs/adr/` for any decision a future contributor would ask about: a trade-off, a boundary, a thing you chose not to do. Number it next in sequence, and follow the shape of the existing ones: front matter like any page, a title `ADR NNNN: <decision>`, a status line (proposed or accepted, the date, the workstream, the spec sections it touches), then the problem, the decision, and its consequences. Add it to `docs/nav.json`. The list is in [Architecture](../architecture/index.md#decision-records).

## Run the tests

```
npm test                      # the whole suite, with the temp-folder leak guard around it
node --test core/vault/*.test.js   # one area
npm run perf-check            # the idle budgets: a real vyred sampled for 60 s
npm run docs:check            # the docs contract
```

CI runs `npm test` and `npm run perf-check` on Ubuntu and macOS, on Node 22 and 24, for every push and pull request. How the suite is organised, the helpers, and the fakes are in [Testing](testing.md).

## Where to go next

- [Testing](testing.md)
- [Writing the docs](../CONTRIBUTING-DOCS.md)
- [Writing a module](../build/writing-a-module.md)
