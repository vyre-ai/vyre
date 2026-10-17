---
title: An agent's computer
summary: What an agent's own computer is, how to watch its screen and terminal, how to sign in to a site once yourself, what survives sleep, and who can do what.
audience: users, agents
owner: docs
status: draft
---

# An agent's computer

Every agent that works on websites or runs commands has its own computer inside your Space. It is a private place with its own Chrome, its own terminal and its own files. Nobody else's agent can open it, read it or touch it.

Your Space has one computer server. Each agent on it gets a separate login of its own, so a long job in one agent's terminal never slows another agent down, and one agent can never read another's files.

## Open it

Open the agent, then its Computer tab. The tab says what state the computer is in:

- Asleep: nothing is on screen. The agent's files and terminal jobs are still there.
- Waking: the screen and Chrome are starting. This takes a few seconds.
- Live: you see a small live picture of the screen. Open it to see it full size.

Opening the tab does not wake a sleeping agent. Pressing Open does.

## Watch the screen

Open the screen to watch what the agent is doing in Chrome, as it does it. Watching changes nothing. The agent keeps working and you see every click and page. A watched computer is never put to sleep for being idle.

## Sign in to a site once yourself

Some sites have no connection Vyre can use, such as an ads account. For those, you sign in once and the agent works from your session.

1. Open the agent's screen and press Take control. The agent stops acting while you type.
2. Sign in to the site in the agent's Chrome, the same way you would on your own computer.
3. Press Stop controlling, or leave it. Control goes back to the agent after a few minutes with no input (Settings, Devices, has the number of minutes).

Typing a password here shows it to this agent. Save it in your Vault and let Vyre fill it instead. Anything you type on the agent's screen goes through the agent's own session of the computer, and the agent can see it.

The agent's screen is run by the browser's own user, not the agent's, and the agent's programs only get an untrusted pass to it. Once that is confirmed on a live install this warning is lifted; until then, treat anything you type there as visible to the agent.

From then on the agent uses the signed-in session. You do not need to do this again unless the site signs you out.

## Logins survive sleep

An agent's computer goes to sleep after 5 minutes with nobody using it. Its screen and Chrome close. When the agent next needs the computer, or you open the screen, Chrome opens again with the same tabs and the same signed-in sites, in seconds.

What stays while the agent sleeps:

- Its signed-in sites and cookies.
- Its files.
- Its terminal jobs. A long command keeps running.

## What the agent can do in Chrome

The agent has Chrome's full developer tools in its own Chrome. It can read the network traffic, inspect a page, run a script in it, and read the site's cookies and stored data. This is how Vyre learns to run a task on a site that has no API, such as pulling a report from an ads dashboard.

## Passwords: the Vault only

Each agent's Chrome runs as its own separate user on the computer, apart from the agent's terminal and files, so the agent's shell cannot read Chrome's memory or profile. Chrome's own password manager is switched off in every agent's Chrome. It does not save passwords, does not offer to, does not check them against leaks and does not fill addresses or cards. The pages that list saved passwords and cards cannot be opened. Nothing else in Chrome is closed off.

Your Vault is the only place passwords live. When an agent needs to sign in, the Vault fills the login into the page and the agent never sees the stored password. The agent can use what a sign-in produces, the signed-in session, its cookies and tokens, because that is what working on the site means. It cannot read the password itself. The Vault only fills logins that you shared with that agent, only on the site they belong to.

While a login is being filled, the agent's view of the page is hidden for that moment.

## Sessions

When an agent runs a Claude Code, Codex or Grok session, it runs inside the agent's own computer as the agent's own user, in its own terminal and files. The session reaches its AI provider through Vyre, never directly, and holds only a token for that one session, not a provider key.

## Downloads

A file the agent downloads goes into one fixed folder for that agent. Chrome does not ask where to put it and does not open it. The agent reads it from there like any other file.

## The terminal

Each agent has a terminal. Open it from the Computer tab to see its sessions by name and to watch a command run. Typing in a terminal is typing as the agent, so it needs more than watching.

## Who can do what

| You can | With |
| --- | --- |
| See that the computer exists, wake it, put it to sleep | Use of the agent |
| Watch the screen | Use of the agent |
| See the list of terminals | Use of the agent |
| Type in the terminal | Edit of the agent |
| Reset the agent's computer | Edit of the agent |
| Update the computer | The Space's owner |

If you cannot see an agent, you cannot see its computer. Files in an agent's folder show in Files only to people who have access to that agent.

## Reset

Reset empties one agent's home: its Chrome profile and signed-in sites, its files and its terminal state. Nobody else's computer is touched. Use it when an agent's browser is in a bad state. You will have to sign in to its sites again.

## Updates

When Vyre updates, the agent computer is brought to the matching version on its own a short moment after the server starts. Every agent's screen is closed first so Chrome saves its profile, then the computer is replaced and every agent keeps its signed-in sites and files. On a server that was set up before this version, the computer is remade the same way the first time. The update waits up to 30 minutes for agent work and terminal jobs to finish, then goes ahead and tells you what it interrupted. Terminal jobs that were running end, because the computer they ran in is replaced. Wait for a long job to finish before you update, or run it again afterwards.

If someone is watching or controlling an agent's screen, the update waits until they let go. The owner can also run it at any time with `computers.update`.

## For agents

| Tool | What it does |
| --- | --- |
| `computers.agent.status` | Where an agent's computer is: none, asleep, waking or live. |
| `computers.agent.wake` and `computers.agent.sleep` | Open or close the screen and Chrome. |
| `computers.agent.watch` | A one-use ticket to open the agent's screen. |
| `computers.agent.terminals` | The agent's terminal sessions by name. |
| `computers.agent.terminal.open` | A one-use ticket to open one terminal; needs edit. |
| `computers.agent.reset` | Empty one agent's home; needs edit. |
| `computers.update` | Bring the computer to this version of Vyre; owner only. |
| `computers.update.status` | Whether the computer matches this version; owner only. |
