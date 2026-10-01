---
title: Modules
summary: Why everything in Vyre is a module, the kinds (core, Harness, surfaces, optional and third-party), and how vyred finds, orders and starts them.
audience: users, builders, agents
owner: docs
status: stable
---

# Modules

Every service in Vyre is a module on one contract: projects, recall, the vault, Lumen, and anything you install yourself. A module is a folder with a `module.json` that says what it does, and an entry file that exports `start(ctx)`. Because every module is wired the same way, a new one shows up to Claude (as an MCP tool), to the surfaces (over HTTP) and to the terminal (through `vyre call`) without special cases. The contract itself is on [the module contract](../build/module-contract.md).

## Kinds of module

| Kind | Where it lives | Examples |
|---|---|---|
| Core | `core/<name>/` in the Vyre package | `projects`, `recall`, `memory`, `vault`, `watchers`, `threads`, `sessions`, `gate`, `names`, `link`, `relay`, `artifacts`, `github`, `team`, `spend` |
| Harness | `core/harness/`, called by the Claude Code plugin in `harness/` | `harness` (Brief, Enrich, Rules, Learn and Stop, as tools the hooks call) |
| Surfaces and Mac pieces | `local/<name>/` | `capsule` (Lumen), `hands` (computer use on macOS), `chrome` (Vyre for Chrome on the Mac), `voice`, `screen` |
| First-party optional | `modules/<name>/` | `hands-desktop`, `chrome` (the box's side of Vyre for Chrome) |
| Yours, or third-party | `~/.vyre/modules/<name>/` | anything you write or install |

The kind changes nothing about the contract. A module you write gets the same `ctx` as the vault does.

Some parts of vyred are plumbing, not modules, and have no `module.json`: the config, the store, the event log, the loader, the daemon, the CLI and the transcript adapter (`core/config`, `core/store`, `core/events`, `core/modules`, `core/daemon`, `core/cli`, `core/transcripts`). Every module gets them through `ctx`. Do not list them under `requires`.

A module's name comes from its manifest, not its folder: `core/switchboard/` is the `threads` module, `local/hands-mac/` is `hands`, and `modules/hands-chrome/` and `local/hands-chrome-mac/` are both `chrome`, the box's side and the Mac's side of Vyre for Chrome. See [modules](../reference/modules.md) for the full list.

## How vyred loads them

When vyred starts, it:

1. **Discovers.** It looks for a `module.json` one level down in each of these folders, in this order: `core/`, `local/`, `modules/` (all in the Vyre package), then `~/.vyre/modules/`.
2. **Validates** each manifest (the rules are on [the module contract](../build/module-contract.md#what-the-loader-checks)). An invalid one is recorded as `invalid` with its problems and never started.
3. **Picks** the modules for this machine. A module runs when this machine's kind (solo, server or device, see [the box and the Mac](box-and-mac.md)) maps to one of its `roles`, `box` or `local` (both when omitted), or when `config.json` lists it under `modules.enable`. `modules.disable` switches one off whatever its roles say.
4. **Orders** them so each starts after everything it `requires`. A missing dependency or a cycle fails the module that needs it.
5. **Starts** them one at a time: imports the entry file (`index.js`, or the manifest's `main`), then awaits `start(ctx)`.

If two modules share a name, the first one found wins. Vyre's own folders come before yours, so a module of yours named `vault` is reported as ignored and does not replace the vault. The one shared name is `chrome`, which Vyre ships twice for different machines: the copy that is not on for this machine steps aside and is listed as off.

## When a module fails

A module that throws in `start`, fails validation, or needs one that is not running is marked `failed` or `invalid` with the reason. Its tools, streams and routes are removed. The rest of vyred keeps running: one broken module never takes down search or the vault.

```
vyre modules      # every module, its version, and whether it started
vyre status       # counts running and failed modules
```

## Install a module

Put its folder in `~/.vyre/modules/` and restart vyred:

```
vyre down && vyre up
vyre modules
```

A module runs inside vyred, as you, with access to the store. Install only code you trust. In a Claude Code session with the Vyre plugin, a write into `~/.vyre/modules/` is asked about before it happens, because of that.

## Next

- [The module contract](../build/module-contract.md): the manifest and `ctx`.
- [Tools and events](../build/tools-and-events.md): a worked example.
- [Writing a module](../build/writing-a-module.md).
- [The box and the Mac](box-and-mac.md): which modules run where.
