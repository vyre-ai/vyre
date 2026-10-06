# Vyre

[![node](https://github.com/vyre-ai/vyre/actions/workflows/node.yml/badge.svg)](https://github.com/vyre-ai/vyre/actions/workflows/node.yml)
[![capsule-mac](https://github.com/vyre-ai/vyre/actions/workflows/capsule-mac.yml/badge.svg)](https://github.com/vyre-ai/vyre/actions/workflows/capsule-mac.yml)
[![ios](https://github.com/vyre-ai/vyre/actions/workflows/ios.yml/badge.svg)](https://github.com/vyre-ai/vyre/actions/workflows/ios.yml)
[![android](https://github.com/vyre-ai/vyre/actions/workflows/android.yml/badge.svg)](https://github.com/vyre-ai/vyre/actions/workflows/android.yml)

**One place where your team and your AI agents work together, on a server you own.**

Vyre is an open-source, self-hosted workspace for teams that work with AI agents every day. Your people, your clients' records, your conversations and your agents live in one Space on your server. Agents do real work there: they read the record they are working on, draft, file, schedule and follow up. Every step they take goes through one set of rules, and anything that leaves your server waits for a person to say yes.

## Why one product

A team that works with agents today spreads that work across a chat app, a CRM, a pile of API keys, an automation tool and a different window for each model. Each one keeps its own copy of who the client is. Agents get context by copy and paste, keys sit in environment files, and nobody can say afterwards which agent did what, or why.

Vyre puts the pieces in one place on purpose:

- **One record of your work.** People, companies, leads, clients, appointments, projects, tasks and every email and meeting are records in your Space, linked both ways. A Contact shows its leads, projects, tasks and messages.
- **One conversation for people and agents.** A chat holds people, assistants and AI models side by side. Mention a teammate or an agent with @, point to a record with #, and switch the model a reply comes from. Each reply shows which provider wrote it.
- **One way work gets done.** Flows watch for a new email, a form answer, a stage change or a time, then run their steps: classify with a model, create or update a record, assign a task, send. Agents pick up tasks with the record, its links and its recent history in hand.
- **One set of rules.** A single permission system in Vyre's kernel decides every call, from a person's phone, an agent's session or a Flow step. The Space's log records each change and each approval.

Each part needs the others. A Flow is useful because the record it changes is the same one your team sees in chat. An agent is safe to hand work to because the kernel holds its sends and keeps your secrets out of its context.

## Deterministic

Agents are probabilistic. What they are allowed to do is not.

- **Flows are declared steps,** not a prompt. A code step runs in a sandbox with time and memory limits. A model step classifies or extracts, with no tools.
- **Every outside write is safe to repeat.** It carries an idempotency key, is read back, respects the service's rate limit, and after a crash only the missing part is redone.
- **One yes, for one act.** An act that sends, pays, publishes, shares or deletes is held once. The approval is single use and bound to exactly that act, so it cannot be spent on a different one.
- **Exact recall.** A person or an assistant in a chat can read a past part of it word for word, including your terminal Claude Code sessions. Memory answers say which session they came from.

## Secure by design

- **Your server, your data.** Records, chats, files, memory and keys stay on the server you run. Your prompts go only to the AI provider you chose.
- **Encrypted chats.** A chat with a person in it is never stored in the clear. Its key lives on the participants' devices and is lent to the server only while a session runs. A server admin sees ids and ciphertext.
- **Sealed fields.** A social security number or an API key in a record is held by Vyre's sealing process. An agent sees a placeholder, never the value, and revealing it asks for your presence.
- **A vault for credentials.** Agents and connectors use a credential without seeing its value.
- **Your phone is your key.** Face ID or Touch ID is asked for only where it matters: pairing a device, revealing a vault secret, and sending, posting or paying.
- **Vyre's own code is signed.** The kernel is always on and checks Vyre's modules by signature. A module you add runs in a sandbox and can only post events named for itself. Releases are signed (Ed25519 on the release files, cosign on the server image), and Vyre checks both before it installs one.
- **No open door.** Your devices reach the server through Vyre's relay, end-to-end encrypted, or through a direct path your router agreed to. The one port the server publishes is a TLS door for its own name, and nothing listens there until the server has a name and a certificate.

## Spaces and your team

A Space is your team's home: its own records, its own Drive with its own key, and its own members. Roles are owner, admin, manager, member and temp, and a temp's access ends by itself. You also have a Personal Space for your own work, and one approval moves it to your own server (My Cloud) with its records, files and sealed values.

## Your models, your accounts

Use the subscriptions you already pay for: Claude, Codex, Grok or OpenRouter. Pick the model for each chat, or switch it mid-conversation: the chat, its folder and its files stay where they are.

## Where you work

- **Your phone.** The Vyre app pairs with your server, holds your chat keys and approves what leaves.
- **Your Mac.** Vyre Lumen opens with Option-Space (or Control twice) in any app: ask, hand work to an agent, or run a `vyre` command.
- **Windows.** A tray app with an Alt-Space panel.
- **A browser.** A browser joins your identity from your phone's code, and the browser can never change who speaks for you.

## Set up

You need a server (a Linux machine with Docker, or a Mac that stays on) and an account with at least one AI provider.

1. Open the Vyre app on your phone and claim your name.
2. On the server, run the line the app shows:

   ```
   curl -fsSL vyre.run/i | sh
   ```

3. Pair the server with the app: scan the QR, paste the long code, or type the short code it shows.

The installer sets up the server and your Space's records database. On our test server the Space was ready about two minutes after the install finished. Step by step: [Install](docs/get-started/install.md).

## What is not here yet

See [Known gaps](docs/known-gaps.md) for what 0.2.9 does not do yet and what to do today.

## Questions

**What does it cost?** Vyre is free and open source under Apache 2.0. You pay your AI providers as you do today.

**Do I need to be technical?** You need to run one line on a server. Everything after that happens in the app.

**Can my clients' data reach the AI providers?** Only what a step or a session sends. Sealed fields go as placeholders, and you choose the provider.

**Can I add my own tools?** Yes. A module declares its tools and what it may reach, and runs in a sandbox. See [Modules](docs/MODULES.md).

## Develop

Needs Node 22.5 or newer. No build step for the server.

```
npm test
VYRE_HOME=$(mktemp -d) bin/vyre up
bin/vyre call system.echo '{"text":"hi"}'
bin/vyre down
```

## License

Apache 2.0. See [LICENSE](LICENSE).
