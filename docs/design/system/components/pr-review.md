---
title: PR review card
summary: A pull request's summary, checks, files (diff.md's multi-file variant) and review comments, with Approve and merge from the session.
audience: builders
owner: app-design
status: draft
---

# PR review card

An agent opened, or is asking you to review, a pull request. The card is the one place a PR is
read and acted on from chat - summary, CI status, the diff, and any review comments - so approving
and merging never needs a tab switch to GitHub. New 30 Sep, the user's chat-components ask, built
with github's hosted-MCP work (`plans/github.md`).

| Surface | Implementing file | Status |
|---|---|---|
| Deck | none | not built |
| App | none | not built |
| Lumen | none (compact form only, see Variants) | not built |

## Anatomy

A neutral card: `--panel`, 1 px `--rule`, radius `--radius-card` (12; phone 10).

1. **Header**, 44 tall, padding 0 16: the repo's icon (16, `--text-2`), title
   `#412 Add renewal reminder job` (base 600, `--text`), right the branch pair in mono 12
   `--label` (`feature/renewal-job → main`).
2. **Summary**, base, `--text-2`, padding 0 16 12: the PR's own description, 3 lines then "Show
   more" (ghost steplink).
3. **Checks row**, padding 0 16 12, gap 8, wraps: one chip per check (chip.md's Tag shape, not a
   button): a status mark (status-mark.md - running ring, done hollow-dot, failed crossed-circle)
   plus the check's name ("build", "tests", "lint"). A failed check's chip is tappable and opens
   its log line inline (mono 12 on `--code-bg`), collapsed by default.
4. **Files**, `diff.md`'s Multi-file variant, inside the card with its own scroll capped at 400px
   tall on the desktop (the phone doesn't cap - it scrolls with the page).
5. **Review comments**, one row per comment, padding 10 16, 1 px `--rule` top: the commenter's
   avatar (avatar.md, 20), the comment text (base, `--text`), the file/line it's anchored to in
   mono 12 `--label` ("src/jobs/renewal.ts:42"), and a Reply steplink. A comment left by a
   collaborator (not the person, not an agent) is drawn as-is; see Accessibility for how untrusted
   text is handled.
6. **Footer**, padding 12 16, 1 px `--rule` top, gap 8: **Approve and merge** `⌘⏎` (primary, held
   until every required check is done - disabled with a tooltip "Waiting on checks" while any is
   running), **Request changes** (outline, opens a single-line field for the note), **Comment**
   (ghost).

## Variants

- **Desktop** (above).
- **Phone**: checks row scrolls sideways; files list is always the multi-file diff's collapsed
  state (no default-expand-first-file, since the phone screen is precious); footer buttons stack,
  Approve and merge 54 full width, then Request changes and Comment at 44 side by side.
- **Lumen (compact)**: header plus the checks row only, no diff, no comments: title, branch
  pair, check chips. "Open in the Deck" (ghost) is the only action; approving a PR is a desktop/
  phone action, not a Lumen one, the same call `capsule.md`'s panel/rows/footer shell already
  makes for anything wider than a quick glance.
- **Merged / Closed**: the footer collapses to one line, check glyph or x, "Merged into main by
  you · 2 min ago" or "Closed, not merged".

## Sizes

Buttons 32 desktop, 54/44 phone, per button.md. Check chips 24 tall. Comment avatar 20
(avatar.md's smallest size, extended down from the documented 20/24/32/40 scale for this one
dense row - flagged as a genuine new size, not a silent addition; confirm with cohesion-2 before
lock if this needs its own scale entry).

## States

- **Open, checks running**: Approve and merge disabled, tooltip as above.
- **Open, checks done, all green**: Approve and merge enabled.
- **Open, a check failed**: the failed chip's status mark leads; Approve and merge stays enabled
  (a failed check doesn't block a person's own judgment call) but reads "Approve and merge anyway"
  once at least one check has failed, so the exception is visible in the label itself.
- **Busy**: Approve and merge keeps its width, spinner, "Merging".
- **Merged / Closed**: see Variants.
- **Error**: the merge failed (conflict, branch protection) - one line under the footer in
  `--text` with the failed mark, plain words ("main moved - rebase first" or GitHub's own reason,
  never raw JSON), Retry (ghost).
- **Offline**: Approve and merge queues to the outbox; "Approving · sends when back online".

## Emission (agreed with sessions, native-core, github; see the contract in
`team/0.2/plans/app-design.md` section 10)

Not an "ask" (nothing blocks the agent waiting on it) - it's a `renderer:<tool>` slot result
(ADR 0033), emitted by github's `pr.open`/`pr.status` tools with `render: {kind: "pr_review", pr,
title, branch: {from, to}, summary, checks: [...], files: [...diff hunks...], comments: [...]}`.
github's proposed session.push tool (not yet built) and its own refusal rules (force-push, non-fast-forward - `plans/github.md`
section 3) apply before this card ever renders a merge as available.

## What the person's actions do

Approve and merge calls `pr.merge` (github's tool, `outward: none` - a merge is not a send/post/
pay/delete per the Gate's classification, since it acts on the person's own connected repo, not
outward to a stranger; confirm with vault this reading is right before build). Request changes
and Comment call `pr.review` with the respective GitHub review event. None of these need Touch ID
under "asking is approving" - the person is reading real CI output and a real diff before acting,
which is exactly the informed-approval case the Gate's proof requirement exists to protect against
skipping.

## What agents can do for the person

An agent may open a PR, push commits to it, and re-request review on its own (github's proposed
pr.open and session.push tools); it may never approve or merge its own or another PR - that action has
no agent-initiated path in this card by design, matching the "no self-approval" expectation
built into every other approval flow in this system.

## Accessibility

- The card is a `section` labelled by the PR title and number.
- Review comments from a collaborator are marked as such (a Tag, "Collaborator" or the org
  membership github already resolves) and are always collapsed by default unless they anchor to
  a file/line the diff is already showing open - untrusted text from outside the person's own
  agents never auto-expands into view (same principle github's plan applies to issues/PR text
  generally, M9 in that team's review response).
- Check chips carry their status word, never colour alone.

## Gaps

Everything - this is a new component, no surface has built it. Sequencing depends on github's
hosted-MCP `pr.status`/checks shape landing first (their plan, build step tracked there).
