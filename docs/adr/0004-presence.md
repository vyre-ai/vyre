# ADR 0004 · Presence: proving a person is there before a human-only action

Status: accepted, 26 Sep 2026 · Workstream: security · Spec: principles 7, sections 5, 7.5, 7.7,
7.11, 8 and 11 (floor rules 1, 2 and 8)

## The problem

Some actions are the user's alone: approving, revising or rejecting what the Gate holds
(`gate.approve`, `gate.revise`, `gate.reject`), answering a permission question
(`threads.answer`), putting, approving or unlocking vault items (`vault.put`, `vault.approve`,
`vault.unlock`), offboarding (`vault.offboard`), and accepting or retiring a lesson
(`learn.accept`, `learn.retire`).

Until now vyred told people from models by the caller, and the caller is only a claim. A client
names itself in the `x-vyre-caller` header on a unix socket the user owns, and Claude Code runs
as that same user. A Bash command Claude runs can therefore:

- `curl --unix-socket ~/.vyre/vyred.sock -H 'x-vyre-caller: cli' .../v1/tools/gate.approve`;
- run `vyre call gate.approve '{"id":"..."}'`, which calls as `cli`;
- claim `capsule`, `deck` or `local`, which the Gate also trusts.

Any of these lets a model approve its own held email. That breaks floor rules 1 and 2: nothing
goes out as the user until the user has seen the final words, and the user always sees where it
is going.

The defences so far were thin. vyred treats `module:*` and `hook` claims as `local`. Learning asks
before commands that name `vyre.db` or the socket. The floor denies reading the vault folder.
None of this stops the first two routes above.

## What Claude Code gives a Bash command

Checked on this machine (Claude Code in Terminal, 26 Sep 2026). The `claude` process has a
controlling terminal (`ttys012`). The Bash tool's shell is started in a new session with none:
`tty` says "not a tty", stdin and stdout are pipes, `ps` shows the shell's TTY as `??`, and opening
`/dev/tty` fails with ENXIO ("device not configured").

So "is stdin a terminal" already fails for the model's commands. It is still not a proof:

