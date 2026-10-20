---
title: "ADR 0058: An agent's folder is kept on its computer"
summary: Files > Agents > <agent> reads and writes the folder in the agent's home on its computer, the one real copy. Nothing syncs and nothing is copied; the files go without the Drive's extra encryption and version history.
audience: builders
owner: docs
status: stable
---

# ADR 0058: An agent's folder is kept on its computer

Status: accepted, 20 Oct 2026 (the owner's decision) · Workstream: computers, files · Roadmap 0.6.4.

## Context

An agent had two folders. Files listed `agents/<agent id>` from the Space Drive (encrypted chunks, versions, no folder an agent's programs can open), and vyred kept a plain folder beside the projects for sessions. The agent's computer (its own Linux user, terminal, Chrome and file manager) has a third: its home, with Inbox, Work, Done, Scripts, Notes and Downloads. What an agent made in one was not in the others.

## Decision

1. **One copy.** The folder in the agent's home on its computer is the agent's folder. Files > Agents > <agent> lists, reads, writes, makes folders, moves, renames and deletes there. Nothing syncs and nothing is copied.
2. **The computer does the file work, as the agent.** Each operation is one ticket through agentd and the relay, carrying the checked operation. A helper (`agentd-fs.js`) runs it as the agent's own Linux user with computerd's own file routes, the same path guard as Glass Files: relative paths only, no `..`, symlinks followed only inside the home, private names never opened, each folder opened by fd, writes counted and renamed into place, a delete moved to the home's trash, Downloads read-only.
3. **One Files screen.** The Drive's calls route any path under `agents/<agent id>/` to the computer (core/files/agent-folder.js). What only the Drive does (versions, restore, links) is refused there in plain words.
4. **Who may open it.** A person, never an agent or a model. Can use or Can edit on the agent to see it; Can edit to change it (AGENT_FOLDER_RULE).
5. **Asleep is fine.** The folder is there while the agent's screen sleeps; it is not woken. When the Space's computer itself is not running, opening the folder starts it and Files says "Opening this agent's computer…".
6. **The move.** The first time a person with Can edit opens the folder, the old Drive folder and the plain sessions folder go into Inbox at their old paths, never over a file that is there. The Drive copy is then left read-only until 0.6.5.

## Consequences

- The trade-off the owner accepted: these files sit on the server's computer volume without the Drive's extra encryption and version history. Files says so on the folder.
- A server without agent computers cannot open an agent's folder, and says so.
- Sessions still run on the server, in the plain folder, until they run inside the computer (`computers.run.open` exists and has no caller yet). Until then a session's new files are not in the computer folder; the move copies the plain folder once and leaves it in place.
- Recent and "All files" search read the Drive only, so they do not show files in agent folders.
