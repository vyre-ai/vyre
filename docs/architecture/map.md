---
title: The Vyre map
summary: A 30-minute map of how Vyre is built for a developer who has never seen it: the kernel and its contract, modules, the Gate and approvals, the Vault, Records and Flows, Connections, the harness, the apps, the network and where every kind of data lives.
audience: builders, operators
owner: docs
status: stable
---

# The Vyre map

This page is for a developer who has never seen the code. Read it top to bottom in about 30 minutes and you will know what the parts are, what each one owns, how they call each other, where data lives and which rules you must not break. It links to the deeper page for each part. The code is the final word; the tables on this page marked as generated are written from the tree and a test fails when they drift, so they are always true.

The words Lumen, Space, Wink and the Gate are product names and are used as the product uses them.

## 1. Vyre in one page

Vyre is software that runs a person's or a firm's work with AI helpers they can trust. You run it on a server you own (a Linux machine, or a Mac that stays on) and use it from the Vyre app on a phone or computer and from Lumen, the command bar on a Mac. Everything an AI helper does for you goes through rules you can see and approve. The three ideas that shape the whole design are these.

- **One small trusted core.** Everything that decides who may do what, writes the history of what happened, and holds secrets lives in the kernel, a small body of code with almost no dependencies. Features are modules around it. A feature may add screens, record types and Flows. It may not add a new kind of permission, a new log, a new place to store items or a new way to run steps. If it seems to need one, the core is changed instead, once.
- **A person decides, and proves it.** Anything that leaves your Space (an email, a payment, a deletion, a publication) waits until a person has seen the exact words and approved them on a device that can prove a person is there. An AI helper can ask. It cannot approve.
- **Secrets stay where the helper cannot reach.** A model never sees a vault value or a sealed field. It sees a placeholder, and the real value is put in at the moment of sending, outside the model.

The rest of this page shows how those three ideas are built.

## 2. The machines and the daemon

Vyre runs as one daemon, `vyred`, per machine. It is the same program everywhere. What it starts depends on the machine's kind, set in `config.json` in the Vyre home (`~/.vyre` unless `VYRE_HOME` says otherwise).

| Machine kind | Where | What it starts |
| --- | --- | --- |
| `server` | a Linux server, or a Mac you chose as the server | everything, including the address the apps connect to and the relay |
| `solo` | a Mac with nothing else to connect (the default on macOS) | the full local set, Lumen included |
| `device` | a computer that joins a server (the default on Windows) | the local set that reaches the server |

A server is also called the box. A Linux box runs in Docker Compose from `/srv/vyre` (`box/compose.yml`): one container for `vyred` and its sessions, one filtered Docker API for agents' computers. A Mac that is a server runs a macOS system service instead: `vyre-core` (root-installed, its own `_vyre` account, `core/vyre-core`) holds the keys and `vyred` runs as the owner, both started by launchd at boot with nobody signed in. See [The box and the Mac](../concepts/box-and-mac.md).

Every module says which machines it runs on (`roles` in its `module.json`: `box`, `local`, or both when omitted). A module that runs on both works on each machine's own data: recall on the Mac searches the Mac's transcripts, recall on the server searches the server's.

Around the daemon sit the surfaces (section 10), the relay and the Wink network that connect machines (section 11), and the harness, a Claude Code plugin loaded into every session Vyre starts (section 9).

## 3. The kernel

The kernel is the trusted core. It is one directory, `kernel/`, and it runs the same code on a server, a phone and a browser, so it imports almost nothing: Node's own modules only in files that run on a server, `lib/databox.js` (the one place the encryption boxes, key derivation and hashes are made), and three exactly pinned audited crypto packages. `kernel/DEPENDENCIES.md` is the rule and `kernel/dependencies.test.js` enforces it. Changing the list is a ruling, not an edit.

`kernel/index.js` is the composition root. For one Space it wires the event log, the record store, the actor chain builder, the grants store, the limits, the tasks, the rule evaluator, the sealing client, the inference door and the gateway. `kernel/boot.js` does the same with the durable SQLite store, and a restart rebuilds grants, members and meters by replaying the log. `kernel/home.js` runs a kernel on a daemon's home. Features reach the kernel only through the gateway, under chains the kernel builds.

The folders of `kernel/`:

<!-- map:kernel:start -->

| Folder | What it is |
| --- | --- |
| `kernel/audit/` | Signed checkpoints of the event log, so a rollback or a split history is caught. |
| `kernel/conformance/` | The conformance suite every store, log and sealing process must pass. |
| `kernel/contracts/` | The shape of everything the kernel exchanges: types and frozen tables, no logic. Changes are additive only. |
| `kernel/core/` | The small core: the actor chain, authorize, the gate wrapper, events, presence, ids and URNs, fields, limits. |
| `kernel/door/` | The inference door: the one path a model call is meant to take, with scanning and sealed placeholders. |
| `kernel/expr/` | The expression language rules and Flows are written in. |
| `kernel/flows/` | The Flow runner: steps, triggers, stages, proposals, the code sandbox. |
| `kernel/gateway/` | The one API for records, events, grants and sealed uses, assembled from the parts below. |
| `kernel/golden/` | Pinned vectors that every implementation of the identity and event rules must reproduce. |
| `kernel/grants/` | Grants, members and the five roles, rebuilt from the log. |
| `kernel/identity/` | A person's identity: keys, the signed list of who speaks for them, recovery. |
| `kernel/modules/` | The sandbox that runs an added (not first-party) module in its own process. |
| `kernel/placement/` | Placing work on computers from signed descriptions; it decides where, never whether. |
| `kernel/remote/` | Calling another machine's kernel over Wink or the relay, with proofs. |
| `kernel/retrofit/` | Adapters that bring older features under the kernel's rules. |
| `kernel/seal/` | The sealing process: the only place sealed plaintext exists, and presence proofs are checked. |
| `kernel/spaces/` | One kernel per Space, and a handle to a Space this machine does not host. |
| `kernel/storage/` | A Space's Drive: encrypted chunks over local disk, S3 or a device. |
| `kernel/store/` | The record store interface and its in-memory, SQLite and sealed forms. |
| `kernel/tasks/` | Tasks and approvals: how work is given, checked and how anything asks a person. |
| `kernel/tools/` | The tool surface generated for a Space from its types and grants. |

