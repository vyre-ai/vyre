---
title: "ADR 0038: Terminology, server and devices"
summary: "Box" is retired from every user-facing surface. The Linux machine that runs Vyre's core is the server; a Mac, Windows PC or phone that pairs with it is a device, never a standalone core.
audience: builders, agents
owner: docs
status: draft
---

# ADR 0038: Terminology, server and devices

## Context

Vyre's docs, CLI, UI and code have used "box" for two different things at once: the Linux
machine running vyred (`vyre box add`, `vyre box update`, the box image, "your box"), and,
inconsistently, a Mac running its own local core (`role: "local"`, described in places as "a Mac
acting as its own box"). New users read "box" and picture a physical appliance, not a server they
already own or rent. The word also collides with unrelated senses elsewhere in the docs (a
Capsule's message box, a text box in a form).

The user decided the words on 2026-09-28: **server** for the Linux machine, **device** for
everything that pairs with it. A Mac or PC's local modules (Capsule, screen, hands, voice) run in
the device role and pair with a server; a Mac no longer runs as a standalone core. This closes the
"local" role rather than renaming it.

## Decision

### The words

- **Server**: the Linux machine that runs Vyre's core (vyred, the daemon, the tools registry,
  storage). Linux only. In user-facing text: "your Vyre server", never "your box" or "the box".
  A fresh one is "a server", the one you're paired to is "your server".
- **Device**: a Mac, Windows PC or phone that pairs with a server. Its local modules (Capsule,
  screen and hands, voice, the CLI) run in the device role; it is not a core of its own. Use
  "device" in all user-facing text. "Client" is allowed only in technical docs (architecture,
  API references, ADRs) where "device" would be ambiguous against a network client.
- Internal code may keep "the box image" for the Docker image name and similar
  implementation-only labels until a team renames them; this ADR governs user-facing words, not
  every internal identifier.

### What's out of scope here

Whether a Mac can still run a standalone core is a product decision, not a naming one: this ADR
records that the answer is no (closing `role: "local"`'s use case) but leaves any code change to
the owning team (native-core / cohesion), tracked under Migration below.

### Migration (one release, 0.1.1)

- **CLI (decided, 2026-09-28)**: `vyre box` becomes `vyre server`. `vyre box <sub>` (`add`,
  `status`, `update`, `backup`, `move`, `remove`) stays as an alias for one release (0.1.1): it
  runs the same code and prints one line ("vyre box is now vyre server") to stderr, not stdout, so
  scripts parsing stdout are unaffected. Help text, `--help` and generated docs show `vyre server`
  from 0.1.1. Remove the alias in 0.1.2 at the earliest, and only after a deprecation window the
  lead signs off on.
- **Config**: `role` keeps reading `"box"` and `"local"` from existing config files (no forced
  migration, no data loss on upgrade). New config written by `vyre up`/onboarding writes `"box"`
  still for now, since the role rename (`"box"` -> `"server"`, and whatever replaces `"local"`)
  is a platform/native-core change, not a docs one, tracked under Needs below. This ADR's
  migration guarantee is: whatever role names the code ends up with, old config values keep
  working for at least one release.
- **User-facing strings**: every doc, CLI message, UI label, error and onboarding screen that
  says "box" (or treats a Mac as a server) moves to "server"/"device" in 0.1.1, except pages
  already merged into the rc.2 release train, which docs leaves alone per the lead's instruction.
- **Docs enforcement (revised, 2026-09-28, so this doesn't turn every team's suite red the moment
  it merges)**: `docs-check` holds every published page to a bare "box" (case-insensitive,
  word-boundary; not inline code, a link/image target, an HTML tag's attributes, or a fenced
  example, all of which reproduce a literal value rather than describe it in prose), with a
  standing allowlist for `vyre box`, `box image` and message/text/dialog box. Docs-owned pages and
  any page a team has already swept fail hard on a hit ("terminology"). Every other published page
  is named in `TERMINOLOGY_PENDING` (`scripts/lib/docs/check.js`) and gets a warning
  ("terminology-pending") that is printed but does not fail the build, the same way a stale
  screenshot doesn't. The list only shrinks: a team removes its page when it sweeps it, and any
  "box" that reappears there afterward fails for real. ADRs and CHANGELOG.md stay exempt outright
  (historical record); generated `docs/reference/*.md` pages are exempt too (edit the code, then
  `npm run docs:ref`).
- **Glossary**: `docs/reference/glossary.md` is the canonical page; every other doc that defines
  "server" or "device" inline links there instead of redefining it.

## Consequences

- One release of dual vocabulary in the CLI and config is expected and is not a bug; `docs-check`
  encodes the exceptions rather than leaving them to memory.
- Every team owning a user-facing "box" string does its own rename in 0.1.1 (list attached to
  this ADR's rollout in `docs/work/docs.md`); docs does not rename code it doesn't own.
- marketing (vyre.run, README, social) adopts the same words immediately, no alias window: a
  fresh visitor has never read "box" and gets no deprecation notice.

## Status

Draft. Words, the CLI alias and the docs-check design are decided (the user and the lead,
2026-09-28). Landed: the words, the glossary, docs-check's terminology rule, and docs's own 0.1.1
sweep (`docs/work/docs.md`). Open: the per-team code and per-page docs sweeps
(`docs/work/terminology-inventory-0038.md`), and the `vyre box` -> `vyre server` CLI rename
itself (integrator).
