---
title: Known gaps
summary: What Vyre 0.2.9 does not do yet, what to do today instead, and what comes next.
audience: users, builders, operators, agents
owner: docs
status: draft
---

# Known gaps

These docs describe what the code does today. This page lists where Vyre 0.2.9 stops short of what you might expect: what is true now, what to do instead, and, for the things that are planned, what comes next.

## Next, in 0.3.1

Screen Share. Watch and take over your agents' computers and Chrome, on every device.

## Known gaps in 0.2.9

### My Cloud on another server keeps your chats in Personal

Moving your Personal Space to My Cloud carries your memory, records and files. When My Cloud runs on a different server from Personal, your chats stay in the frozen Personal Space, readable there. Carrying them across comes in 0.3.0.

### Real devices

Nothing has been walked on a real iPhone or Android yet, including Face ID pairing and the removed-phone wipe. Screen Share (live view and computer use) comes in 0.3.1; Chrome control works today. The Mac server installer has not run on a real Mac yet. Home-router NAT is untested: a direct path through a home router has not been tried, and the relay carries the connection when there is none.

### Notifications when the phone app is closed

Only web push works today. Native push needs Apple and Google push accounts, which are not set up.

### No hold on risky pages and apps

An interactive artifact made by a session that read outside content and touched private data is not held for your approval. Vyre shows "Runs its own code and can reach the internet" on the frame and records when a page loads a second time, but that log is a record, not a guard.

What to do today: open an interactive artifact from a session like that only when you trust what it read.

### Vyre for Chrome: one Chrome, reads in parallel

Vyre for Chrome tries a site's own API call first for a read, and falls back to the page. It reads several tabs at once (at most six) within your one Chrome. A tab for each agent is not built, and a write goes through the page, asked first.

What to do today: ask for one job at a time when several agents need Chrome.

### Models side by side

You can hand one message to several models and see each answer in its own block, then keep one. Only that answer fan-out across models is proven. Per-model plan and diff blocks are not: each reply carries the provider's logo, and plans, diffs, terminals and reasoning look the same for every provider.

What to do today: use the fan-out for answers, and read plans and diffs as they come.

### Idle sessions do not sleep under memory pressure, and there is no fair-share scheduler

Today Vyre closes a session nobody is using after `idle_minutes` (10 by default) and brings it back on your next message, and `max_live` (6 on a server) limits how many run at once, closing the one idle longest to make room. See [Sessions](using/sessions.md). What is still to come in 0.2.5 is putting sessions to sleep because the server is short of memory, together with memory rollover. Until then a busy session holds its memory on the server until it ends or goes idle.

What to do today: stop sessions you are done with, or lower `idle_minutes` or `max_live` as [Sessions](using/sessions.md) describes.

## True today, with no date

- **Windows is a device, not a home.** The Windows app and the Vyre app on a Windows PC work against a server. A home runs on a Mac, Linux or a server in 0.2.9, and a Windows PC runs no sessions of its own; the Windows home comes in 0.3.0. See [Windows](using/windows.md). The Windows app is not code-signed yet, so Windows asks you to choose **More info**, then **Run anyway**. Computer use on Windows is not built.
- **Windows Hello is untested on a real PC.** Passkey sign-in with Windows Hello has passed its tests with generated keys, not a captured real one.
- **Grok video and privacy.** With a Grok account's privacy switch on, xAI does not keep your sessions and Grok cannot make video. With it off, xAI keeps sessions and may train on them, and Grok can make video. Vyre shows the choice on the account and records it, but xAI holds the setting itself.
- **Vyre for Chrome cannot see everything.** It does not read cross-origin iframes. A script can get around the guard on WebRTC and on DNS hints in some forms, and by writing with `innerHTML` or building an iframe. See [Connectors](using/connectors.md).
- **Sessions you start by hand on a box.** The sessions Vyre runs on a Docker box run as a separate user that cannot open Vyre's socket. A Claude Code you start by hand in the box's container does not, so Vyre's checks on its tool calls are the protection there. See [Presence](concepts/presence.md).
- **No Gate on shell sends or shell file changes.** A message sent some other way, such as `curl` to a mail API, is not recognised as a send, and files a shell command changes are not recorded. See [the security floor](concepts/floor.md).

## The first Windows install checks a checksum, not a signature

`irm https://vyre.run/w | iex` downloads `VyreSetup.exe` and checks its SHA-256 against the line in the release's `SHA256SUMS`, both fetched over https from GitHub. It does not verify `SHA256SUMS.sig`: Windows PowerShell 5.1 cannot check an Ed25519 signature.

What to do: install only from `vyre.run/w` or the release page on GitHub.

Owner: windows with launch.