<!-- map:kernel:end -->

The kernel's types and frozen tables are in `kernel/contracts/` ("the studs"). They contain no logic. A change there is additive, in one commit, and the lead is told: everything else in the system is built against them.

## 4. The contract: six things and one gateway

Everything is built from six things. Nothing else is allowed to become a seventh.

1. **Space.** Where things live and whose rules apply: your personal space, a firm's, a team's. One kernel per Space (`kernel/spaces/`). A Space this machine does not host is reached through a remote handle over Wink or the relay (`kernel/remote/`). Spaces share by explicit bridges, never by merging. A call acts in exactly one Space, and it is never a guess: the call names it (a `space` id in its input), or it names a record by URN (`vyre://<space>/<type>/<id>`) and the Space is the one in the URN. A call that names neither acts in the home's own Space, and every answer says which Space it acted in (an `acted_in` field with the id and a plain label). The caller's chain belongs to one Space, so a call that names another is refused (`wrong_space`).
2. **Actor.** Whoever acts: a person, an agent, a device, a service or an automation. A model is only ever an agent. People and agents are equal in that both can be assigned work and held accountable.
3. **Record.** Every thing: a contact, a matter, a task, a note, a file, a chat. The definitions of a business (a record type, a Flow, a view, a role) are records too, so they are versioned, granted, undone and audited the same way as a contact.
4. **Grant.** Who may do what to which records, with limits: where, until when, with whose approval, up to what spend. There are five roles, owner, admin, manager, member and temp, each a named set of actions. A wildcard never covers admin, grant or outward actions. A grant change is itself an act that needs a person's proof.
5. **Event.** Everything that happened, written once to the Space's log: who, what, when, why, and what changed. Types are two words, `noun.past-verb`. Each event carries the full actor chain and is hash-linked to the one before it, with the data held behind a commitment, so erasing data on request leaves the chain verifiable. A signed checkpoint every 1,000 events or 10 minutes lets a device notice a rollback or a split history (`kernel/audit/`).
6. **Flow.** A small program: when something happens, run these steps. A step is done by Vyre, by an assistant or by a person (section 7).

**The actor chain.** Authority is never read from a header or a name. For every call the kernel builds a chain from facts it verified itself (which socket, which signed session, which key): the person at the surface, the agent they started, a Flow step, and so on. A chain is an immutable list of hops, and the authority of a call is the intersection of every hop's grants. A hand-made chain object is not a chain. This is why an agent running as the same operating-system user as you still has no more power than you gave that agent.

**One gateway.** Every read and write of any record, from the app, the phone, an assistant, a Flow or a module, goes through one place. It asks `authorize` (the chain, the action, the resource), which answers allow, deny or ask, with a reason and a decision id. Allow goes on. Ask turns into a task for a person. Deny looks like absence: the caller is told the thing is not found, and the true reason is kept for the audit. Every decision writes its event.

Two layers use the word "gate", and it helps to keep them apart. In `kernel/core/gate.js` the gate is the wrapper every kernel call uses to ask `authorize`. The Gate in section 5 is the outbound hold queue for things that leave your Space.

The full contract is in the [specification](spec.md), Sections 5 to 7 and 11.

## 5. The Gate, presence and approvals

**What is held.** An agent never sends, spends or deletes by itself. It calls `gate.request` and the item is held in the Gate (`core/gate`): its text, where it is going, and what it would do. The person may edit it. Approving, revising and rejecting refuse an agent caller. The credential that sends it (a mail account, an API key) is fetched from the Vault at send time, so the agent never held it, and what is sent is exactly the words approved. Two screens pressing Send at once send once. A failed send returns to held. Events about a held item never carry its content.

**Presence.** Approving an outward act needs proof that a person is there. The proof is a signature over the exact payload (the tool, its input, the decision and the chain) from a key held in hardware: the Secure Enclave on a Mac or iPhone, a TPM or Windows Hello on Windows, StrongBox or the Keystore on Android, a platform passkey in a browser. A click is not a signer. The one verifier is the sealing process (section 6). A proof is used once.

