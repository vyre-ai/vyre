---
title: Known gaps
summary: What Vyre 0.6 does not do yet, what to do today instead, and what comes next.
audience: users, builders, operators, agents
owner: docs
status: draft
---

# Known gaps

These docs describe what the code does today. This page lists where Vyre 0.6 stops short of what you might expect: what is true now, what to do instead, and, for the things that are planned, what comes next.

## Next, in 0.7

The 0.7 plan is in [roadmap/0.7.md](../roadmap/0.7.md); the line list is on the [roadmap](roadmap.md). Screen Share (watching and taking over your agents' computers and Chrome, on every device) is later.

## Known gaps in 0.6

### The shared browser and a Linux user for each agent

Off until 0.6.2. Each agent that has a computer gets its own, with its own screen and its own Chrome. The one shared browser on the space's computer, and a separate Linux user for each agent on it, are not used, even on a server that could run them. To try them on a server you run, set `computers.browse` to `browser` and `computers.agentUsers` to `true` in its config. Nothing else turns them on.

### Downloads in an agent's computer

A file an agent's Chrome downloads may not land in the folder the agent reads from, or may not be readable by the agent, and the folder the proof expects (the browser's own) is not the one computerd accepts today (the agent's Downloads). The proof reports these four checks (the two download-path checks, the landing and the read) as known failures; the fix is in 0.6.2. Until then, have the agent fetch the file by its address instead of through a download.

### A member's own AI account in chats

A member who has added her own AI account can't chat yet: her turn stops with a clear message, because her own key isn't lent to her chats yet. A member without one chats on the space's AI account if it has one. No one's key ever reaches another person. Fixed in the next update. The owner isn't affected, because the owner's accounts are the space's. The lent-key test for it (core/stream/person-turns-live.test.js) stays red until then.

### Long runs of rows you may not see

A list or a search of a type whose rows are private by project looks through up to 20 pages of hidden rows before it gives up. If more than that lie between you and the next row you may read, the page comes back empty with no way to continue. Nothing hidden is shown; ask an owner or an admin, or filter the list.

### An agent computer's workspace after its lease ends

When the lease of a computer lent to a Space ends, the workspace key is removed at once, but a process that still holds a file open can read that file until it exits, and whoever uses that computer can read through it. Normal sessions stop within a moment. A full fix that stops every holder before reporting the workspace locked comes in the next update.

### Records takes a while to set up on a new Linux server

On a new Linux server, Records takes about 10 to 13 minutes to set up the first time. Records and Projects say it is setting up and get ready by themselves. A faster start comes in the next update.

### The Personal project on a new Linux server

On a new Linux server, the Personal project can be missing after Records finishes setting up. Fixed in the next update.

### A Viewer's AI cannot open the project folder

A Viewer's AI can read a project's records and files through Vyre, but cannot open the project's folder directly.

### Renaming a project on a team server

Renaming a project changes its short name, which keys the project's folder group. The next session started in the renamed project is refused in words that name the old name. A re-key step is planned.

### Flows

- A "For each" step handles up to 50 items in the editor, although the engine allows 1000, and a longer list is cut without a note on the run page.
- A Flow email carries CC, BCC and up to 10 attachments of 25 MB together, from Files or from a file an earlier step made. A Flow you turned on sends without asking; a person asks only when a step is marked to approve, or when an agent held the act. An attachment is read as the lesser of the person who approved the Flow and the person who started the run, and a file changed after approval stops the send. Only mail through Gmail, Google Apps Script, a mail login, Resend, Postmark, SendGrid and Mailgun carries attachments.

### Audit screen window

The admin Audit screen reads the signed event log forward from its last 100,000 events and says when it stopped short. A busier Space sees the recent past first; the older events are in the log itself.

### Preview isolation

A preview's process can reach its own loopback port and no other network address: on macOS through the sandbox profile, on Linux through a private network with the page carried out on a unix socket. Unix sockets that live in the filesystem under the same account (not the network) stay reachable to it, as before. Where bubblewrap cannot make a private network on a Linux box, the preview runs with shell limits only and its log says there is no network wall.

### Standing permissions

An agent's standing permission covers a send, post or payment through one connection to named recipients, up to a daily cap. It does not cover the default assistant. A sender with no connection of its own (a shared one, such as the Space's own mail service) is open to owners and admins only, so an agent working for a member is held there and asks as before. A permission that follows a list counts only addresses written by someone who holds the connection.

### Records export is a web feature

CSV export is in the web app. A phone does not offer it yet.

### Members and sign-ins

