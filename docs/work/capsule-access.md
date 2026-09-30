# capsule-access: the local node's caller rules (C1, reviewer-2 capsule-pro H1)

Branch: work/capsule-02-access, off main 9381ab15. Owner: capsule-pro.

Status: sections 1 and 2 written. Implementation is on hold for one design decision (2.6),
because the rule as written closes the socket but leaves two other doors open on the same Mac.

## 1. What the code does today

Everything below comes from reading the code at 9381ab15. None of it was run against a real
paired Mac.

### 1.1 How a socket caller gets its label

- `core/daemon/index.js` `socketCaller(req)` takes `x-vyre-caller` as it comes. An empty label,
  or one matching `FORBIDDEN_LABEL` (`module:`, `tailnet:`, `tailnet-guest:`, `device:`, `link:`,
  `onboard`, `hook`), becomes `"anonymous"`. Every other label is kept: `cli`, `local`, `deck`,
  `capsule`, `mobile` or any made-up word.
- `asTaken()` is the only rewrite applied to every socket call. When the peer's ancestry
  (`core/daemon/peer.js` `insideClaude`) finds a `claude` process or one of vyred's thread
  processes above it, the label becomes `mcp` (or `mcp:thread:<id>`). A process that is not under
  a model keeps the label it sent.
- `above()` / `fromClaude()` run only for "personal" calls: PERSON_ONLY or HUMAN_ONLY tools, a
  tool whose presence rule applies to this input, any call carrying `x-vyre-presence`, and a
  `link.call` whose inner tool is PERSON_ONLY or HUMAN_ONLY. Those calls are refused when the
  ancestry is inside a model or can't be read. An ancestry that tops out at an unknown leader
  (tmux, iTerm2, sshd and similar) gets one presence proof per server (`serverTrusted`).
- The Capsule's own proof is `verifiedCapsule()`: the peer's cdhash (`codesign -dvvv +<pid>`,
  with the start time read before and after) compared with a pin stored in vyred's db by
  `presence.capsule.pin`. It is checked in one place only: inside `above()`, when the caller
  says `capsule` and the ancestry is unknown. For every other call a `capsule` label is accepted
  on its word.
- The Capsule sends `x-vyre-caller: capsule` on every request
  (`local/capsule/native/Sources/Vyred/VyredClient.swift`, `Stream.swift`). The CLI sends `cli`
  (`core/daemon/client.js`). No shipped surface sends `local`. Only a test remap does
  (`deck/test/vault-shots.js`).

### 1.2 What each label can reach

- `Registry.call` (`core/modules/index.js`) applies `callerAllowed(def.callers, caller)`. A tool
  with no `callers` list is open to every caller, `anonymous` included, and then decides for
  itself.
- `cli`, `local` and `capsule` have identical reach. They appear together in every owner list:
  `SURFACE_LABELS`, the memory module's `OWNER` / `OWNERS`, `projects.reach`'s owner set, `PEOPLE`
  in settings, planner, term, goals, mail, google, mcp, sight and suggest, and `core/link/mac.js`
  `PEOPLE`. Nothing in core tells `capsule` apart from `cli` except the pin check above.
- Almost every module runs on the local node: all of core (agents, files, gate, github, google,
  mail, mcp, memory, planner, presence, projects, recall, relay, sessions, switchboard, sync,
  team, term, vault and the rest) plus local/apps, capsule, hands-mac, screen-mac, sideview and
  voice.

### 1.3 Where the policy lives

- Presence sets in `core/presence/index.js`: `HUMAN_ONLY` (gate.approve, vault.put, reveal,
  copy, export and the rest of vault's secret paths, presence.enroll, remove, code and
  session.open, link.pair.approve, files.drive.share, network.guests.*, hooks.*,
  computers.*.set, projects.access.grant, learn.skill-install), `PERSON_ONLY` (threads.answer,
  term.open, term.attach, gate.revise, gate.reject, agents.create, agents.update,
  agents.resume, the team tools) and `SESSIONABLE`.
