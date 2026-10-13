---
title: Code field
summary: A field for a code typed or pasted: capitals, hyphens put in as you type, a fixed first word.
audience: builders
owner: app-design
status: draft
---

# Code field

A [form field](form-controls.md) for a short code: a space code (WINK-4F7K-9QZ2), a recovery code, an invite code. Typing follows [Authenticator code](otp.md): case, spaces and hyphens are ignored, so a pasted code works however it was written.

| Surface | Implementing file | Status |
|---|---|---|
| App | `apps/app/ui/components/CodeField.tsx`, `ui/lib/code.js` (@vyre/ui) | built |

## Behaviour

- Shows capitals in the mono face, puts the hyphens in at the group ends, and keeps `prefix` (for example WINK) in place from the first key.
- A pasted prefix is not doubled. Alphabet is letters and digits.
- `groups` is the length of each group after the prefix: `[4, 4]` for WINK-XXXX-XXXX.
- The placeholder is the shape (WINK-XXXX-XXXX). `error` names what is wrong and what to do; `help` is one line.
- The value the screen holds is the formatted text; `codeComplete` says when every group is full.

## Copy

"That code is not from a space that is waiting. Run vyre space up on your server for a fresh one, then type it here."

## Gaps

- [ ] No paste-from-clipboard button.

