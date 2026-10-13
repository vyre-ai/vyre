---
title: Match words
summary: The words two devices both show so a person can see they are talking to each other.
audience: builders
owner: app-design
status: draft
---

# Match words

Three words for a sign-in, four for a space. Both screens show them; the person checks they are the same, in order. Promoted from the Wink add-a-device flow.

| Surface | Implementing file | Status |
|---|---|---|
| App | `apps/app/ui/components/MatchWords.tsx` (@vyre/ui) | built |

## Anatomy

An optional label, one tile per word (headline role, strong, surface-3, a hairline, radius field), wrapping if needed, then one muted line ("Check them against the words on your server"). The accessible label numbers the words, so they are not read as one phrase.

## Copy

"If the words differ, tap Deny on the other device." A mismatch always shows the failure banner and a way back: "The words do not match, so this is not your server. Do not go on."

## Gaps

- [ ] No large form for reading aloud across a room.