- Each tool's `callers` list, in its `ctx.tool` definition.
- `CALL_AS` in `core/modules/index.js`: which labels a core module may call under.
- The router's `Policy` (`core/daemon/index.js`): `{ caller, tool(name), path(method, path),
  peer }`. Module listeners (tailnet, onboarding, relay, thread sockets) set it when they hand a
  request to the one router. `policy.tool` returning false turns a tool into `no_such_tool`, and
  `/v1/tools` is filtered by it too. This is the kernel's existing way to narrow what a listener
  can reach. The socket itself sets no policy.
- `registryRules` (the floor's rules), applied to every call.

### 1.4 Relaying from the Mac to the box

- `link.call` (`core/link/mac.js`) has no `callers` list, so an `anonymous` socket client
  reaches it. It forwards any tool except `link.*` to the box.
- `ctx.remote()` is used by local modules to reach the box for their own work: planner
  (`core/planner/index.js:169`), files and drive (`core/files/index.js:121`, `:211`,
  `drive.js:511`) and sync (`core/sync/index.js`). Each call runs with the module's identity,
  whichever socket caller started it.
- `remote()` in mac.js attaches the Mac's person session (`authorization: Vyre <token>` plus a
  signature) to PERSON_ONLY and HUMAN_ONLY tools when `isPerson(caller)` is true, meaning any of
  `cli`, `local`, `capsule` or `deck` with no agent or thread in the label. HUMAN_ONLY tools also
  get a Secure Enclave signature, made after Touch ID. All other tools go out with no caller
  information.
- The box names every request from the Mac's tailnet node `tailnet:<login>`
  (`core/names/service.js` `callerOf`), which is the owner's device. The registry comment reads
  "the owner's device, and so is any script on it (ADR 0032)". Non-person tools open to `deck`
  (memory, recall, threads reads, files and the rest) therefore run with owner reach. PERSON_ONLY
  tools need the person session, and HUMAN_ONLY tools need the Secure Enclave signature.

### 1.5 What a same-uid process can already reach without the socket

These three matter for the decision in 2.6:

1. **The local stores.** `~/.vyre/vyre.db` (memory, threads, settings) and the transcripts under
   `~/.claude` are files owned by the user. Any process running as that user can read them.
2. **`link.json`.** `mac.js` writes the Mac's person session there (mode 0600, the same uid):
   `person.token` and `person.key`, the session's private key as a JWK (mac.js:490). Any process
   running as the user can read it and sign person-session requests.
3. **The tailnet.** Any process on the Mac can open a connection straight to the box's tailnet
   address. The box's whois returns the Mac's node, and the caller becomes `tailnet:<login>`, the
   same as the local node's own relayed calls.

So today a plain `nc -U` with no label can call `link.call {tool: "memory.ask"}` and reach the
box's memory with owner reach, and a `cli` label also gets the person session attached to
`threads.answer`. That is H1. Even with the socket closed, the same process can go through 2
and 3 without touching vyred.

## 2. Design

### 2.1 Who gets `capsule`

- vyred on the local node reads the Capsule's designated requirement (DR) from the bundle it
  runs from. It is never read from `~/.vyre` or from a caller's label. The CI signing job writes
  it next to the node, for example `Contents/Resources/capsule.requirement`, containing:
  `identifier "run.vyre.capsule" and anchor apple generic and certificate leaf = H"<sha1 of the pinned CI leaf>"`.
  The bundle is sealed by that same signature, so changing the file breaks the bundle's
  signature.
- A socket peer gets `capsule` only when `codesign --verify -R=<requirement> +<pid>` succeeds
  for the peer's pid. The start time is read before and after, the same way `verifiedCapsule`
  does now, and the result is cached once per connection. The label is never trusted. A peer
  that sends `capsule` and fails the check is treated like any other client.
- An ad hoc build has no certificate, so `certificate leaf = H"..."` can't match it. Neither can
  a Capsule built on this Mac and signed with the self-made "Vyre Local" identity, or any other
  binary. A node with no requirement file (a dev checkout, not a bundle) gives nobody `capsule`.
- This replaces the cdhash pin. `presence.capsule.pin` and `capsulePin()` can go once the bundle
  ships.
- Test seam: the check is a function injected like `peer.js`'s other seams
  (`{ requirement, verify(pid, req) }`). Tests never call real `codesign`.

### 2.2 Everyone else gets `local`

This applies on a device node, where `config.isDevice(cfg.machine)` is true and the machine isn't
a server. Solo is in question: see 2.6 Q3. For every socket call that isn't a verified Capsule:

- Model labels (`mcp`, `harness`, `mcp:agent:*`, and whatever `asTaken` produces) keep their own
  rules. They are already narrower, through agent keys and scope.
- Every other label (`cli`, `deck`, `mobile`, `capsule` that failed the check, `anonymous`, or no
  label) becomes the caller `local`, and the router applies a `Policy` whose `tool` predicate is
  `localReach` below. It uses the same mechanism module listeners already use: a refused tool is
  `no_such_tool`, and `/v1/tools` lists only what's reachable. Nothing new is added to the kernel.
- The label is rewritten before `Registry.call`, so every `callers` list and every module's owner
  check sees `local`, not a claimed `cli` or `capsule`.

### 2.3 The exact `local` reach

A tool is refused to `local` when any of these rules matches it, checked in this order:

1. PERSON_ONLY or HUMAN_ONLY (`core/presence/index.js`, the whole sets). These are never
   satisfied locally. `threads.answer` is in PERSON_ONLY.
2. Connector calls, meaning any tool that uses a connector's token or sends outward: `mcp.*`,
   `vault.*`, `github.*`, `google.*`, `mail.*`, `apps.send`.
3. Computer use, which would pass on the Capsule's Accessibility and Screen Recording grants:
   `hands.*`, `screen.*`, `sight.*`, `sideview.*`, `voice.*`, `capsule.*`.
4. The ways to hand out or change trust: `presence.*`, `relay.*`, `network.*`, `hooks.*`,
   `computers.*`, `names.*` writes, `link.pair*`, `link.signin`, `link.signout`, `link.unpair`,
   `settings.set*` for security settings, and `projects.access.*`.
5. Anything that reaches the box:
   - `link.call` and `link.remote`, unless the inner tool is on `LOCAL_RELAY`:
     `["onboard.status", "names.status", "recall.status", "network.tailscale.status", "agents.list", "push.devices", "relay.devices.list"]`.
     These are the status reads `vyre doctor`, `vyre phone` and `vyre assistant` use today.
     None of them returns memory, thread content or a secret.
   - `link.upload`, `link.macs.*`, `link.serve`, `link.reply` and `link.events`.
   - Any local tool that relays through `ctx.remote` for the caller (planner.*, and files.* or
     sync.* when they relay). `Registry.run` records the originating reach in an
     AsyncLocalStorage, and `ctx.remote` refuses a tool outside `LOCAL_RELAY` when the call it
     serves came from `local`. This is the one kernel change, made in `core/modules/index.js`,
     so no module has to track the caller itself.

Everything else on the node stays open to `local`: memory, recall, projects and threads reads of
the Mac's own data (the device's scope, the same data 1.5 item 1 already exposes), status,
tips, appearance, statusline, `link.status`, `link.health`, `threads.send` into the Mac's own
sessions, and so on.

### 2.4 Relayed calls keep their caller

- `remote()` sends the local node's verdict to the box as `x-vyre-reach: local|capsule`. The box
  must treat that header as a downgrade only. See 2.5 for why.
- The person session and the Secure Enclave signature are attached only for `capsule` reach.
  Today's `isPerson(caller)` in mac.js becomes `reach === "capsule"`.

### 2.5 Contract other teams must adopt

- **tailnet (core/link, core/names):**
  (a) `remote()` takes a reach, sends `x-vyre-reach`, and attaches person headers only for
  `capsule`.
  (b) On the box, a request from a paired Mac's node that says `x-vyre-reach: local` is labelled
  `local` there and gets the same `localReach` predicate, applied as the listener's
  `Policy.tool`. The header can only narrow a request. It never widens one.
  (c) `link.json` stops holding the person session's private key. See 2.6.
- **vault (core/presence, the floor):** PERSON_ONLY and HUMAN_ONLY are never met by a
  node-relayed call without the Capsule's own proof (2.6 A). `presence.capsule.pin` is retired in
  favour of the DR.
- **integrator / launch:** the bundle ships `capsule.requirement` with the pinned leaf hash, and
  the CI job fails if the file's hash doesn't match the certificate it signs with.

### 2.6 The open decision (why this stops here)

The rule as written ("only the Capsule gets capsule reach; every other socket client gets local")
can be enforced on the socket. The same process still gets the owner's reach through two doors
the node doesn't control (1.5 items 2 and 3):

- It reads `link.json` and signs its own person-session requests to the box.
- It connects to the box over the tailnet directly. The box names it `tailnet:<login>`, the
  owner's device, and ADR 0032 grants it owner reach for every non-person tool, cross-project
  memory included.

That leaves `x-vyre-reach` as advisory. A process that wants more reach can bypass the node,
because the box never sees the difference. Closing H1 needs a decision above this team:

- **A. The box requires the Capsule's own key (recommended).** Requests from a paired Mac's
  tailnet node get `local` reach on the box unless each request carries a signature from the
  Capsule's Secure Enclave key. C0 already enrolls that key on the box through pairing, and its
  keychain access is bound to the Capsule's DR, so only the CI-signed Capsule can use it. The
  person session's private key moves out of `link.json` into the same place. The node keeps no
  owner credential of its own. It forwards the Capsule's signed requests and marks everything
  else `local`. Cost: this amends ADR 0032 for Mac nodes (a script on the owner's Mac is no
  longer the owner's device), tailnet changes the names listener and mac.js, vault verifies the
  per-request Capsule signature, and capsule-pro signs box calls in Swift. The same box-side rule
  would then make sense for Windows (C1w) and for phones reaching the box directly over the
  tailnet. They carry a person session or a device key, so they are unaffected.
- **B. Close the socket only, and record the rest as accepted residual.** Build 2.1 to 2.4 as
  written. Then the node no longer adds reach of its own, and H1's "the node gives every local
  process the owner's reach" is technically fixed. The ADR 0032 stance, that any process on the
  owner's device is the owner for non-person tools, is written down as the accepted model for
  0.2. The person-session key in `link.json` still needs fixing either way, since it lets a
  non-model process fake a person action.

Two smaller questions that follow from either option:

- **Q2. The person's own CLI on a Mac becomes `local`.** The CLI can't prove its identity: it
  runs on the bundled node, and any script can too. `vyre answer`, `vyre phone remove`, `vyre
  assistant` (agents.create), `vyre connect` and box memory questions from the Mac's terminal
  would then refuse, pointing at the Capsule or the Deck. C1 says "every other caller". Please
  confirm this is intended.
- **Q3. Solo Macs.** A solo Mac has no box, so only rules 1 to 4 would apply. Rule 2 would stop
  the CLI from managing connectors on the only machine that has them. Recommended: apply the rule
  on `device` nodes only, and leave solo as it is today.

Once the lead picks A or B and answers Q2 and Q3, the build is:

1. The DR check in peer.js and the daemon, with tests using a fake verifier.
2. `localReach` as the socket's Policy, with tests including the `nc -U` case. A raw unix-socket
   client that isn't the Capsule is refused `memory.*` through `link.call`, `threads.answer` and
   `mcp.*`.
3. The AsyncLocalStorage reach check in `ctx.remote`.
4. The tailnet and vault contract items, handed to those teams.
