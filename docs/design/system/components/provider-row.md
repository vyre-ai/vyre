---
title: Provider row
summary: One AI account in a list: mark, name, one sentence, and a button that follows the state.
audience: builders
owner: app-design
status: draft
---

# Provider row

A row in "Connect your AI" and later in Settings, AI accounts. Built on the [list row](list-row.md) in its dense form, so it sits in a flush card with dividers.

| Surface | Implementing file | Status |
|---|---|---|
| App | `apps/app/ui/components/ProviderRow.tsx` (@vyre/ui) | built |

## States

| State | End of the row |
|---|---|
| idle | primary small button "Sign in" (or "Add a key") |
| working | the same button, busy, "Signing in" |
| connected | a "Signed in" chip and a ghost "Test" that runs one tiny prompt |
| failed | the sentence becomes what went wrong; the button is "Try again" |

The mark is the provider's own (`ProviderBadge`, 32) or an icon tile for an API key.

## Copy

Each sentence says how: "Sign in with your Claude subscription." A failure names the next step in the banner above the list: "Check that you are signed in to it in your browser, then try again, or add an API key instead."

## Gaps

- [ ] The Test result shows in a toast; a row-level result line is not drawn yet.