**Why an agent cannot use the owner's key.** Three things hold together. The key never leaves its chip (Secure Enclave, TPM, StrongBox), so nothing can copy it, and every signature needs the person's own fingerprint, face or PIN on that device, which a program cannot supply. The signing happens in the person's own app on their own device (usually the phone), not on the server where agents run, so an agent has no path to the chip. And the app (the Windows shell does the same) reads the bytes it is asked to sign and shows the person its own words for them, and refuses bytes it cannot read, so a program cannot get a yes for one thing by describing another. Even a stolen proof is worth little: it is bound to one exact request and counts once. The sealing folder is separate again: Vyre's sessions are sandboxed away from it on a Mac or Linux home. `docs/concepts/presence.md` lists which tools need it and how each surface proves it.

**Tasks are how anything asks a person.** A task (`kernel/tasks/`) has one doer, an optional checker and a declared result, and moves through waiting, ready, working, needs_check, stuck, done and skipped. A held send, a grant request, a pairing request, a request to reveal a sealed value and a Flow step that needs a person are all tasks, so one inbox ("Now", and "waiting" in `core/waiting`) shows them all. An approval is accepted only from a chain that is exactly one person and carries a hardware proof over the exact payload. It is single-use authority for exactly the act it names, handed to whoever does it. A paired phone can sign the payload's hash with Face ID so a session that cannot prove presence itself can still get a yes (`core/approvals`).

**The floor.** Nine rules hold whatever else changes, in `docs/concepts/floor.md`: nothing goes out as you until you have seen the final words, you see where it goes before it goes, a thread is one thing wherever it is viewed, one screen types into it at a time, every file change is visible, only an explicit question asks for your attention, anything Vyre tells you shows its source, no vault value appears on any screen, log or event, and Lumen works offline for your own Mac. The rules run twice, in Claude Code's own hook and in `vyred` for every call that does not come from you at your own surface.

## 6. The Vault and sealing

**The Vault** (`core/vault`) holds credentials sealed at rest and releases one item at a time to a module or agent that declared the need. A module calls `ctx.vault.fetch`, never the store. Every item has its own random key wrapped under the vault's key, which a device key (agents' vault) or an account unlock key (personal vault) opens. The master key lives in the macOS Keychain, a 0600 file, or a passphrase-wrapped file. Passes to another person's Vyre are relayed (the value stays on your server) or sealed (an encrypted copy).

**The sealing process** (`kernel/seal/`) is the place where secrets that belong to records, not to modules, are kept. It is a separate child process, started with a bare environment, that talks to the kernel over pipes only the parent holds. It is the only place sealed plaintext exists, apart from the view where a person reveals a value. It also checks presence proofs, makes and verifies the kernel's own MACs (the kernel holds no key of its own), and holds the Space's checkpoint key. Errors it returns carry a code and never the input.

**Sealed fields.** One setting on any field makes it sealed. A sealed value is never seen by an AI model, from any provider. The model sees a placeholder (`{{field:<record>#<name>}}`). The real value is put in at send time, under the asker's chain, into the held outward act, so it appears only in the person's approved message. The classes of sealed data (social security numbers, card numbers, bank accounts, passports, medical and so on) are a fixed list. A Kit cannot add one.

**The inference door** (`kernel/door/`) is the one path a model call is meant to take. It checks the sink (the provider and its host), the bounds and the budget, scans every message and replaces anything that looks sealed with its placeholder, keeps a ledger so a prompt that still holds a resolved or revealed value is refused, and scans the reply too. A refusal names the rule and the class, never the value. A few older callers still reach providers directly (`kernel/door/sinks.json` lists them as pending), so today the server's outbound firewall is the real control for those.

**Where the master key lives, honestly.** On a Mac or Linux home the sealing key is a 0600 file in the sealing folder. Vyre's own sessions are sandboxed away from that folder, and the disk's encryption protects it at rest, but root, or a program running as you outside Vyre's sandbox, can read it. `custodyNote` in `kernel/seal/process.js` says this in plain words to the person. An OS keystore is the upgrade path.

## 7. Records and Flows

**The records language** (`records/`) is a small typed language: record types, fields, stages, rules, views, Flows, roles and expressions. A firm describes its world in it. The app edits it, and an assistant, @Engineer, writes it. Both produce the same stored definitions, and a definition file is TypeScript that is read, never run. A Kit is a package of definitions: `records/kits/` has `base` (contacts, leads, appointments, clients, subscribers, projects), `estate-planning` and `law-firm`. `records/core-types.js` holds the built-in types, `records/comms/` logs communications with a default Flow, and `records/calendar/` syncs calendars.

**Stores.** Records live behind one store interface (`kernel/store/`). The built-in store is the home's SQLite, small and always there. `stores/twenty` runs one unmodified Twenty CRM per Space behind the same interface, which is the "Records" choice at install: a server with enough memory uses it, and a small server uses the built-in store. The install decides per Space from the memory that is free: a Space on Records needs about 3.1 GB, or about 2.5 GB on a machine with under 6 GB in all (a lighter profile), plus 6 GB of disk, and the number of Spaces that fit is the free memory less 300 MB, divided by that need less 300 MB. Zero fits means the built-in store, and Records can be turned on later in Settings when the server has the room. So 8 GB is the recommended size and 4 GB the least that reaches one Records Space; with about 2.8 GB free or more a Space fits, and below that (a 2 GB server) it runs on the built-in store, which needs about 2 GB. `VYRE_STORE` chooses: `auto` (the default) or `sqlite` to force the small store. On Linux a root helper starts each Space's Twenty (`box/vyre` space helper); `vyred` only drops a request file into a spool and reads the status back.

