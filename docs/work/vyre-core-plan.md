# vyre-core build plan (ADR 0040), target 0.1.2

Owner: e2e2. Branch: work/vyre-core, off main. The design is ADR 0040 (signed off at 6a2b3f5f on
work/e2e-setsid). Each phase ships on its own, off by default until phase 4 installs it, and is
tested on Linux where it can be. "Mac check" marks what only a Mac run can confirm.

## Rules every phase keeps

- core trusts nothing vyred says: its own socket, its own peer (uid + pid + ancestry), its own
  proofs. vyred may proxy only reads open to any owner-uid caller.
- core never executes, loads or reads code from a person-writable path (ADR 0040 section 1). It
  imports only kernel code shipped in its own root-owned tree; no helper under ~/.vyre, no
  `$PATH` lookups, `/usr/bin/perl` by absolute path with an empty environment.
- core accepts only proofs it can check itself: capsule, device and passkey signatures, a
  one-time code minted by the installer, and sessions core itself opened. Never touchid (that is
  vyred trusting its own dialog helper) and never tty (a same-uid process can read the tty).
- The two build LOWs from the ADR sign-off:
  - (a) The person-side reader in the vault migration is the Capsule (root-owned, DR-signed), not
    the `vyre` CLI, whose code the person's uid can write. A model can stream its own value for
    an approved item name; the Capsule is the reader that a model can't replace.
  - (b) The root apply step is the ONLY reader of core's Capsule signing key in the _vyre data
    dir. core itself never reads it back after creating it.

## Phase 1: the daemon skeleton and presence (this branch)

- `core/vyre-core/`: an HTTP-over-unix-socket server with its own data dir and db.
- Every connection: the peer's uid and pid from the kernel (SO_PEERCRED on Linux; LOCAL_PEERCRED
  and LOCAL_PEERPID on macOS). A uid other than the owner's is refused before any route.
- Ancestry on core's OWN peer (`/v1/peer`): the same verdict vyred's socket gives today
  (core/daemon/peer.js), computed by core. Picks up the setsid exact-leader work when it lands.
- presence moved in: core's own presence tables. `presence.verify`, `presence.enroll`,
  `presence.keys`, `presence.remove`, `presence.session.open`, restricted to the methods above.
  The first key is enrolled with a one-time code only the installer (root) can mint, straight
  into core's db.
- Strict mode (default on darwin): refuse to start if core's code tree or data dir is owned by
  the owner's uid or is group/other-writable.
- `lib/vyre-core-client.js`: the small client vyred, the CLI and tests use.
- Tests (Linux, testbox): uid refusal (seamed), peer verdict, each accepted and refused method,
  one-time code bootstrap, strict-mode refusal, client round trip.
- Mac check: LOCAL_PEERCRED uid read, running as _vyre under launchd, socket reachable by the
  owner only.
- Not in phase 1: vyred routing its presence checks to core (phase 1b below).

## Phase 1b: vyred asks core

- On a Mac with core installed (core answers `/v1/hello`), vyred's presence verifies capsule,
  device and passkey proofs through core, and person-only tools go to core directly from the
  CLI/Capsule. vyred's own presence_keys are no longer read.
- Deck writes: a passkey assertion over a challenge core issued, or a core-minted session.

## Phase 2: the vault store and migration

- core's own vault store and key in its _vyre data dir. `vault.*` answered by core.
- The migration from ADR 0040 section 6: names-only list, erase ticked by default, a
  post-install proof, the Capsule as the person-side reader (LOW a), plaintext bound to the
  approval id, re-encrypted by core. Marker in core; vyred asks core "do you own the vault?";
  vyred's old store refuses writes after cutover.
- Mac check: the Capsule's keychain read and erase of the old key.

### Phase 2 design (for the lead and the reviewer, before building)

What the vault is today (mapped 28 Sep): about 16k lines, 99 tools. Its store and crypto core
(vault.js, crypto.js, keys.js, store.js, history.js, kinds.js, about 2.8k lines) takes only
`{ db, dir, config, emit, log }` and already runs standalone in tests. The rest sits on top:
import, fill, members/sharing, devices, relay, ssh, rotate, emergency, connections. Three things
tie it to vyred and need a decision:

