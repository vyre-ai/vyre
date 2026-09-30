---
title: Vyre design system
summary: Design A v1, frozen 27 Sep 2026. Tokens, 47 component specs, layout and navigation, copy rules and the render audit, for the Deck, the app and the Capsule.
audience: builders
owner: app-design
status: draft
---

# Vyre design system

Design A v1, frozen 27 Sep 2026. This folder is the design system of record: the Deck (pwa, chat,
native-core), the app (mobile) and the Capsule (capsule-pro) build from it with no guessing.

Where this folder and the canvas disagree, this folder wins. Where it is silent, the canvas
(https://claude.ai/artifact/CKLkX4pcZpsyiKYDEnXKWr) is the reference, and the gap is a bug in this
folder: tell app-design. Where the code disagrees with this folder, the code is wrong, unless the
spec says "(proposed)".

- [Tokens](tokens.md): the one JSON, what each surface generates from it, and the theme rules.
- [Layout and navigation](layout.md): breakpoints, the three shapes, the rail, the phone shell,
  the Capsule.
- [Copy](copy.md): voice, words we use and never use, formats.
- [The render audit](audit.md): the check every board and every change to it passes.
- [The Capsule, redesigned](capsule.md): the Design A Capsule, keyboard first, with Vyre IQ,
  voice and computer use.
- [Spec lists by team](teams.md): every open gap, sorted by the team that closes it.
- The component specs below, one file each: anatomy, variants, sizes, states, keyboard and touch,
  motion, copy, accessibility, the implementing file on each surface, and its gaps.

The direction behind it is in [DIRECTION.md](../one-app/DIRECTION.md); the phone brief is
[one-app/README.md](../one-app/README.md).

## Changing v1

v1 is frozen. A change goes through app-design. The spec is updated first, then the board, the
tokens (`npm run tokens`) and the audit, then the code. A change that only one surface needs is not
a change to the system: it stays in that surface and is listed in the spec under Gaps as an
accepted difference.

## Components and status

47 components in seven groups. Status is per surface, against these specs, surveyed 27 Sep 2026 on
main and the teams' branches (each spec names the branch): built matches the spec, partial exists
but differs (the spec lists how under Gaps), not built has no code yet, not used means the surface
does not have it by design.

### Foundations

| Component | Deck | App | Capsule |
|---|---|---|---|
| [Icons](components/icons.md) | partial | not built | not built |
| [Status mark](components/status-mark.md) | partial | partial | partial |
| [Avatar](components/avatar.md) | partial | partial | not built |

### Controls

| Component | Deck | App | Capsule |
|---|---|---|---|
| [Button](components/button.md) | partial | partial | partial |
| [Icon button](components/icon-button.md) | built | not built | partial |
| [Key hint](components/key-hint.md) | partial | not built | partial |
| [Chip](components/chip.md) | partial | partial | partial |
| [Mode chip](components/mode-chip.md) | partial | partial | not built |
| [Form controls](components/form-controls.md) | partial | partial | partial |
| [Tabs](components/tabs.md) | partial | not built | not used |

### Containers

| Component | Deck | App | Capsule |
|---|---|---|---|
| [Card](components/card.md) | partial | partial | partial |
| [List](components/list.md) | partial | partial | partial |
| [Sheet](components/sheet.md) | built | not built | not used |
| [Popover](components/popover.md) | built | not built | partial |
| [Banner](components/banner.md) | partial | partial | partial |
| [Pill](components/pill.md) | partial | partial | partial |
| [Toast](components/toast.md) | partial | built | not built |

### Rows

| Component | Deck | App | Capsule |
|---|---|---|---|
| [Needs row](components/needs-row.md) | built | partial | partial |
| [List row](components/list-row.md) | partial | partial | partial |
| [Settings row](components/settings-row.md) | built | not built | not used |
| [Device row](components/device-row.md) | partial | partial | not used |

### Session and chat

| Component | Deck | App | Capsule |
|---|---|---|---|
| [Turn](components/turn.md) | partial | partial | partial |
| [Tool row](components/tool-row.md) | partial | partial | partial |
| [Diff](components/diff.md) | partial | not built | not built |
| [Ask card](components/ask-card.md) | partial | partial | partial |
| [Question card](components/question-card.md) | partial | not built | not built |
| [Plan card](components/plan-card.md) | not built | not built | not built |
| [Draft card](components/draft-card.md) | partial | partial | partial |
| [Composer](components/composer.md) | partial | partial | partial |
| [Terminal](components/terminal.md) | partial | not built | not used |
| [Presence line](components/presence-line.md) | partial | not built | partial |

### Places and surfaces

| Component | Deck | App | Capsule |
|---|---|---|---|
| [Rail](components/rail.md) | partial | not built | not used |
| [Top bar](components/top-bar.md) | partial | not built | not used |
| [Command bar](components/command-bar.md) | partial | not built | not used |
| [Phone shell](components/phone-shell.md) | partial | partial | not used |
| [Capsule on the Mac](components/capsule-mac.md) | not used | not used | partial |
| [Glass frame](components/glass-frame.md) | partial | not built | not used |
| [Authenticator code](components/otp.md) | partial | not built | not built |
| [Agenda](components/agenda.md) | partial | not built | partial |
| [Stepper and checks](components/stepper-checks.md) | partial | not built | not used |
| [States](components/states.md) | partial | partial | partial |

### Shared pieces

The parts every surface draws from one shared answer on the box (ADR 0036).

| Component | Deck | App | Capsule |
|---|---|---|---|
| [Suggestions](components/suggestions.md) | partial | not built | partial |
| [Account picker row](components/account-row.md) | not built | not built | not built |
| [Credential sheet](components/credential-sheet.md) | not built | not built | not built |
| [Command result card](components/result-card.md) | not built | not built | not built |
| [Tip](components/tip.md) | not built | not built | not built |
| [Glass mini-view](components/glass-mini.md) | not built | not built | not built |

| Surface | Built | Partial | Not built | Not used |
|---|---|---|---|---|
| Deck | 5 | 35 | 6 | 1 |
| App | 1 | 20 | 25 | 1 |
| Capsule | 0 | 23 | 13 | 11 |

Every spec's Gaps section is a checklist. When a surface closes one, tick it in the same commit.
