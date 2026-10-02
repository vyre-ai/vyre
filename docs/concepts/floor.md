---
title: The security floor
summary: The nine rules Vyre keeps whatever the settings say, and for each one, the code that enforces it today and what is not enforced yet.
audience: users, builders, operators, agents
owner: docs
status: draft
---

# The security floor

The floor is nine rules that hold whatever you configure, enforced outside the model so that no prompt can talk Vyre out of them. They come from Section 11 of the [spec](../architecture/spec.md). A change that would loosen one needs a spec change first. This page lists each rule and what enforces it in the code today. Where enforcement is partial, it says so.

The status is `draft` because several rules are only partly enforced.

## Where the floor lives

- **The Harness `PreToolUse` hook** (`core/harness/rules.js`), for every tool call Claude Code makes in a session that loads the Vyre plugin. It can only deny or ask; it never loosens Claude Code's own permissions. It also runs in-process when vyred is down (`harness/hooks/hook.js`).
- **The same rules in vyred** (`registryRules` in `core/harness/rules.js`), for every tool call through the module registry that does not come from you at your own surface. The CLI, Lumen, the Deck and `local`, naming no agent, are left to presence and the Gate. Every other caller (an agent through the Switchboard or MCP, a module, a device on the tailnet) gets the rules' answer, and an "ask" becomes a refusal, since nobody is there to say yes.
- **A separate user for sessions, on a Docker box.** The sessions Vyre runs itself (the assistant, agents, chat) run as `vyre-agent`, which cannot open vyred's socket. A tailnet device or a paired phone is also not "you" until you sign in on it with a passkey (see [presence](presence.md)).
- **Presence** (`core/presence`), checked by vyred on every call to a human-only tool, whoever the caller is. See [presence](presence.md).
- **The Gate** (`core/gate`), which holds what would go out as you until you approve the final words.
- **The event log** (`core/events`), which refuses payloads that look like secrets.

## 1. Nothing goes out as you until you have seen the final words

Enforced:

- The Gate holds sends, and `gate.approve`, `gate.revise` and `gate.reject` need presence. The Gate refuses an approval from an `mcp` caller outright.
- In your own session, an MCP tool whose name means sending (`send`, `post`, `reply`, `forward`, `publish`, `share`, `invite`, `tweet`, `dm`, `comment`) is asked about before it runs. Names that also say `draft`, `list`, `get`, `search` or `read` are left alone.
- Inside an agent's thread, such a tool is denied (`gate.route`), and the agent is told to file it with `gate.request` instead.
- The Harness denies the model's ways around presence: human-only `vyre` commands, raw clients on vyred's socket, and forged `x-vyre-caller` or `x-vyre-presence` headers.

Not enforced yet: a send made some other way, such as a `curl` to a mail API from Bash, is not recognised as a send.

## 2. You always see where something is going before it goes

Enforced: the Harness question for a sending tool names the destination, taken from `to`, `channel`, `recipient`, `email` and similar input keys, or says "an unnamed destination". The Gate's presence summary for `gate.approve` is the destination and the start of the final content, and every presence method shows it before you prove anything.

## 3. A thread is one thing wherever it is viewed

Enforced by design: a thread's id is its Claude Code session id, fixed with `--session-id` before the process starts, so the terminal, the Deck, Lumen and Chat all name the same session. There is no Vyre copy to drift from it. No separate runtime check exists.

## 4. One screen types into a thread at a time

Enforced: the Switchboard's lease (`threads.lease`, `core/switchboard/lease.js`). Typing needs the lease; the other surfaces go read-only and are told who holds it. A lease unheard from for 90 seconds is free, and taking it over is recorded. Take-over of an agent's computer uses the same lease.

Partial: a `claude --resume <id>` in your terminal takes no lease, because Claude Code does not know Vyre exists. vyred detects it (`core/switchboard/claim.js`) and refuses to adopt a session another process is writing. The Harness warns when a terminal session resumes a conversation vyred is running headless, but lets it start.

## 5. Every file change is visible, including changes a command made without saying so

Enforced for file tools: after `Write`, `Edit`, `MultiEdit` and `NotebookEdit`, the Harness records the file and emits `file.touched`. `harness.touched` lists a thread's changed files, newest first.

Not enforced yet: files a `Bash` command changes are not recorded.

## 6. Only an explicit question from an agent asks for your attention

Enforced in the surfaces: Lumen turns its menu-bar dot on for a permission question or a Gate hold and never opens itself or takes the keyboard. Web Push sends only a fixed set of kinds (a session asking, something held at the Gate, a thread you chose to watch, a proposed lesson, planner items, goals, proactive notes and notices). You can turn each off except notices, and quiet hours apply, except that a notice that a guard was loosened rings through them.

No central check stops a module from raising some other notification.

## 7. Anything Vyre tells you, it can show the source of

Enforced for memory and recall: every fact in Memory keeps the turn it came from, and `memory.why` returns the turns that support a fact. Enrich marks memory it adds to a prompt with its source, age and confidence. Lumen opens the turn a recalled answer came from.

## 8. No vault value appears on any screen, log or event

Only a person who has just proved presence on their own device sees a value, and only that one. Never a model, an agent, a log or an event.

Enforced:

- The Harness denies any tool call that names the vault folder, and any `security` command aimed at the vault's keychain item.
- The Harness denies reading, listing or writing Vyre's internals under `VYRE_HOME` (`vyre.db`, the socket, `config.json`, keys, logs).
- Every tool that lets a value out (`vault.reveal`, `vault.copy`, `vault.inject`, `vault.totp` and the rest) needs presence.
- Modules get values only through `ctx.vault.fetch`, only for items their manifest declares under `needs.vault`.
- The event log refuses a payload that looks like a secret (known key prefixes, private keys, `"password": "..."` and similar).
- Push notifications carry a kind, a fixed title and a Deck path, never content.

## 9. Lumen works offline for your own Mac

Enforced: Lumen's launcher (apps, files, settings, the calculator) runs from the Mac alone, with vyred down and no network. On the Mac, calls to the server fail fast with `box_unreachable` while the server is away, so nothing waits on it.

## What the floor does not cover

Root on the server, and anyone who can reach its Docker socket. Code that runs as you (on a Mac, or a Claude Code you start by hand in the server's container) and rewrites Vyre itself. A filter over shell text can be dodged by a determined enough command, which is why the human-only actions rest on [presence](presence.md), not on the Harness filter alone.

## Next

- [Presence](presence.md)
- [Security](../security/index.md)
- [ADR 0004](../adr/0004-presence.md) and [ADR 0009](../adr/0009-container-hardening.md)
