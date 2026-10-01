---
title: Known gaps
summary: What Vyre 0.2.0 does not do yet, what to do today instead, and which release is coming next.
audience: users, builders, operators, agents
owner: docs
status: draft
---

# Known gaps

These docs describe what the code does today. This page lists where Vyre 0.2.0 stops short of what you might expect: what is true now, what to do instead, and, for the things that are planned, which release is coming next. A gap leaves this page in the same change that closes it.

## Coming next in 0.2.1

### Terminal Touch ID asks

Today a terminal on your Mac counts as you for the tools that are yours to call, because Vyre checks which process connected and refuses any process running under a Claude session. The tools that need a person present (sending, the vault, pairing) already ask for Touch ID or a passkey. About 30 more tools will ask for Touch ID from a terminal in 0.2.1.

What to do today: nothing changes in how you work. Keep Claude Code's own permission prompts on, and see [Presence](concepts/presence.md) for what is checked now.

### Interactive artifacts in Safari send your session cookie to Vyre

A page or an app that an agent made runs in a locked frame, but a page can send the browser to another address by itself. In Safari on a Mac and on an iPhone, if that address is your own Vyre address, Safari also sends your Vyre session cookie with the request. Vyre's tools are all POST requests, so that request cannot call a tool, and nothing exploitable is known. Chrome does not send the cookie. 0.2.1 makes Vyre ignore your session on requests that come from inside a page frame.

What to do today: treat a page or an app as able to send out whatever is inside it, in any browser. Do not let an agent put in one anything you would not send to the internet, and be careful with one made in a session that read mail or web pages you did not write. Documents, reports, dashboards, diagrams and decks run no code and are not affected. See [Artifacts](using/artifacts.md).

### No hold on risky pages and apps

An interactive artifact made by a session that read outside content and touched private data is not held for your approval. Vyre shows "Runs its own code and can reach the internet" on the frame and records when a page loads a second time, but that log is a record, not a guard.

What to do today: open an interactive artifact from a session like that only when you trust what it read.

### Vyre for Chrome: faster routing and several tabs

Vyre for Chrome learns a site's own API calls, but it does not yet choose them for you: it works through the page, in one tab at a time. 0.2.1 adds picking a known API call first and falling back to the page, and working in several tabs at once.

What to do today: ask for one job at a time.

### Give it to two

You cannot yet hand one message to two models and see both replies side by side, then keep one or merge them.

What to do today: put `@codex` or `@grok` at the start of a message to run that one turn on that account, and use the session's model picker to move the session. Or open two sessions.

### Per-provider blocks in Chat

Chat has no plan, diff, terminal or reasoning blocks made for Codex and Grok replies yet. Each reply carries the provider's logo.

### Smaller 0.2.1 items

- **Account identity.** The account card for Grok, and for Claude on a Mac, says "account not identified".
- **No accounts screen in Chat.** You add and sign in a Codex or Grok account by asking your assistant to start the sign-in. A screen for it comes later.
- **Images from Claude's own tools.** Images that Claude's own image tools or an MCP tool return are not saved as artifacts yet. Codex and Grok images and Grok video are.
- **Generated media polish.** There are no thumbnails, no gallery view, no audio previews and no per-person quotas for generated media yet, and images, video and audio have no public link.
- **Chrome extension install.** Vyre for Chrome loads unpacked in Chrome, Brave, Edge, Chromium, Arc and Dia, so Chrome shows its developer-extensions bar on every start. A Chrome Web Store listing is planned for 0.3.

## Coming next in 0.2.5

### Spaces

One Vyre is one person's server today. Shared servers, a team space, sharing vault items with others, and choosing where a project lives come in 0.2.5.

What to do today: run one server per person.

### Memory rollover

Vyre does not yet carry a long session across a fresh start with its own summary of your decisions, the plan and the recent turns. Each agent compacts its own context the way it always has, and Vyre's memory keeps the facts in Memory and recall.

What to do today: start a new session for a new piece of work, and ask Vyre what it remembers with `vyre memory ask`.

### Putting idle sessions to sleep when the server runs short of memory

Today Vyre closes a session nobody is using after `idle_minutes` (10 by default) and brings it back on your next message, and `max_live` (6 on a server) limits how many run at once, closing the one idle longest to make room. See [Sessions](using/sessions.md). What is still to come in 0.2.5 is putting sessions to sleep because the server is short of memory, together with memory rollover. Until then a busy session holds its memory on the server until it ends or goes idle.

What to do today: stop sessions you are done with, or lower `idle_minutes` or `max_live` as [Sessions](using/sessions.md) describes.

## True today, with no date

- **Windows is a device, not a server.** The Windows app and the Deck on a Windows PC work against a server. A server on Windows runs inside WSL2, as in [Windows](using/windows.md). The Windows app is not code-signed yet, so Windows asks you to choose **More info**, then **Run anyway**. Computer use on Windows is not built.
- **Windows Hello is untested on a real PC.** Passkey sign-in with Windows Hello has passed its tests with generated keys, not a captured real one.
- **Grok video and privacy.** With a Grok account's privacy switch on, xAI does not keep your sessions and Grok cannot make video. With it off, xAI keeps sessions and may train on them, and Grok can make video. Vyre shows the choice on the account and records it, but xAI holds the setting itself.
- **Vyre for Chrome cannot see everything.** It does not read cross-origin iframes. A script can get around the guard on WebRTC and on DNS hints in some forms, and by writing with `innerHTML` or building an iframe. See [Connectors](using/connectors.md).
- **Sessions you start by hand on a box.** The sessions Vyre runs on a Docker box run as a separate user that cannot open Vyre's socket. A Claude Code you start by hand in the box's container does not, so Vyre's checks on its tool calls are the protection there. See [Presence](concepts/presence.md).
- **No Gate on shell sends or shell file changes.** A message sent some other way, such as `curl` to a mail API, is not recognised as a send, and files a shell command changes are not recorded. See [the security floor](concepts/floor.md).

## The first Windows install checks a checksum, not a signature

`irm https://vyre.run/w | iex` downloads `VyreSetup.exe` and checks its SHA-256 against the line in the release's `SHA256SUMS`, both fetched over https from GitHub. It does not verify `SHA256SUMS.sig`: Windows PowerShell 5.1 cannot check an Ed25519 signature, and the installer is not code-signed yet, so Windows shows its "unrecognized app" warning (choose More info, then Run anyway). Every later update is different: the app verifies it against Vyre's release key and refuses anything unsigned.

What to do: install only from `vyre.run/w` or the release page on GitHub. A signature-verified first install (a PowerShell Ed25519 check, or code-signing the installer) is planned for 0.2.1.

Owner: windows with launch.