**Flows** (`kernel/flows/`, module `core/flows`). A Flow is a trigger plus steps. The runner knows 19 step kinds: find, pick, filter, create, update, upsert, remove, decide, repeat, wait, ask, assign, call, stage, agent, classify, extract, service and fn. `ask` and `assign` give work to a person as a task. `service` calls a connection (section 8). `agent` gives a step to an assistant. `fn` runs a short piece of code (at most 64 KB of source) in an operating-system sandbox with no network, a time limit of 5 seconds by default and an output cap of 256 KB, and it refuses to run if the sandbox's self-test has not passed. An assistant that wants to change a Flow can only draft a proposal, which becomes a task. Applying it is `flows.approve`: a person's own act, in their own name, with their hardware proof, for one version named by its hash and only what the card showed. Nothing runs until then. A run then has the authority of the person who approved it (it needs only that approver's right to run Flows), so a Flow can never do more than its approver could. By role, a member may start a Flow and give a task; reading and calling a connected service are an admin's, because an admin approves the Flow that does it, and an outward step is still held for a yes. Every run writes events, so a run can be shown and undone.

## 8. Connections

A **connector** is a declaration, not code (`records/connectors/format.js`): one exact https host, how the key is sent, a rate limit, and a list of operations, each marked as read, draft, change, send, spend or delete. That mark is the only source of "outward", and anything not declared cannot be called. Gmail drafts are not outward; Gmail sends are. Stripe, Gmail and Google Calendar ship as declarations.

A firm can **make its own connection** to an outside service: a form (host, how the key is sent, operations, fixed values) or an API description in OpenAPI form turns into a declaration (`records/connectors/connection.js`, `import-spec.js`). `core/connectors/made.js` stores each one with a vault credential of its own. Only a person's own surface can create or change one. A Flow uses it with the `service` step.

The key never reaches a module or a model. `ctx.vault.request` attaches it outside the sandbox when the call is made, and a send, spend or delete waits at the Gate for a person's proof on exactly that act.

Other outside services: `core/connectors` also keeps a catalog of vendors that run their own hosted MCP server, `core/mcp` is the hub that connects them (each is a sender at the Gate named after the server), and `core/google` and `core/github` are native. Webhooks coming in from the internet are `core/hooks`, each route checked by the sender's signature.

## 9. The harness, sessions and the MCP server

**The harness** (`harness/`) is a Claude Code plugin. Its seven hooks call back into `vyred`: a brief at session start, enrichment of a prompt, the safety rules before each tool, learning after, failures, stop and end. Its MCP server (`harness/mcp/server.js`) holds no tools of its own. It lists whatever `vyred` has and forwards calls, turning a dotted name like `recall.search` into `recall_search`. It also offers the tools of connected MCP servers. Skills and the `/vyre` command are in the same folder.

**How a session starts.** Vyre starts headless Claude Code sessions itself (the switchboard, `core/switchboard`, module name `threads`). It passes the plugin with `--plugin-dir`, passes `--strict-mcp-config` with a config that names only Vyre's own server, so the account's own connectors and settings are not loaded, and streams the session to every surface, one keyboard at a time. A thread's id is the Claude session id. `core/sessions` holds the drivers and the system prompts. `core/runner` runs a Space's AI sessions on a computer inside a sandbox, in an encrypted workspace opened by a leased key.

**What a session may call.** A tool in the registry carries a `reach`: `anyone`, `asked`, `modules`, `hook` or `person`, and outward tools are marked and held at the Gate. For a Space's records, `kernel/tools/surface.js` generates the surface: a `find`, `create` and `update` per type, `move_stage` for staged types, tasks tools, and one tool per outward action, cut down to what the caller's grants allow. A tool that needs approval returns a held result, not an error.

## 10. The apps and surfaces

Every surface talks to `vyred`'s API. None reads a store directly.

| Surface | What it is | Code |
| --- | --- | --- |
| The Vyre app | One Expo app that runs as a web app at your server's `/app/`, on iPhone and on Android: Now, Chats, Projects, Records, Flows, Vault, Settings | `apps/app` |
| Lumen | The Mac command bar (press Control twice), a Swift app | `local/capsule` |
| The Windows app | A Rust and Tauri window around the same app, a tray and the device's keys in Windows Hello and DPAPI | `local/capsule/native-win` |
| The command line | `vyre`, including `vyre call` for any tool and `vyre doctor` | `bin/vyre`, `core/cli` |
| The status line | One line under every Claude Code session | `core/statusline`, `harness/statusline` |
| Glass | An agent's screen, live, with take-over | `core/glass`, `core/computers` |

The app is built once and served by `vyred` at `/app/` (`core/daemon/app.js`), but only files on the release's signed list. In the Mac and Windows apps the same build runs in a window with no server of its own and reaches the server over the relay. Phones are sideloaded for now: a Mac disk image, an Android file, an iPhone build from a script.

A module can describe screens in its manifest (a list, board, summary, detail or form) and Vyre draws them in the app and in Lumen; the module's code never runs in the app (`core/views`, the engine in `lib/views`). Apps from the open-source world run as containers on a server through `core/appmods`, from a pinned catalog; Documents is first.

## 11. The network: relay, Wink and names

Machines reach each other in two ways. Directly, over the Wink network, which is Vyre's own (a Go forwarder in `wink/forwarder`, built into the server image, and `core/wink`). Or through the relay (`relay/`), which a server dials out to, so a server needs no open port and a paired phone always reaches it. A device is **paired** by scanning a code or typing two-sided codes, and the pairing is a grant like any other. The relay carries only encrypted traffic between devices that proved each other's keys (Noise, in `relay/client`). It cannot read it.

A person's name (`you.vyre.run`) is reserved on the web and claimed in the app, signed with the identity key. The directory is a Cloudflare Worker (`names/worker`, `core/names`). A name belongs to an identity or a Space, never to a server. The hosted app at app.vyre.run and the relay are the only central parts, and the server works without the hosted app. There is no other VPN or network account to sign in to, so nothing about reaching a server can be lost with a login on a restart. See [Your private network](../concepts/network.md).

## 12. Where data lives

| What | Where |
| --- | --- |
| The Vyre home | `~/.vyre`, or `VYRE_HOME`, mode 0700 |
| Settings | `config.json` in the home |
| The daemon's database (WAL mode SQLite), including the personal Space's kernel tables | `vyre.db` in the home |
| Other Spaces | `kernel/spaces/<id>/` in the home: its own `kernel.db`, key and `space.json` |
| The sealing folder | `kernel/seal/` in the home (the master key is `master.key` in it) |
| The vault | `vault/` in the home |
| Logs | `logs/` in the home, one file a day |
| The daemon's socket | `vyred.sock` in the home, or a named pipe on Windows |
| A Linux box | the stack in `/srv/vyre` (`compose.yml`, `vyre.env`, `.env`, `backups/`), the home inside the container volume `vyre_vyre-home`, work folders in `vyre_vyre-work`, update and Space spool folders `/var/lib/vyre-update` and `/var/lib/vyre-spaces` |
| A Mac that is a server | the root service under `/Library/Application Support/Vyre` (code under `versions/`, data, the socket folder), its launchd jobs in `/Library/LaunchDaemons`, and the owner's own home as above |
| The Windows app | `%LOCALAPPDATA%\Vyre` for the program and its log, and the app's own data folder for its keys |
| Records of a Space on a server with Records | that Space's Twenty database, in its own Docker volumes |

Nothing leaves a machine except through the relay, the Gate or a connection a person made, and every one of those is a grant and an event.

## 13. One request, end to end

A person asks the app, on a phone, to email a client. Follow one approval, by call name, in order. Two layers appear in it and they are told apart at the end.

1. **The app calls a tool.** The app sends the call to the server, through the relay if it is away from home. The server builds the chain (section 4) from the paired device's verified key, the person's signed session and the agent they started.
2. **The agent drafts and asks.** The agent writes the email and calls `gate.request` with the kind, the recipient, the content and the reason. `authorize` says ask, so the Gate stores a held item (`gate.held`) and a card appears in "Now" and in `waiting.list` with the exact words and recipient. Nothing is sent. Any sealed field in the draft is still only a placeholder. If the person's own words had already asked for exactly this (same kind, same recipients), the Gate lets it go at once and logs it instead.
3. **The person presses Approve.** The app calls `gate.approve` with the held item's id, and with their edits if they made any. The registry sees that `gate.approve` is an outward act that needs a yes with proof, and asks for one before it will run the tool.
4. **The yes is made on a real key.** A phone signs the payload hash itself with its hardware key (Face ID) and sends the proof with the call. A device that cannot sign (a browser, a session with only a software key) asks the owner's paired phone through the approvals module (`approvals.ask`, or the registry's own `approvals.hold` when the call came from something that is not the person). The phone lists the card (`approvals.pending`), shows the words, signs `payload_hash` and sends it with `approvals.answer`.
5. **The proof is checked and spent.** The sealing process is the one verifier. It checks the signature against a key it enrolled, that it covers this exact request, that it is fresh, and that it has not been used (`kernel/seal`, the presence check). A good proof marks the card approved and is used up at that moment, so no proof ever travels to the asker. The approvals module decides nothing itself: a wrong or replayed proof is refused by the act that carries it.
6. **The asker spends the yes once.** The app repeats `gate.approve` naming the approved card. The registry redeems the card exactly once, only for this request, and runs the tool as the person.
7. **The Gate sends exactly the approved words.** It marks the item sending, takes the mail credential from the Vault at that moment (`ctx.vault.fetch`; the agent never held it), sends the edited content and not the draft, and writes `gate.settled` or, on failure, returns the item to held. Two screens pressing Approve at once send once.

