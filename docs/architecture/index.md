---
title: Architecture
summary: How Vyre is put together: one daemon per machine, three layers (Core, Harness, Local), the surfaces on top, the repository layout, and where the decisions are recorded.
audience: builders, operators, agents
owner: docs
status: stable
---

# Architecture

Vyre is one small daemon, `vyred`, on each machine you own, plus a Claude Code plugin. Everything else is a module the daemon loads. This page is the map. The [specification](spec.md) is the source of truth for every detail, and the [decision records](#decision-records) say why each hard choice went the way it did.

## One process per machine

`vyred` runs every service on its machine ([Section 2 of the spec](spec.md#2-principles), principle 3). It is the same code on the box and on the Mac, with different modules enabled, chosen by `role` in `~/.vyre/config.json` (`box` or `local`). Most Core modules run on both; a few run only on the box (names, onboarding, agents' computers, Glass), and the Local modules run only on the Mac. The exact split is in [The box and the Mac](../concepts/box-and-mac.md#one-process-per-machine). The `vyre` CLI is a thin client: every command is a call to `vyred`, over its unix socket (`~/.vyre/vyred.sock`) on the same machine or its HTTP API from elsewhere.

Everything is a module, including the core services, and every module uses the same contract: a `module.json` manifest and an entry file that registers tools and emits events. See [Modules](../concepts/modules.md) and [The module contract](../build/module-contract.md). The loaded set on this branch is listed in the [module reference](../reference/modules.md).

## The three layers

| Layer | Where it runs | What it is | Code |
| --- | --- | --- | --- |
| Core | the box (and the Mac, for the parts a Mac needs) | The services inside `vyred`: config, the store (SQLite through `node:sqlite`), the event log, the module loader, projects and threads, recall, memory, the vault, watchers, the Gate, the Switchboard (headless sessions), agents, computers, names and certificates, pairing, files, presence, learning, push. | `core/` |
| Harness | inside every Claude Code session Vyre starts | A Claude Code plugin, loaded with `--plugin-dir` so your global Claude Code setup is never changed. Hooks (Brief at session start, Enrich on each prompt, Rules before each tool call, Learn after file changes and commands, Stop at the end of each turn), the `vyre` MCP server that exposes module tools to Claude, three skills and the `/vyre` command. All hooks run one script, `harness/hooks/hook.js`, which calls `vyred`. If `vyred` is not running, Rules still runs in-process, so the floor holds. | `harness/` |
| Local | the Mac only | The Capsule (the Control-twice command bar) and `hands-mac` (computer use through the macOS accessibility tree). | `local/` |

Optional first-party modules live in `modules/`: `hands-desktop` and `hands-chrome` (module name `chrome`) for agents' computers. `modules/vault-extension` is not a vyred module: it is the browser extension for vault autofill.

The box and the Mac are paired into one system by `core/link`: the Mac can call the box's tools, and the box's events reach the Mac. See [The box and the Mac](../concepts/box-and-mac.md).

## Surfaces

Every surface talks to `vyred`'s API. None reads the store directly ([Section 9 of the spec](spec.md#9-surfaces)).

| Surface | What it is | Built from |
| --- | --- | --- |
| CLI | `vyre`: home, projects, threads, agents, vault, up, status, and `vyre call` for any tool. | `core/cli` |
| Capsule | The command bar on the Mac: press Control twice, talk to the assistant, an agent or a session. | `local/capsule` |
| Deck | The web app at your address: Now, Projects, Memory, Agents, Chat, Vault, Settings. | `deck/` |
| Chat | Projects, then every Claude Code session on the machine, each shown as a readable conversation that follows the terminal live. Sending from Chat drives the same session. | `deck/chat` |
| Glass | An agent's screen, live, with take-over. | `deck/glass` and `core/computers` |
| Phone | The Deck installed on the phone, with a phone tab bar (Now, Projects, Chat, Ask, Agents) and Web Push. A native app is not built. | `deck/` |

A thread is one thing wherever it is viewed, and one screen types into it at a time (floor rules 3 and 4). Every session is a real Claude Code session, in a terminal or headless under the Switchboard; Vyre never imitates Claude Code.

## Repository layout

The full tree is [Section 3 of the spec](spec.md#3-repository-layout). In short:

```
bin/vyre          the CLI entry (thin: checks the Node version, calls core/cli)
core/             services that run inside vyred, one folder each
harness/          the Claude Code plugin: hooks, MCP server, skills, commands
local/            Mac-only modules: capsule, hands-mac
deck/             the web app vyred serves
modules/          first-party optional modules
box/              the Docker stack for a server: Dockerfile, compose.yml, the host wrapper
site/             vyre.run: the landing page (build-site.sh adds the installer)
scripts/          install, release, perf-check, and the docs tooling
docs/             these pages, the spec, the ADRs
test/             cross-module tests; unit tests sit beside their code
```

Runtime data never lives in the repository. It lives in `~/.vyre/` (override with `VYRE_HOME`): `config.json`, the store `vyre.db`, the sealed `vault/`, installed `modules/`, `watchers/`, `certs/`, `models/`, `logs/` and the socket. On a Docker box that folder is inside the `vyre_vyre-home` volume. See [Looking after the box](../using/box-care.md).

## Principles that shape the code

The nine principles are in [Section 2 of the spec](spec.md#2-principles). The ones you meet first when reading the code:

- **Public Claude Code surfaces only.** Plugins, hooks, MCP and documented CLI flags. Reading transcript files is the one exception, kept in a single adapter, `core/transcripts`.
- **Local first.** Nothing leaves your machines except through the Gate.
- **Boring, readable code.** Node 22.5 or newer, ES modules, plain JavaScript with JSDoc types and `// @ts-check`, no build step for the core, `node:sqlite`, `node:test`. A dependency needs a reason in the changelog.
- **Light by default.** Idle budgets for `vyred`, the Capsule and the Deck. `scripts/perf-check` holds `vyred` to its budget in CI; the Capsule and the Deck are measured by hand. See [Performance](performance.md).
- **The security floor cannot be configured away.** See [the floor](../concepts/floor.md) and [Security](../security/index.md).

## Decision records

Architecture decision records live in `docs/adr/`. Each states the problem, the decision and its consequences.

| ADR | Decision |
| --- | --- |
| [0001](../adr/0001-vault-crypto.md) | How the vault seals, releases and shares credentials |
| [0002](../adr/0002-network-and-identity.md) | Network and identity: tailnet listeners, callers identified by `tailscale whois` |
| [0003](../adr/0003-glass-stream.md) | How Glass streams an agent's screen, and who may type into it |
| [0004](../adr/0004-presence.md) | Presence: proving a person is there before a human-only action |
| [0005](../adr/0005-glass.md) | Glass: a remote computer you can watch, take over, sign in on and browse |
| [0006](../adr/0006-vault-next.md) | The vault, next: a key hierarchy and presence on every value (proposed) |
| [0007](../adr/0007-intelligence.md) | The memory graph and the learning loop |
| [0008](../adr/0008-install-journey.md) | The install journey (proposed) |
| [0009](../adr/0009-container-hardening.md) | Hardening an agent's container |
| [0010](../adr/0010-vault-autofill.md) | Vault autofill |
| [0011](../adr/0011-web-push.md) | Web Push for the moments you are needed |
| [0012](../adr/0012-cdp-proxy.md) | Chrome's debugging port never leaves the container unauthenticated |
| [0019](../adr/0019-docs-site.md) | This docs site: one source in `docs/`, checked and built without a framework |

## Where to go next

- [Specification](spec.md), the whole design.
- [Performance](performance.md), the budgets and how they are measured.
- [Security](../security/index.md), the model in one page.
- [Contributing](../contributing/index.md), if you want to change any of this.
