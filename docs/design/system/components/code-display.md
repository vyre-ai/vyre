---
title: Code display
summary: A code to read or copy: label, the code in mono at the title size, Copy, one line under it.
audience: builders
owner: app-design
status: draft
---

# Code display

The code a person reads out or copies: the sign-in code of a new device, the recovery code and secret key of a recovery kit, the invite code. Same style as the pairing code in [Authenticator code](otp.md) (mono, groups joined by a hyphen, never wrapping), without the ring.

| Surface | Implementing file | Status |
|---|---|---|
| App | `apps/app/ui/components/CodeDisplay.tsx` (@vyre/ui) | built |

## Anatomy

A surface-3 box with a hairline: label (caption, strong, label tone), the code (mono, title role, selectable) with a secondary small Copy button beside it, and one muted line (how long it lasts, who to keep it from). Copy turns to "Copied" for 1.5 s. The accessible label reads the code character by character.

## Gaps

- [ ] The clipboard does not clear itself after 30 s (see Authenticator code).