- `script -q /dev/null vyre ...` (or Python's `pty`, or `expect`) gives the child a fresh
  pseudo-terminal, and whoever holds its master can read the prompt and type the answer.
- A terminal check that the CLI runs on itself is a claim too. The model can write its own
  client that skips the check.

A proof has to be checked by vyred, and it has to need something the model cannot do.

## Decision

Two independent layers. Either one on its own stops the routes above.

### Layer 1 · Presence proof, checked by vyred

A tool that only a person may run declares it:

```js
ctx.tool("gate.approve", { presence: true, ... })
// or, with the words the person must see before proving it:
ctx.tool("gate.approve", { presence: { summary: async input => "Send email to bob@example.com: \"Hi Bob…\"" }, ... })
```

The floor also keeps its own list, in `core/presence/index.js`, so these tools need presence even
before their owners declare it, and a module cannot declare its way out:
`gate.approve`, `gate.revise`, `gate.reject`, `threads.answer`, `vault.put`, `vault.approve`,
`vault.unlock`, `vault.offboard`, `learn.accept`, `learn.retire`, and presence's own
`presence.enroll`, `presence.remove` and `presence.code`. A module's declaration can only add to
this list (principle 7).

`Registry.call(tool, input, caller, { proof })` refuses a presence tool with
`{ error: { code: "presence_required", methods } }` (HTTP 403) unless the proof checks out,
**whatever the caller claims**. Two things are exempt:

- **Module callers** (`module:<name>`). Only the loader can make these, and modules are code the
  user installed. A module that turns an outside event into a presence call (the chat module
  turning a Mattermost button into `gate.approve`) must prove the person itself, for example by
  the Mattermost user id, and the Gate's `approvers` list still decides which modules may approve.
- **A registry built without a presence verifier.** Only unit tests build one. vyred always
  builds one, and a test checks that it does.

A proof is bound to one tool and one input: the SHA-256 of the canonical JSON of the input (keys
sorted, no spaces). It is used once and expires after 2 minutes. A proof for "approve item A"
cannot approve item B.

The proof travels in one header, `x-vyre-presence: <method> k=v k=v ...`. Binary values are
base64url, and ids and codes are plain tokens in the same alphabet.

| Method | Where | Proof | What the model cannot do |
|---|---|---|---|
| `touchid` | the Mac | vyred itself shows the macOS authentication dialog (Touch ID, Watch or password), with the summary as its reason | press the sensor or type into the system dialog, which takes no synthetic keystrokes |
| `tty` | any terminal, the box over SSH | vyred writes a code and the summary straight to a **login terminal**, and the person types the code back | read what is written to a terminal it does not hold the master of; a `script` pty is not a login terminal |
| `capsule` | the Capsule | an Ed25519 signature over the call by a per-install key that Electron's main process keeps in the keychain, made only after a click | read a keychain item whose ACL names only the Capsule |
| `passkey` | the Deck, on the tailnet or locally | a WebAuthn assertion with user verification, over a challenge from vyred | make a platform passkey assertion; that needs the device's biometric |
| `code` | enrolling a passkey | a one-time code from `presence.code`, which itself needs presence | (only accepted by `presence.enroll`) |

**Challenges.** `POST /v1/presence/challenge { tool, input, method, ... }` starts a proof that
needs one:

- `tty`, with `tty: "/dev/ttys003"`. vyred checks that the path is a terminal device owned by this
  user, and that `who` lists it as a login session. Terminal.app, iTerm, sshd and getty sessions
  are listed; `script`, `expect`, Python `pty` and tmux panes are not. vyred then writes, straight
  to that device: the summary and a 6-character code. It returns `{ challenge }`. The client asks
  the person for the code and retries the call with `x-vyre-presence: tty id=<challenge> code=<code>`.
  After three wrong codes the challenge is gone.
- `passkey`. vyred returns `{ challenge, webauthn: { challenge, rpId, allowCredentials, userVerification: "required" } }`.
  The Deck calls `navigator.credentials.get` and retries the call with
  `x-vyre-presence: passkey id=<challenge> cred=<id> ad=<authenticatorData> cd=<clientDataJSON> sig=<signature>`.
  vyred checks the type (`webauthn.get`), the challenge, the rpId hash, the UP and UV flags, and
  the signature (ES256, EdDSA or RS256) against the key enrolled for that credential.

`touchid` and `capsule` need no challenge:

- `touchid`. The call carries `x-vyre-presence: touchid`, and vyred runs its authentication helper
  (`core/presence/touchid/`, built from Swift with `swiftc` on first use, and hash-checked before
  each run). vyred shows one dialog at a time. After a cancel it waits 30 seconds before it shows
  another, so a model cannot wear the user down with repeated dialogs.
- `capsule`. The call carries `x-vyre-presence: capsule key=<id> ts=<ms> nonce=<n> sig=<s>`. The
  signed message is `vyre-presence-v1\n<tool>\n<input hash>\n<ts>\n<nonce>`. The timestamp must be
  within 60 seconds and the nonce unused.

**Enrollment.** Capsule keys and passkeys are rows in the `presence_keys` table in vyre.db, public
keys only. `presence.enroll` and `presence.remove` need presence themselves. The first key on a Mac
is enrolled with Touch ID. On the box it is enrolled with a `tty` proof over SSH, or with a
`presence.code` minted at such a terminal and typed into the Deck.

**What the person sees.** Every method shows the tool's summary before the person proves anything:
in the dialog's reason, on the terminal, in the Capsule and in the Deck. A tool with no summary
function is shown as its name and a short form of its input. That is legal but poor, and owners
should supply a summary. For the Gate, the summary is the destination and the start of the final
content (floor rules 1 and 2).

### Layer 2 · The floor closes the model's routes

The PreToolUse floor (`core/harness/rules.js`) also runs in-process when vyred is down (see
`harness/hooks/hook.js`). It denies the model's ways around layer 1 before they run:

- **Human-only `vyre` commands.** `vyre call <presence tool>`, `vyre gate approve|revise|reject`,
  `vyre threads answer`, `vyre vault put|approve|unlock|offboard`, `vyre learn accept|retire` and
  `vyre presence ...`, however the command is reached: a path to `bin/vyre`, `node .../bin/vyre`,
  `npx vyre`, `env`, `sh -c`, `bash -c`, `eval`, `xargs`, quotes split inside words, backslashes,
  or `$'...'`. A `vyre` command whose words come from variables, command substitution or globs is
  asked about, not allowed.
- **Raw socket clients.** `curl --unix-socket`, `nc -U`, `socat UNIX-*`, Python `AF_UNIX` and
  Node `socketPath`, aimed at `vyred.sock`, the `/tmp/vyre-<uid>` folder or anything in VYRE_HOME,
  are denied. So is any command that writes an `x-vyre-caller` or `x-vyre-presence` header. Unix
  socket access whose target cannot be read from the command is asked about.
- **Vyre's internals.** Reading, listing, copying or writing `vyre.db`, the socket, `config.json`,
  keys, logs and the vault under VYRE_HOME is denied, by Read, Write, Edit, Grep, Glob and Bash,
  including through `$HOME`, `${HOME}`, `~` and globs that could match `.vyre`. VYRE_HOME's
  `watchers/` and `modules/` stay open, since the write-a-watcher skill works there. Writing into
  `modules/` is asked about, because a module runs inside vyred.

Layer 2 is a filter over shell text, and shell text can always be obfuscated further than a
filter can read. That is why layer 1 exists. Layer 2 turns an easy bypass into a visible,
refused attempt that Learning records.

### Agent identity (the switchboard's work)

A different question: which agent is calling. The Switchboard gives each agent's child process
`VYRE_AGENT_KEY`, and vyred believes an `*agent:<name>` caller only with the key of a live thread
of that agent (`threads.vouch`). It stops one agent posing as another, or as the assistant. It
does not prove a person is there, and presence does not name agents. The two checks are
independent, and a presence tool refuses an unproven agent whichever name it claims.

### Tailnet identity is not presence

The box identifies a Deck request by `tailscale whois` of its source address (ADR 0002). That
proves which **device and login** sent it, not that a person is there. Claude Code on the user's
Mac is on the same tailnet as the same login, and it can reach the box's listener with curl.
So `tailnet:<login>` gets no exemption, and the Deck proves presence with a passkey like
everything else.

## What this does not defend

Code running as the user can rewrite Vyre itself: edit `core/presence`, restart vyred, swap the
helper binary or write a row into vyre.db. Layer 2 denies and asks about the direct forms of
this, and the helper is hash-checked, but no user-space program can fully defend itself from
its own user. The line we hold: a model that uses Vyre's interfaces, including the socket, the
CLI and the MCP server, cannot complete a human-only action without a person proving presence
after seeing the summary.

Two residual risks in the terminal method, both of which still need a person:

- A model can start `vyre` with its input and output pointed at the user's own login terminal
  (the one running `claude`). vyred then writes the code and summary to that screen, and the
  model's client waits for keystrokes. It completes only if the person types the code shown next
  to the summary.
- On a Mac, a model can open a new Terminal window with `osascript`. If the user has also given
  that terminal Automation or Accessibility access, the model may be able to read the window
  back. On a Mac with Touch ID, `vyre` uses `touchid` first for this reason.

## Consequences

- Owners of human-only tools add `presence: true` or a `presence.summary`, and their tests pass a
  proof or call through a registry without a verifier.
- The CLI (`core/cli/presence.js`) handles `presence_required` itself: `touchid` on a Mac that
  has it, else `tty`. For every method it first needs a controlling terminal, so a process
  with none (the Bash tool) cannot even make a Touch ID dialog appear. `vyre call` and every command that reaches a presence tool go through it.
- The Capsule enrolls a key at first run (with Touch ID) and signs presence calls. The Deck
  enrolls a passkey and sends assertions.
- `GET /v1/tools` marks presence tools with `presence: true`, so a surface can prompt before it
  calls.
- New events: `presence.proved` and `presence.refused`, holding the tool, method and caller, and
  never a code or key.

## Addendum, 26 Sep 2026: after review with the other workstreams

**The floor's list grew.** It now includes the vault's value-out tools (`vault.inject`,
`vault.totp`, `vault.backup`, `vault.restore`, `vault.delete`, `vault.device.code`,
`vault.device.unlock`, `vault.unlock-passphrase`, `vault.reveal`, `vault.copy`, `vault.resolve`,
`vault.render`, `vault.session.open`, `vault.export`, `vault.kit`), `learn.relax`,
`learn.skill_install`, `computers.takeover`, `computers.giveback` and `link.pair.approve`.

Tools with a pending flow for Claude stay off the list, because their approval step is on it:
`vault.grant` and `vault.pass.create` wait for `vault.approve`. `vault.import` stays off too. An
owner who wants presence on any of these declares it. The list is the minimum the floor needs,
and a declaration only ever adds to it.

**What a tool sees.** `run(input, { caller, thread, agent, peer, presence })`, where
`presence = { method, keyId }`. `keyId` is the enrolled Capsule key or passkey, or null. The
proof itself never reaches a tool.

**The terminal method on the box.** The box never takes a terminal code (`role: "box"`), for two
reasons:
- The Mac that Claude runs on usually holds the user's SSH keys, and `ssh -t box` gives a model a
  login terminal whose client end it holds.
- In the box's container, `vyre` reaches vyred through `docker compose exec`, whose terminal no
  `who` lists. Nothing the wrapper could pass in would be more trustworthy than what Claude
  inside the container could pass.

The first passkey comes from onboarding instead. `onboard.finish` mints a `presence.code` as a
module caller and hands the person a Deck link carrying it. Pairing and every later approval on
the box use a passkey. On a Mac, `ssh localhost` gives a model a login terminal in the same way
when Remote Login is on. That is one more reason `vyre` uses Touch ID first.

**Box identity.** `tailnet:<login>` is an owner device, not a person. Claude on the Mac shares
that login. A tailnet caller may read what the owner may read, but it gets no presence.

**What presence cannot fix on the box.** Claude's sessions run as uid 1000 in vyred's container
and network namespace. From there they can:
- read `~/.vyre`, including a file keystore;
- drive the tailscale CLI as operator;
- reach the Docker API proxy (`docker-api:2375`).

The proxy filters endpoints, not bodies. A `POST /containers/create` with `Privileged` or a bind
of `/` is root on the host, whatever `DockerDriver.create()` refuses to build. The floor now
denies these by command text. The real fix is separation:
- Run Claude's sessions as a separate uid with no read access to `~/.vyre`, as tailscale's
  non-operator, and outside the `docker-api` network.
- Or put a body-checking proxy that vyred owns in front of the Engine. It should allow only the
  create body ADR 0009 describes, and exec only into `run.vyre.computers` containers.

**Sessions, for the Deck.** Someone revealing or copying items one after another should not need
a passkey for every click. `presence.session.open` is on the floor's list and opens only after
Touch ID, a Capsule signature or a passkey. It returns a secret that lasts 5 minutes idle and 30
at most, bound to the tailnet node that opened it. The proof is then
`x-vyre-presence: session id=<id> secret=<secret>`.

Only the floor's `SESSIONABLE` tools (`vault.reveal`, `vault.copy`, `vault.totp`) take it, and
only when the tool's `presence.session(input)` says yes, so a reprompt item never rides a
session. A tool-side skip that reads headers is not accepted, because headers are what a model
forges.

**Accepting a lesson by reply.** A lesson changes what Claude is told in every later session, so
a forged "yes" is a persistent prompt injection, not only a stricter rule. Learning may accept by
reply only when the prompt came from a person. That means an interactive Claude Code prompt, or a
`threads.send` whose surface proved presence. A prompt that an agent or the assistant typed into
a thread never counts, and neither does `-p` input.

**Merging.** Presence applies to every human-only tool as soon as it reaches `main`. Any test that
starts a real vyred and calls one of these tools as a person needs a verifier:
`start({ presence: present })` (from `test/helpers.js`), or a real proof. The security branch
already carries those edits for the gate, vault, watchers, switchboard, Capsule bridge,
computers, glass, hands, link and CLI tests. A branch that merges after it keeps them, and adds
the same line to any new test of that kind.
