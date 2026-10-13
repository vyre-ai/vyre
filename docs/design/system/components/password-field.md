---
title: Password field
summary: A password input with Show and Hide and an optional four step strength meter.
audience: builders
owner: app-design
status: draft
---

# Password field

For the master password, a space's master password and any new password. Built on the [field](form-controls.md).

| Surface | Implementing file | Status |
|---|---|---|
| App | `apps/app/ui/components/PasswordField.tsx`, `ui/lib/strength.js` (@vyre/ui) | built |

## Anatomy

Field with the label above, then a row: with `meter`, four segments (edge, then error, warning, accent and ok by level) and the level in words ("Fair"), then Show or Hide at the right. The advice line under the field replaces the help ("Use at least 8 characters."). `error` replaces the advice.

## Levels

Weak (1), Fair (2), Good (3), Strong (4), from length first, then variety, then common words. The screen asks for Good before it goes on. A longer phrase of four words reads as Strong.

## States

Empty (no bar, no advice), typing (the bar and one line of advice), error (the error in the err tone, the bar stays), revealed (Hide).

## Accessibility

The bar is a progress bar with the level in its label. Colour is never the only signal: the word is beside it.

## Gaps

- [ ] No "Vyre cannot reset this" inline confirmation tick.

