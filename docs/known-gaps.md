---
title: Known gaps
summary: What Vyre 0.5 does not do yet, what to do today instead, and what comes next.
audience: users, builders, operators, agents
owner: docs
status: draft
---

# Known gaps

These docs describe what the code does today. This page lists where Vyre 0.5 stops short of what you might expect: what is true now, what to do instead, and, for the things that are planned, what comes next.

## Next, in 0.5.1

The 0.5.1 plan is on the [roadmap](roadmap.md). Screen Share (watching and taking over your agents' computers and Chrome, on every device) is later.

## Known gaps in 0.5


### Members and custom record types

A member can read every row of a record type your Space defined itself, even when the row is linked to a project the member is not on. Matters, tasks and files of a project are already limited to that project's team. Per-record privacy for custom types is planned for 0.5.1.

What to do today: keep sensitive rows in a built-in type, or in a Space the person is not a member of.

### A Viewer's AI cannot open the project folder

A Viewer's AI can read a project's records and files through Vyre, but cannot open the project's folder directly.

### Renaming a project on a team server

Renaming a project changes its short name, which keys the project's folder group. The next session started in the renamed project is refused in words that name the old name. A re-key step is planned.

### Flows

- A "For each" step handles up to 50 items in the editor, although the engine allows 1000, and a longer list is cut without a note on the run page.
- An agent step has no deadline yet. A session that ends without finishing is marked stuck, but an agent that never ends is not timed out. Deadlines and failure paths in the editor are planned for 0.5.1.
- A Flow email cannot yet carry CC, BCC or attachments.
- Members cannot inspect a Flow over MCP (`flows.describe`, `flows.runs` and `flows.connections` are for owners).

### Records export is a web feature

CSV export is in the web app. A phone does not offer it yet.

### Members and sign-ins

- A member cannot add a setup token or API key as their own AI account; the member signs in with the provider's own sign-in.
- A member's own vault holds their sign-ins, mail and calendar connections and server list. Sessions do not read other items in it yet.
- A member's MCP servers that they sign in to inside a session are not carried to their next session.
- The firm Microsoft 365 app is read-only. Member sends are not open.

### Vyre on a Mac as the server

The Mac server installer is tested on a clean macOS in CI. The virtual machine for agents' computers, Records and an agent computer starting are not yet proven on real Mac hardware.

### Only Claude is proven live

Claude is the model Vyre has run end to end on real accounts. Codex and Grok work against recorded sessions, and the Grok driver still says some of its behaviour is assumed, not verified. There is no Gemini. `team.ask` can hand a request to Codex or Grok (`--model`), and it uses whatever accounts you signed in to.

What to do today: try a short request on Codex or Grok before you give it real work, and keep Claude for what matters.

### Direct paths through a home router are unproven

Your server tries to make a direct path to your devices with IPv6, UPnP and NAT-PMP. These were tried on servers with public addresses, not behind a real home router. The relay always works, so nothing stops: a connection may simply stay on the relay.

What to do today: nothing. `vyre doctor` shows **Path to your server** and says whether it is direct.


### Real devices

Nothing has been walked on a real iPhone or Android yet, including Face ID pairing and the removed-phone wipe. Chrome control works today; Screen Share is not built. The Mac server installer has not run on a real Mac yet. Home-router NAT is untested: a direct path through a home router has not been tried, and the relay carries the connection when there is none.

### Notifications when the phone app is closed

Only web push works today. Native push needs Apple and Google push accounts, which are not set up.

### No hold on risky pages and apps

An interactive artifact made by a session that read outside content and touched private data is not held for your approval. Vyre shows "Runs its own code and can reach the internet" on the frame and records when a page loads a second time, but that log is a record, not a guard.

What to do today: open an interactive artifact from a session like that only when you trust what it read.

### Vyre Computer: one Chrome, reads in parallel

Vyre Computer tries a site's own API call first for a read, and falls back to the page. It reads several tabs at once (at most six) within your one Chrome. A tab for each agent is not built, and a write goes through the page, asked first.

What to do today: ask for one job at a time when several agents need Chrome.

### Models side by side

You can hand one message to several models and see each answer in its own block, then keep one. Only that answer fan-out across models is proven. Per-model plan and diff blocks are not: each reply carries the provider's logo, and plans, diffs, terminals and reasoning look the same for every provider.

What to do today: use the fan-out for answers, and read plans and diffs as they come.


## True today, with no date

- **Windows is a device, not a home.** The Windows app and the Vyre app on a Windows PC work against a server. A home runs on a Mac, Linux or a server, and a Windows PC runs no sessions of its own; a Windows home is planned. See [Windows](using/windows.md). The Windows app is not code-signed yet, so Windows asks you to choose **More info**, then **Run anyway**. Computer use on Windows is not built.
- **Windows Hello has not been walked on a real PC.** A Windows PC claims your name with a Windows Hello passkey and the app asks you at the PC each time the key is used. This has passed its tests with a stand-in authenticator and in a Windows window on a test machine, which has no Hello. It has not been tried on a PC with Hello set up.
- **Without Hello, the Windows key signs without asking each time.** A Windows PC with no Hello, or with Hello turned off, keeps its key in the app instead. That key is marked as one a script on the page could reach, so it cannot change who speaks for your name and a team's server does not accept it. Changes to your name's list come from your phone or your recovery code. A prompt for every signature on a computer with a TPM is not proven yet.
- **Grok video and privacy.** With a Grok account's privacy switch on, xAI does not keep your sessions and Grok cannot make video. With it off, xAI keeps sessions and may train on them, and Grok can make video. Vyre shows the choice on the account and records it, but xAI holds the setting itself.
- **Vyre Computer cannot see everything.** It does not read cross-origin iframes. A script can get around the guard on WebRTC and on DNS hints in some forms, and by writing with `innerHTML` or building an iframe. See [Connectors](using/connectors.md).
- **Sessions you start by hand on a box.** The sessions Vyre runs on a Docker box run as a separate user that cannot open Vyre's socket. A Claude Code you start by hand in the box's container does not, so Vyre's checks on its tool calls are the protection there. See [Presence](concepts/presence.md).
- **No Gate on shell sends or shell file changes.** A message sent some other way, such as `curl` to a mail API, is not recognised as a send, and files a shell command changes are not recorded. See [the security floor](concepts/floor.md).

## The first Windows install checks a checksum, not a signature

`irm https://vyre.run/w | iex` downloads `VyreSetup.exe` and checks its SHA-256 against the line in the release's `SHA256SUMS`, both fetched over https from GitHub. It does not verify `SHA256SUMS.sig`: Windows PowerShell 5.1 cannot check an Ed25519 signature.

What to do: install only from `vyre.run/w` or the release page on GitHub.

Owner: windows with launch.