- A member's own vault holds their sign-ins, mail and calendar connections and server list. Sessions do not read other items in it yet.
- A member's MCP servers that they sign in to inside a session are not carried to their next session.
- Removing an app connection removes it here and discards what it was holding at the Gate. The vendor is told to drop the token only when the connection records its revocation address (the sign-in records one on the vendor's own origin). The tests for this have not run on CI yet, so until they do, treat a removed connection's token as not revoked at the vendor and revoke it in the app.
- The firm Microsoft 365 app lets a member send and invite from their own mailbox, never held. A member's agent's send is held at that member's own Gate. Standing permissions for it are not tested end to end yet.

### Vyre on a Mac as the server

The Mac server installer is tested on a clean macOS in CI. The virtual machine for agents' computers, Records and an agent computer starting are not yet proven on real Mac hardware.

### Only Claude is proven live

Claude is the model Vyre has run end to end on real accounts. Codex and Grok work against recorded sessions, and the Grok driver still says some of its behaviour is assumed, not verified. There is no Gemini. `team.ask` can hand a request to Codex or Grok (`--model`), and it uses whatever accounts you signed in to.

What to do today: try a short request on Codex or Grok before you give it real work, and keep Claude for what matters.

### Direct paths through a home router are unproven

Your server tries to make a direct path to your devices with IPv6, UPnP and NAT-PMP. These were tried on servers with public addresses, not behind a real home router. The relay always works, so nothing stops: a connection may simply stay on the relay.

What to do today: nothing. `vyre doctor` shows **Path to your server** and says whether it is direct.

### Real devices

Nothing has been walked on a real iPhone or Android yet, including Face ID pairing and the removed-phone wipe. Chrome control works today; Screen Share is not built. The Mac server installer has not run on a real Mac yet. Direct paths through a home router are covered above.

### Notifications when the phone app is closed

Only web push works today. Native push needs Apple and Google push accounts, which are not set up.

### No hold on risky pages and apps

An interactive artifact made by a session that read outside content and touched private data is not held for your approval. Vyre shows "Runs its own code and can reach the internet" on the frame and records when a page loads a second time, but that log is a record, not a guard.

What to do today: open an interactive artifact from a session like that only when you trust what it read.

### Vyre Computer: one Chrome, reads in parallel

This is about your own Chrome on your own computer, which Vyre Computer drives for you; it is not about the agents' browsers on the Space computer, where each agent has its own Linux user and its own Chrome. Vyre Computer tries a site's own API call first for a read, and falls back to the page. It reads several tabs at once (at most six) within your one Chrome. A tab for each agent in your Chrome is not built, and a write goes through the page, asked first.

What to do today: ask for one job at a time when several agents need your Chrome.

### Models side by side

You can hand one message to several models and see each answer in its own block, then keep one. Only that answer fan-out across models is proven. Per-model plan and diff blocks are not: each reply carries the provider's logo, and plans, diffs, terminals and reasoning look the same for every provider.

What to do today: use the fan-out for answers, and read plans and diffs as they come.

### A skill edited and put back during a task's review

A task pins the skills of its slots when it is made, and the person or assistant holding a slot is checked against them at the act: starting, updating, handing in, reviewing, approving. A skill that is edited and then put back exactly between a holder reading it and that final act is not noticed, because the check is at the act and not at the read. Only someone who may edit the Space's skills can do this.

What to do today: keep who may edit Space skills short, and read the review result on the card, which shows the checklist it was judged against.

### A kept yes when a signing key is revoked

When a role must all say yes to approve something, each person's yes is kept as they give it. The last yes does not check the earlier ones again. If one person's signing key is revoked after their yes and before the last yes, their yes still counts. A person taken out of the role is no longer waited for.

What to do today: if a key is revoked while a quorum approval is open, reject the task so the round starts again.

### A group task whose taker leaves while it is waiting

A task taken from a group can be taken over by another member only while it is being worked on or waiting for changes. If the person who took it is removed from the group while the work is in review or waiting for a check, it stays where it is until it moves.

What to do today: ask the reviewer or approver to send it back, then another member takes it.

### A file or draft hand-in is checked by its form

A file or draft hand-in is checked by its form (a path or a record address that is there), not by looking at the file: a task with no checker accepts the doer's word, so give any task that matters a checker.

What to do today: the person who checks the task opens the file before saying yes.

## True today, with no date

- **Windows is a device, not a home.** The Windows app and the Vyre app on a Windows PC work against a server. A home runs on a Mac, Linux or a server, and a Windows PC runs no sessions of its own; a Windows home is planned. See [Windows](using/windows.md). The installer is Authenticode signed only when the GitHub environment `windows` has `WINDOWS_AUTHENTICODE_PFX_B64` and `WINDOWS_AUTHENTICODE_PFX_PASSWORD`. Until then it is unsigned, and Windows asks you to choose **More info**, then **Run anyway**. Computer use on Windows is not built.
- **Windows Hello has not been walked on a real PC.** The app tries Windows Hello, then the TPM, then Windows data protection. A Hello prompt on each signature has not been shown on a PC with Hello set up, so the key is still held: it cannot change who speaks for your name, and the app asks in its own window before it signs. A hosted runner has no TPM.
- **An install that ran only on this computer now needs a server.** That shape is removed. The install keeps its data and asks you to add a server, or to join a space on someone else's. The Mac app is Developer ID signed and notarized only when the GitHub environment `apple` has `APPLE_DEVELOPER_ID_P12`, `APPLE_DEVELOPER_ID_P12_PASSWORD`, `APPLE_DEVELOPER_ID_IDENTITY`, `APPLE_NOTARY_KEY_P8`, `APPLE_NOTARY_KEY_ID` and `APPLE_NOTARY_ISSUER`. Until then the dmg is ad hoc signed.
- **Grok video and privacy.** With a Grok account's privacy switch on, xAI does not keep your sessions and Grok cannot make video. With it off, xAI keeps sessions and may train on them, and Grok can make video. Vyre shows the choice on the account and records it, but xAI holds the setting itself.
- **Vyre Computer cannot see everything.** It does not read cross-origin iframes. A script can get around the guard on WebRTC and on DNS hints in some forms, and by writing with `innerHTML` or building an iframe. See [Connectors](using/connectors.md).
- **Sessions you start by hand on a box.** The sessions Vyre runs on a Docker box run as a separate user that cannot open Vyre's socket. A Claude Code you start by hand in the box's container does not, so Vyre's checks on its tool calls are the protection there. See [Presence](concepts/presence.md).
- **No Gate on shell sends or shell file changes.** A message sent some other way, such as `curl` to a mail API, is not recognised as a send, and files a shell command changes are not recorded. See [the security floor](concepts/floor.md).

## The first Windows install checks a checksum, not a signature

`irm https://vyre.run/w | iex` downloads `VyreSetup.exe` and checks its SHA-256 against the line in the release's `SHA256SUMS`, both fetched over https from GitHub. It does not verify `SHA256SUMS.sig`: Windows PowerShell 5.1 cannot check an Ed25519 signature.

What to do: install only from `vyre.run/w` or the release page on GitHub.

Owner: windows with launch.

## A team member's uploaded skill is untrusted text

A skill a member uploads is text from outside, read strictly and kept as a draft of her own personal skill. Only she approves it, and only she uses it; it is never loaded for anyone else. The upload counters (ten an hour, thirty a day) are kept in memory and start again when the server restarts, so a restart gives her a fresh count. The fifty-skill and fifty-draft limits are counted from the library and do not reset.

What to do: nothing for a normal team. An owner who sees a member upload in bursts can remove the member's role.

Owner: comp6 with sec53.

## Some Records features do not reach a person who joined a team

A person who joined a team Space reaches it through the team's member door, which carries a fixed list of calls. In Records that list covers lists, records, moves, connections, layouts, history, board totals, Busy blocks, roles on a record, logging a call, a meeting or a note, and Notes (the team's planner, notes only). It does not yet carry: undo in a record's history; putting a role on a record or moving its stage (records.role.set); sharing a synced event (records.share); and the Space-setup edits an owner or an admin makes (a type's colour or hidden flag, a new field, a new link, sample data). For a joined member those calls are sent to her own home, not the team, so they fail or act on her home.

What to do: do the setup edits and role changes on the team's server itself (or as the owner there). Undo a change by setting the old value by hand.

Owner: flow6b with sec53. Planned for 0.6.3: serve calls for each.

## An agent's Chrome runs without Chrome's own renderer sandbox

Docker's default seccomp profile refuses the namespaces Chrome's sandbox needs, so the computer's Chrome and each agent's Chrome start with `--no-sandbox`. A Chrome renderer exploit therefore runs as that agent's browser user with no renderer sandbox. It reaches that agent's profile and its debugging pipe. It does not reach another agent's files, the computer's own user or its secrets, because each agent has its own users, processes run with no capability and no new privileges, and the folders are private.

What to do: keep the Chrome in the computer image current (the image carries its version). The fix is a seccomp profile that allows user namespaces, planned for 0.7.

Owner: comp6 with sec53.

## An agent's Chrome has no address-space cap

Chrome reserves far more virtual memory than it uses and does not start under a cap on address space, so an agent's Chrome is held by a cap on committed memory (3 GiB per process), the computer's own memory limit and its process count instead. Every other agent process keeps the address-space cap.

What to do: nothing. If one agent's browser grows without bound it is stopped at the per-process cap; the computer's own limit still bounds the whole.

Owner: comp6 with sec53.