1. **Secrets used by other modules.** Every module (mail, google, mcp, push, hooks, computers,
   gate, voice ...) gets secrets through `ctx.vault.fetch` -> `vault.release` as
   `module:<name>`, checked against its manifest's `needs.vault`. Those modules run in vyred,
   the person's uid. Whatever core releases to vyred, a model can read. There is no way around
   that while those modules live in vyred.
   - Recommendation: core releases an item to vyred only under a GRANT the person made with a
     core-checked proof (item x module), and the grant screen says plainly that a granted item is
     usable by Vyre's own modules on this Mac, and so readable by anything running as you. core
     never takes vyred's word that a grant exists: the grant row is core's. What core protects
     then is every item NOT granted to a module (the person's own logins, cards, keys), plus the
     record of who got what.
2. **The person's own Mac session.** The login keychain, the Secure Enclave key, the clipboard,
   typing into the front app, the screen-lock watcher and Touch ID all belong to the person's
   GUI session; `_vyre` can't use any of them.
   - Recommendation: core holds the data and the keys (its own vault key in its data dir, no
     keychain). The Capsule, core-signed and root-owned, is the person-side hand: it asks core for
     a value with a proof, gets plaintext over core's socket, and does the clipboard, typing and
     Touch ID itself. vyred's own clipboard and typing paths refuse on a core Mac.
3. **The features on top.** Moving 12k lines at once is a large, risky change.
   - Recommendation: 2a moves the store and crypto core, sessions and the tools the person uses
     every day: list, item, search, put, edit, delete, reveal, copy, totp, grant, revoke,
     approve, release, history. The others follow in slices (2b import and backup; 2c fill and
     the Capsule's autofill; 2d devices, relay, members and emergency; 2e ssh, rotate,
     connections). Until a slice moves, its tools on a core Mac answer core_owned ("not on this
     Mac yet"). The alternative, leaving them on vyred's old store, would keep the hole open.
   - DECIDED (lead, 28 Sep): 2a first, then slices. But no release turns vyre-core on for
     users until fill and import work there ("not on this Mac yet" for filling a password would
     feel broken). Devices, sharing, ssh and rotate may follow later with a plain message.
- DECIDED (lead) on 1 and 2 as recommended. The grant screen says: "this module runs as you, so
  anything you grant it is readable by programs running as you." 2a starts once the reviewer
  checks points 1 and 2.

Also for 2a:
- Sessions: core mints and checks presence sessions (core already has presence.session.open).
  Which tools take a session is core's own table (today's SESSIONABLE), never vyred's def.
- vyred keeps the vault tool NAMES as thin forwarders, so the CLI, Deck and modules keep calling
  the same tools. A write or reveal carries its proof through to core, and core checks it. A
  module's put of a NEW item is accepted with its provenance recorded as unverified; overwriting
  an existing item needs a proof.
- Events core emits (vault.item-added ...) are forwarded to vyred's event log as core's, marked
  as such.
- main.js pins PATH, so core finds git and tailscale only by absolute path, or not at all.
  Neither is in 2a.

## Phase 3: the gate send path

- gate moves whole: held drafts, revise/reject, approve/settle and the send credentials.
  `gate.route`/`gate.offer` delivery run from core.

## Phase 4: the installer and updater (with anywhere)

- `vyre up` on a Mac: one sudo, the _vyre account, the root-owned code tree, the data dir, both
  LaunchDaemons, core's Capsule signing key, the signed Capsule.app from the verified tarball,
  the one-time enrollment code.
- The signed release manifest (version + tarball hash), the version floor, the root apply step
  with hardened extraction, and signing the new Capsule.app (LOW b).
- Coordinate with anywhere (ADR 0039 install paths, machine roles). Mac check throughout.

## Phase 5: pairing and relay keys

- link pairing, the Mac's credentials toward the box, relay keys and the tailnet identity
  (names claim) move into core. Unblocks a phone joining a Solo Mac and relay on a Mac.
- A Mac server (ADR 0039): computers, spawner and dockerproxy tokens also move in (GA blockers).

## Status

- Phase 1 done on work/vyre-core: core/vyre-core/{server,peercred,strict,main}.js,
  lib/vyre-core-client.js, core/vyre-core/vyre-core.test.js. Testbox: vyre-core, boundaries, docs
  62/62, including a real SO_PEERCRED read; main.js smoke-tested (strict refuses a person-owned
  tree, `code` mints, `serve` answers /v1/hello).
- Known limits, by design for phase 1:
  - Sessions core opens can't be used yet: no core tool declares that it takes a session. Phase
    1b decides which do (the Deck's writes).
  - A device-bound passkey (a relay-paired browser) can't prove through core yet: core has no
    relay peer. Phase 5.
  - The Capsule's key on main is still Ed25519 until the p256 batch lands; core's tests use
    device keys (P-256).
  - The person verdict uses main's peer.js (inside-Claude + login terminal); it picks up the
    setsid exact-leader rule when that lands on main.
- Reviewer (9528c1ee signed off as dormant) MEDIUMs, fixed in the next sha: the socket lives in
  /var/run/vyre/ (root-made, _vyre's, 0755; strict checks it) and the client sends a proof only
  to a socket owned by core's uid in a folder others can't write (socketProblem); core reads its
  own process table (procs.js: /proc, or /bin/ps with an empty env), never tmux, and main.js
  pins PATH and drops every VYRE_* but its four.
- Reviewer LOWs, carried:
  - presence.verify spends the proof it checks (a nonce or a code), like any use of it. Only a
    holder of a valid proof can burn it, and that holder could use it instead; vyred's 1b use
    treats a verify as the proof's one use.
  - LOCAL_PEERPID can be reused before core judges the pid: switch to the audit token (Mac) when
    1b makes the verdict load-bearing.
  - The installer runs `main.js code` as _vyre (sudo -u _vyre), or core.db ends up root-owned.
  - A live tty value from a real terminal on a Mac is still owed before /v1/peer gates anything.
  - When this branch takes the P-256 batch: core's first enroll must refuse a non-P-256
    Capsule key, and core's migrations must carry the alg -7 trigger (6579710a/457ef10c).
- Mac check still needed: LOCAL_PEERCRED's uid read (xucred layout) and /bin/ps, by capsule-pro
  with a temp home and no sudo. Running as _vyre under launchd waits for phase 4 (a real system
  user on the user's Mac needs their explicit OK).
- Phase 1b (vyred asks core) done: a root-owned core.json (root's file in a root folder, never
  the environment) turns on core.link in vyred's daemon, on darwin only. Every Presence then
  checks capsule, device, passkey and code proofs through core (the socket checked as core's
  before a proof is sent), takes the method list and presence.keys from core, gets passkey
  challenges from core, and refuses enroll, remove and presence.code (core_owned). A key planted
  in vyred's own presence_keys proves nothing. A core that's down refuses; nothing falls back.
  Testbox: 99/99 (vyre-core, presence, boundaries, presence-bypass, daemon).
- **What 1b closes and what it doesn't.** 1b closes the KEY plant: a key a model inserts into
  vyred's presence_keys proves nothing. It does NOT close the SESSION plant: presence_sessions
  still lives in vyred's same-uid db, and method session serves SESSIONABLE tools (vault.reveal,
  gate.approve). A model that inserts a session row with a secret whose hash it knows passes
  those tools today. Nor does it close the Touch ID helper under ~/.vyre/helpers, which only
  vyred's own JS hash-checks: a model can replace it with one that always says yes. Phase 2
  moves sessions into core with the vault (and phase 3 with the gate); the touchid method on a
  core-linked Mac goes with them, since core never takes it. Until then, on a Mac these are
  advisory, like every vyred-side control (ADR 0040 section 3).
- Next, phase 1c: the person's clients write to core directly. The contract (sent to capsule-pro):
  - The Capsule reads core.json itself (the same trust rule as readCoreConfig) and talks to
    core's socket only after the same socketProblem check. With no core.json it keeps talking
    to vyred exactly as today.
  - First key (lead's decision and the reviewer's rule, 28 Sep). The first key is the whole
    root, so:
    - The installer (running from core's root-owned tree under the install's sudo, never the
      person's own `vyre` CLI code) mints the code into core's db as _vyre: `main.js code`,
      6 characters, 2 minutes, single use. It is NOT printed on this path.
    - It launches the Capsule by exec'ing the binary inside the core-signed .app in the root-owned
      tree (not `open`: LaunchServices drops inherited descriptors), with the code on an
      INHERITED file descriptor. Never argv, never env (`launchArgs --env` is out: a same-uid
      process can read another's environment), never a file.
    - The descriptor (agreed with capsule-pro): fd 3, exactly the 6 ASCII bytes, then the
      installer closes its write end (EOF). No newline, no length prefix. The Capsule reads with
      a short timeout; anything but exactly 6 valid characters, or fd 3 closed, is a failed
      handoff.
    - The launch step drops to the person's own uid before it execs the Capsule: the Capsule
      never runs as root.
    - The Capsule sends POST /v1/tools/presence.enroll {kind:"capsule", name, public_key,
      alg:-7} with x-vyre-presence `code code=<code>`, then shows the enrolled key's
      fingerprint.
    - Fallback only if the handoff actually failed: then, and only then, `main.js code --typed`
      (6 characters, 10 minutes, single use) is shown in the terminal and typed into the
      Capsule's "Type the 6-character code shown in your terminal". A model that reads it from
      the terminal still can't use it (next rule). Not "the Capsule shows it and the terminal
      confirms": a model can inject terminal input (osascript keystrokes, tmux send-keys).
    - core redeems a code only (built in 51679e47's successor):
      - from a peer whose executable is the Capsule core itself signed, for BOTH paths: core
        runs `/usr/bin/codesign -R <core's DR>` on LOCAL_PEERPID's executable, with env {}, and
        then either uses the audit token or re-checks the pid's start time after the codesign
        call (pid reuse). Until phase 4 provides that identity, a Mac core refuses every code
        (`codeFrom` defaults to no);
      - while core has no key at all; after the first enroll, no code enrolls anything;
      - for kind capsule only;
      - through presence.enroll only (presence.verify refuses a code, so nothing else spends
        one), with the code spent in the same transaction as the enroll: it burns on the first
        SUCCESSFUL enroll, a failed enroll leaves it, and two racing redeems can't both win;
      - and five wrong codes void every open one.
    - The Capsule's hardened runtime with no get-task-allow (phase 4's signing step) keeps a
      same-user process from attaching and reading the code from its memory.
    Every later key is enrolled with a proof from an already-enrolled key (`capsule key=... ts
    nonce sig` over that exact input).
  - Removing a key (its own old key after re-enroll, or one the person picks):
    presence.remove {id} with a capsule proof.
  - A proof for a tool that stays in vyred is still sent to vyred as today; vyred asks core.
  - The CLI holds no key core knows, so `vyre presence keys` reads through vyred (core's list),
    and enroll and remove in a terminal say to use the Capsule (vyred's core_owned message).
  Then phase 2.
