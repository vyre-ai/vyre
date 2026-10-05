---
title: Vyre docs
summary: What Vyre is, which part of these docs is for you, and the shortest path from nothing to a working first day.
audience: users, builders, operators, agents
owner: docs
status: stable
---

# Vyre docs

Vyre runs Claude Code on a machine you own and adds what Claude Code leaves out. Your sessions run on a server you control (the box), so untrusted code never touches your laptop and you can reach them from anywhere. Vyre sorts those sessions into projects and threads, remembers what was said across all of them, and marks in gold anything that came from memory rather than a model. You can launch agents that run on your own Claude subscription or an API key with a budget, each with its own computer. A built-in vault lets agents use credentials nobody sees. Tailscale puts it all at your own private address, reachable only from your devices. Vyre is not a fork or a wrapper: it plugs into Claude Code as a plugin, and improves when Claude Code does. The full statement is [Section 1 of the spec](architecture/spec.md#1-what-vyre-is).

## Start here

The fastest path, in order:

1. [Install](get-started/install.md): put Vyre on a Linux server and your Mac. From the Mac it is one command.
2. [Onboarding](get-started/onboarding.md): six screens in the browser. Your name, Claude sign-in, your address, your history, your devices.
3. [Your first day](get-started/first-day.md): open the Capsule, start a thread in a project, launch an agent, store a secret, find something from last week.

On a Mac, the install starts here:

```
npm install -g https://vyre.run/box/vyre.tgz
vyre up
```

Vyre is not on npm yet, so the package comes from vyre.run. `vyre up` asks where Vyre should run; pick a server and give it the address you SSH to (for example `alex@192.0.2.10`). If something stops you, see [Troubleshooting](get-started/troubleshooting.md). No Docker on the server? See [Without Docker](get-started/without-docker.md).

## Who each section is for

| Section | For | What is in it |
| --- | --- | --- |
| [Get started](get-started/install.md) | users | Install, onboarding, the first day, fixes for common failures. |
| [Using Vyre](using/capsule.md) | users | One page per surface and feature: the Capsule, the Deck, Chat, the CLI, projects and threads, agents, the vault, memory, watchers, connectors, Tailscale, the phone, looking after the box. |
| [Concepts](concepts/box-and-mac.md) | users, builders | The ideas the rest leans on: the box and the Mac, the tailnet, presence, the security floor, modules. |
| [Build on Vyre](build/module-contract.md) | builders, agents | The module contract, tools and events, writing a module, the MCP hub. |
| [Reference](reference/cli.md) | everyone | Generated from the code: every [command](reference/cli.md), [tool](reference/tools.md), [event](reference/events.md), [config key](reference/config.md) and [module](reference/modules.md). |
| [Architecture](architecture/index.md) | builders, operators | Layers, surfaces, the repository, the [spec](architecture/spec.md), [performance](architecture/performance.md), and the decision records. |
| [Security](security/index.md) | operators, builders | The floor, how the vault seals values, who can reach the box, container hardening, how to report a problem. |
| [Contributing](contributing/index.md) | builders | Repository layout, engineering rules, [tests](contributing/testing.md), and [how to write these docs](CONTRIBUTING-DOCS.md). |
| [Changelog](changelog.md) | everyone | What changed, newest first. |

## For agents

Every page on this site is also served as its Markdown source at the same path with `.md` on the end. `https://docs.vyre.run/using/vault` is the rendered page, and `https://docs.vyre.run/using/vault.md` is its source, front matter included.

Two more files follow the llms.txt convention:

- [/llms.txt](/llms.txt): an index of every page, by section, each with its `.md` link and one-line summary.
- [/llms-full.txt](/llms-full.txt): every page's Markdown in nav order, in one file.

Each page's front matter says who it is for (`audience`) and whether it is shipped (`status: stable`), partly shipped (`draft`) or not built yet (`planned`). Treat a `planned` page as a description of intent, not of the code. The contract behind all of this is in [Writing the docs](CONTRIBUTING-DOCS.md).