**When sealed placeholders are filled.** In the kernel's own path for records (a task whose output leaves the Space), the same order holds inside the sealing process. A task approved by one person with a hardware proof over the exact payload unblocks `seal.use` or `seal.deliver`. The process opens the sealed values, checks the presence proof for this operation and refuses (`needs_presence`) if it is missing or stale, and only after the check does it replace each `{{sealed:slot}}` in the body with the value and hand the finished text to the delivery. So a value is never filled before the proof is checked, and it exists as plaintext only inside the sealing process and in the delivered message.

Every step is an event with the full chain on it, so the whole path can be shown later. Two layers are in this trace: the Gate and the approvals module (modules, steps 2 to 7) and the kernel's tasks and sealing (the last paragraph). Both end the same way: the person's proof, once, for exactly one act.

## 14. The repository, top to bottom

<!-- map:layout:start -->

| Folder | What it is |
| --- | --- |
| `.claude-plugin/` | The Claude Code plugin marketplace entry that points at `harness/`. |
| `.github/` | GitHub Actions workflows: tests, releases, the Windows and Mac proofs, the docs build. |
| `apps/` | The Vyre app (Expo, in `apps/app`): web, iPhone and Android from one codebase. |
| `bin/` | The `vyre` command's entry file and the git credential helper. |
| `box/` | The server's Docker image, its compose files and the `vyre` command that runs on the host. |
| `core/` | The daemon `vyred`: its plumbing and the core modules, one folder each. |
| `design-refs/` | The picture tests' reference pictures for every block and key screen, made by CI in a pinned image (apps/app/scripts/design-pictures.mjs). |
| `docs/` | This documentation: concepts, how-to pages, the reference, the ADRs. |
| `examples/` | Example modules to copy from. |
| `harness/` | The Claude Code plugin: hooks, the MCP server, skills, commands, the status line. |
| `kernel/` | The trusted core: identity, grants, the event log, records, tasks, the sealing process. See the next section. |
| `lib/` | Shared pure code with no feature state: crypto boxes, identity helpers, the view engine, release signing. |
| `local/` | Modules that run on a person's own computer: Lumen (the Mac command bar), computer use, voice, the Windows app. |
| `modules/` | Optional first-party modules (computer use and Chrome for an agent's computer) and the vault's autofill extensions. |
| `names/` | The name directory (names.vyre.run), a Cloudflare Worker. |
| `packages/` | The module SDK: the manifest schema and its checker. |
| `packaging/` | Packaging for cloud images. |
| `records/` | The records language, Kits (starter sets of types and Flows) and connector declarations. |
| `relay/` | The relay that lets a paired device reach a server that has no open port: server, client library, web pages. |
| `release/` | Release data: the oldest version a release may update from, release notes. |
| `scripts/` | Installers, the docs build, the test and walk harnesses, evals. |
| `site/` | The public website at vyre.run. |
| `spec/` | The deep-link specification for the apps. |
| `stores/` | Record stores behind the kernel's store interface; today the Twenty store. |
| `test/` | Tests that cross folders: boundaries, docs, installers, releases. |
| `tools/` | Tooling for the Cloudflare workers. |
| `web/` | Static web assets. |
| `wink/` | The Go forwarder that carries Wink traffic, built into the server image. |

<!-- map:layout:end -->

## 15. Every module

`vyred` looks one level down in `core/`, `local/` and `modules/` for a `module.json`, validates it, picks the modules for this machine, orders them by what they require and starts them. A module that fails is marked failed and the rest carry on. The first module found under a name wins, so a module in the Vyre home can never shadow `vault`. A first-party module (a folder in the repository) runs inside `vyred`. An added module runs sandboxed: its own user, no network of its own, no raw secrets, its database limited to its own file (`kernel/modules/`, `core/modules/sandbox-ctx.js`).

A manifest names five things: what the module does (its tools), what it watches (events it emits), where it shows, what it needs (vault items, credentials, network, other tools) and what it teaches memory. Tool names start with the module's name and a dot. The [module contract](../build/module-contract.md) is the full reference and the [reference list of modules](../reference/modules.md) is generated from the manifests.

<!-- map:modules:start -->

### Identity, network and access

Who you are, how machines find each other, and who may do what.

| Module | Folder | Runs on | What it does |
| --- | --- | --- | --- |
| `approvals` | `core/approvals/` | box and local | Approve on your phone: a paired phone signs a request's exact words. |
| `bridges` | `core/bridges/` | box and local | Sharing between Spaces on purpose: a shared view, a reference, a copy, a Kit. |
| `gate` | `core/gate/` | box and local | The outbound Gate: what an agent wants to send, spend or delete waits here for a person. |
| `link` | `core/link/` | box and local | Makes a Mac and a server one system: pairing, tools and events both ways. |
| `names` | `core/names/` | box | Your name on vyre.run: claiming it and publishing its address. |
| `network` | `core/network/` | box | The built-in network as the person sees it: signed in or not, and each link. |
| `presence` | `core/presence/` | box and local | Proving a person is there before a human-only act. |
| `relay` | `core/relay/` | box and local | The way to reach a server that always works: it dials out to a relay and paired devices follow. |
| `signin` | `core/signin/` | box and local | `vyre signin`: the owner's phone approves a terminal. |
| `spaces` | `core/spaces/` | box and local | Identity, Spaces, members and invites: the five roles, with temporary access. |
| `vault` | `core/vault/` | box and local | Credentials sealed at rest and released one item at a time. |
| `wink` | `core/wink/` | box and local | Pairing as grants: every way into a machine is a Wink. |

### Sessions and agents

Claude Code and other sessions, the agents you name, and how they run.

| Module | Folder | Runs on | What it does |
| --- | --- | --- | --- |
| `agents` | `core/agents/` | box and local | The assistant and the agents a person makes. |
| `ask` | `core/ask/` | box | One card of several questions an agent asks a person at once, answered in the chat. |
| `assistant` | `core/assistant/` | box and local | The assistant's own tools: a daily digest and triage. |
| `attachments` | `core/attachments/` | box | Files added to a chat message: stored once in the chat's folder, handed to the assistants as an image or a path. |
| `harness` | `core/harness/` | box and local | What the Claude Code hooks ask vyred. |
| `import` | `core/import/` | box and local | Find this device's Claude Code sessions and import the ones you choose. |
| `models` | `core/models/` | box and local | The model registry: one list every picker reads from each provider, CLI and OpenRouter, and a pending eval card for a new model; it never holds a key. |
| `pluginagent` | `core/pluginagent/` | box and local | Claude Code on a computer as a named agent the person grants once. |
| `providers` | `core/providers/` | box and local | Every session provider on this machine, with its accounts and models. |
| `runner` | `core/runner/` | local and box | Runs a Space's AI sessions on a computer: sandboxed, in an encrypted workspace. |
| `sessions` | `core/sessions/` | box and local | How the sessions Vyre starts run: drivers, status and system prompts. |
| `skills` | `core/skills/` | box and local | Find the skills a session may use for what it is about to do: skills.find, skills.list, skills.get, cut by permission. |
| `stream` | `core/stream/` | box and local | The session stream: what the switchboard's threads emit, for every surface. |
| `threads` | `core/switchboard/` | box and local | Headless Claude Code sessions streamed to every surface, one keyboard at a time (the `threads` module). |
| `sync` | `core/sync/` | box and local | A paired Mac or Windows PC sends its own session files to the server. |
| `team` | `core/team/` | box and local | Project teammates: a named, persistent agent per role per project. |

### Work and records

Projects, records, tasks, rules, Flows, files.

| Module | Folder | Runs on | What it does |
| --- | --- | --- | --- |
| `artifacts` | `core/artifacts/` | box | Documents, pages, dashboards and small apps your agents make, kept on your server. |
| `builder` | `core/builder/` | box | Builds a site for Publish: a folder of ready files, a React page, or a folder with a Dockerfile built into an image in a rootless BuildKit. |
| `documents` | `core/documents/` | box | Word templates filled from records, PDFs, documents sent for signature and their signed copies filed on the client. |
| `files` | `core/files/` | box and local | Find and bring over files on this machine and the server, inside folders the person chose. |
| `flows` | `core/flows/` | box and local | Flows and Kits: write, approve and run a Flow with its triggers, waits and tasks. |
| `goals` | `core/goals/` | box and local | A goal and its ordered milestones, attached to a session or a project. |
| `planner` | `core/planner/` | box and local | Alarms, timers, reminders, todos, notes and a calendar kept on the server. |
| `previews` | `core/previews/` | box | A page or app an agent starts, opened in a pane beside the chat on its own address, kept running and shared on purpose. |
| `projects` | `core/projects/` | box and local | Projects: the folders, repositories and sessions that belong together. |
| `records` | `core/records-tools/` | box and local | The app's way into a Space's records: one tool per store call, under the caller's chain. |
| `rules` | `core/rules-tools/` | box and local | The app's way into a Space's standing rules. |
| `tasks` | `core/tasks-tools/` | box and local | The app's way into a Space's tasks. |
| `watchers` | `core/watchers/` | box and local | The watcher runtime: small standing rules that react to events. |
| `work` | `core/work/` | box and local | The work layer on the kernel: the native assistant's tools, teammates and memory layers. |

### Memory and context

What Vyre remembers and what it tells a session at its start.

| Module | Folder | Runs on | What it does |
| --- | --- | --- | --- |
| `about` | `core/about/` | box and local | A few lines on who the user is, handed to every session at its start. |
| `context` | `core/context/` | box and local | Where the person is now: the project, folder, thread and app each surface last reported. |
| `learn` | `core/learn/` | box and local | Vyre learns from corrections and enforces what it learned. |
| `memory` | `core/memory/` | box and local | The memory graph and the curator. |
| `recall` | `core/recall/` | box and local | Search over every turn of every session on this machine. |

### Outside services

Mail, Google, GitHub, webhooks, apps, computers and screens.

| Module | Folder | Runs on | What it does |
| --- | --- | --- | --- |
| `appmods` | `core/appmods/` | box | Open-source apps (Documents first) run as containers on a server, from a pinned catalog. |
| `comms` | `core/comms/` | box | One way to send a text or an email: it asks the Gate once, uses the person's own mail account or Twilio from the Vault, and logs it on the client. |
| `computer` | `core/computer/` | box and local | Vyre Computer: one front door over the cloud computer, your Macs and the screen engines; computers by name, interface first, screen last. |
| `computers` | `core/computers/` | box | Each agent's own computer, a shared pool of screens, and take-over. |
| `connectors` | `core/connectors/` | box and local | The catalog of vendors that run their own MCP server, and connections a firm makes itself. |
| `github` | `core/github/` | box and local | Sign in with GitHub, repositories, a project from a repository. |
| `glass` | `core/glass/` | box | Watch an agent's screen live and take it over. |
| `google` | `core/google/` | box and local | Native Gmail and Google Calendar. |
| `hooks` | `core/hooks/` | box | Inbound webhooks from the public internet, each checked by the sender's signature. |
| `mail` | `core/mail/` | box and local | One capability over every mail account the person connected. |
| `mcp` | `core/mcp/` | box and local | The hub for outside MCP servers; each is a sender at the Gate. |
| `outside` | `core/outside/` | box | Outside agents (Dots, Muse, ChatGPT): one address and token each, reading only what a person gave them, asking before any change. |
| `publish` | `core/publish/` | box | Put a site or app on the internet from your space: preview, approve, publish, go back. |
| `sight` | `core/sight/` | box and local | One screen service for the Mac and every agent's computer: what is on it, what was just done. |
| `chrome` | `modules/hands-chrome/` | box | Chrome control for an agent's computer, over one long-lived connection. |
| `hands-desktop` | `modules/hands-desktop/` | box | An agent's hands on a Linux desktop, through the accessibility tree. |

### The app, settings and small helpers

What the surfaces draw, and what keeps them informed.

| Module | Folder | Runs on | What it does |
| --- | --- | --- | --- |
| `appearance` | `core/appearance/` | box and local | The theme, the colour scheme and the design tokens as settings. |
| `brand` | `core/brand/` | box and local | The space's brand profile (logo, colours, fonts, names, letterhead), the default for what the space makes. |
| `commands` | `core/commands/` | box and local | Every command-line verb the running modules declare, as one list. |
| `design` | `core/design/` | box and local | The design language's keeper: the block catalogue, the space's own screens, proposals to change them, and guarded custom CSS. |
| `docs` | `core/docs/` | box and local | Find and read the docs from inside Vyre: docs.find and docs.read, with the agent docs offered only to agents. |
| `mentions` | `core/mentions/` | box and local | The # tag: one picker over everything a person may mention. |
| `push` | `core/push/` | box and local | Notifications to a phone or laptop for the moments the person asked about. |
| `settings` | `core/settings/` | box and local | One way to read and change every setting, at any level. |
| `sidebar` | `core/sidebar/` | box and local | The sidebar each person arranges: built-in places, module screens, saved views. |
| `statusline` | `core/statusline/` | box and local | The one-line status under Claude Code. |
| `suggest` | `core/suggest/` | box and local | Predictive text for every surface: names after @, commands after /. |
| `term` | `core/term/` | box and local | A terminal in the browser that survives like mosh. |
| `tips` | `core/tips/` | box and local | One short tip at a time about the part of Vyre in use. |
| `views` | `core/views/` | box and local | A module's screens, described by its manifest and drawn by Vyre. |
| `vyre` | `core/vyre-index/` | box and local | The live index of Vyre's modules for an agent with only the small tool core: vyre.core, from the map's table and the daemon's module list. |
| `waiting` | `core/waiting/` | box and local | One list of what waits on the person: asks, held drafts, reminders, pairings. |

### Running and updating Vyre

Modules, updates, onboarding, spend, vitals.

| Module | Folder | Runs on | What it does |
| --- | --- | --- | --- |
| `releases` | `core/apps/` | box | The Android app served from the server, signed with the owner's own key. |
| `events` | `core/event-catalog/` | box and local | Every event type the running modules may emit. |
| `modules` | `core/modulelist/` | box and local | The owner's reset of the accepted module list, for a deliberate downgrade. |
| `onboard` | `core/onboard/` | box and local | The first-run steps as tools the first screen calls. |
| `spend` | `core/spend/` | box and local | One ledger of what agents, sessions and memory spend, with a daily cap per provider. |
| `system` | `core/system/` | box and local | What this machine is running: version, role, host, memory, owner. |
| `undo` | `core/undo/` | box and local | The shared log of what agents and modules did, each with its inverse. |
| `update` | `core/update/` | box and local | Is a newer Vyre out: one daily look and one answer every surface draws. |
| `vitals` | `core/vitals/` | box and local | How the server and this device are doing: CPU, memory, disk, battery. |

### On a person's computer

Lumen and the Mac's hands, screen and voice.

| Module | Folder | Runs on | What it does |
| --- | --- | --- | --- |
| `apps` | `local/apps/` | local | Drive the Mac's own apps: timers, notes, reminders. |
| `capsule` | `local/capsule/` | local | Lumen, the Mac command bar: press Control twice and talk. |
| `chrome` | `local/hands-chrome-mac/` | local | Deep control of your own Chrome through the Vyre extension. |
| `hands` | `local/hands-mac/` | local | Computer use on macOS through the accessibility tree. |
| `screen` | `local/screen-mac/` | local | Screen context on macOS: front app, window, URL, visible text. |
| `sideview` | `local/sideview/` | local | A session on the left and Chrome or Glass beside it, tiled. |
| `voice` | `local/voice/` | local | Push-to-talk for Lumen with a speech provider. |

<!-- map:modules:end -->

## 16. How to read the code in your first hour

1. This page, then [The box and the Mac](../concepts/box-and-mac.md) and [the security floor](../concepts/floor.md).
2. `kernel/contracts/README.md` and `kernel/index.js`: the six things and how one Space's kernel is assembled.
3. `core/modules/index.js`: how a module is found, validated and started. Then one small module end to end, such as `core/system`.
4. `core/gate/gate.js` and `kernel/tasks/tasks.js`: how a held act becomes a task and a person's yes.
5. `kernel/seal/process.js` and `kernel/door/door.js`: where secrets are, and how a model is kept away from them.
6. `harness/mcp/server.js` and `core/switchboard/runner.js`: how a session sees Vyre.
7. `apps/app/README.md`: the app.

Decisions are recorded as architecture decision records in `docs/adr/`, the specification is [here](spec.md), and what is planned and what is not built yet is on the [roadmap](../roadmap.md).
