# Vyre

[![node](https://github.com/vyre-ai/vyre/actions/workflows/node.yml/badge.svg)](https://github.com/vyre-ai/vyre/actions/workflows/node.yml)
[![capsule-mac](https://github.com/vyre-ai/vyre/actions/workflows/capsule-mac.yml/badge.svg)](https://github.com/vyre-ai/vyre/actions/workflows/capsule-mac.yml)
[![ios](https://github.com/vyre-ai/vyre/actions/workflows/ios.yml/badge.svg)](https://github.com/vyre-ai/vyre/actions/workflows/ios.yml)
[![android](https://github.com/vyre-ai/vyre/actions/workflows/android.yml/badge.svg)](https://github.com/vyre-ai/vyre/actions/workflows/android.yml)

Vyre runs Claude Code on a machine you own and adds what Claude Code leaves out: projects,
memory across every session, agents on your own quota, a vault, and your own address on your
own Tailscale network, `<you>.vyre.run`.

```
npm install -g vyre
vyre up
```

Vyre is a Claude Code plugin plus one small daemon. It does not fork or wrap Claude Code. When
Claude Code improves, Vyre improves with it.

## What you get

- **Claude Code on your box.** A server you control, reachable from your laptop and your phone.
  Untrusted code never runs on your own computer.
- **Projects and threads.** Pick sessions into projects by hand. A session can sit in more than
  one. `vyre` in any folder opens that project and its context.
- **Recall and memory.** Search every session you have had. Answers that came from memory show
  in gold, so you can tell them from what the model made up.
- **The Capsule.** Press Ctrl Ctrl on your Mac: `@` any agent, project or file, and send work to
  the box without leaving what you are doing.
- **Agents on your own subscription.** Each agent runs on a setup token or an API key with a
  budget, and gets its own computer.
- **A vault.** Agents use credentials nobody sees. Share one item with another person's Vyre;
  it is relayed by default, so one revoke ends their access. Nobody walks out with an env file.

## Status

Early. The daemon, module loader, event log and CLI work (milestone M0). See
[`docs/SPEC.md`](docs/SPEC.md) for the design and the milestones, and
[`docs/work/`](docs/work/) for what each workstream is doing now.

## Develop

Needs Node 22.5 or newer. No build step, no dependencies.

```
npm test
VYRE_HOME=$(mktemp -d) bin/vyre up
bin/vyre call system.echo '{"text":"hi"}'
bin/vyre down
```

Write a module: [`docs/MODULES.md`](docs/MODULES.md).

## Licence

Apache 2.0. See [`LICENSE`](LICENSE).
