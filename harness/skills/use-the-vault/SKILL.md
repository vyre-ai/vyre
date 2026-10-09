---
name: use-the-vault
description: Use whenever a task needs a credential, API key, token, password or secret, or the user pastes one, mentions an .env file, or asks to share access with someone. Keeps every value inside the Vyre Vault and out of files, commands, logs and replies.
---

# Use the vault

Vyre keeps credentials in its Vault. The point is that nobody, including you, ever sees a value:
modules and watchers get an item by name when their manifest declares it, and people get a
**pass** that can be revoked in one step. When a teammate leaves, nothing walks out with them.

## Never

- Read, print, copy, cat, grep or echo a secret value. The Vyre rules block reads of the vault
  folder; do not look for a way around them.
- Write a value into a file, a commit, a command line, an environment export, a log or your reply.
- Create or edit an `.env` file with real values. If a project needs one, write `.env.example`
  with names only, and put the values in the Vault.

## Instead

- **See what exists:** the `vault_list` tool returns names and descriptions only.
- **Add an item:** tell the user to run `vyre vault put <name>`. It prompts for the value
  without echoing it. Never ask them to paste a value into this conversation.
- **The user pasted a secret anyway:** don't repeat it. Tell them it is now in this session's
  transcript, suggest they put it in the Vault with `vyre vault put <name>`, and rotate it if the
  transcript could be seen by anyone else.
- **The user has an .env file or a password-manager export:** `tools_call vault_import` with its path.
  Vyre reads the file itself, so the values never pass through you. Then tell the user to
  delete the file.
- **Use an item in code:** a Vyre module declares it under `needs.vault` in `module.json` and
  calls `ctx.vault.fetch("<name>")`. A watcher names the host and the item under `net` in
  `watcher.json`; Vyre attaches the credential to that host's requests and the code never holds it. Scripts outside Vyre run through `vyre vault run <name> -- <command>`,
  which injects the value into that one process's environment and hides it in the output.
- **Give a module access:** `tools_call vault_grant`. From you it waits as pending; tell the user to run
  `vyre vault approve <id>`. The same goes for passes you create.
- **Use an item someone shared with you:** `vault_relay` with `{{vault}}` where the value goes
  in a header or the body. Their Vyre adds it; it never reaches this machine.
- **Share with someone:** `tools_call vault_pass_create`. Passes are **relayed** by default: the value
  never leaves this machine and the other person's calls go through it, so revoking ends access
  at once. Offer **sealed** only when they must work offline, and say that revoking a sealed pass
  means rotating the credential.
- **Someone leaves:** `vault_offboard` with their name. It revokes every pass they hold and lists
  what must be rotated.

If the vault tools are not available, the Vault is not running on this machine. Say so, and still
keep every value out of files and replies.
