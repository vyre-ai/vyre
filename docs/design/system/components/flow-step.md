---
title: Flow step
summary: The one page of a guided flow: Back, step strip, title, body, a failure, one primary action.
audience: builders
owner: app-design
status: draft
---

# Flow step

The page every screen of setup, Create a space, Join a space and Invite people is drawn on, so a flow feels like one thing. Prototype drawn at `/onboard` in the mock build.

| Surface | Implementing file | Status |
|---|---|---|
| App | `apps/app/ui/components/FlowStep.tsx` (@vyre/ui) | built |
| Deck | not used | not used |
| Lumen | not used | not used |

## Anatomy

1. **Back**: a ghost small button with the back icon, top left. Left out on the first screen of a flow.
2. **Step strip**: "Step 2 of 6" in the caption role, then the [stepper](stepper-checks.md) bars (`StageSteps` strip form: done, current, to come, with the current step's name once). Left out when the screen is not a step.
3. **Title** in the page role, one **lead** line under it in the muted tone.
4. **Body**: a column with the space-4 gap. Whatever the screen needs, from library components.
5. **Failure**: an error [banner](banner.md) above the actions. It says what went wrong in words and what to do next. Never blames the person.
6. **Actions**: one primary, full width, large. At most one quiet alternative under it (ghost, full width).

The page scrolls, and the column stops at the reading width and sits in the middle on a wide window.

## States

| State | Look |
|---|---|
| Normal | as above |
| Disabled primary | the primary is dimmed until the screen has what it needs; the lead says what is missing |
| Failure | the banner appears; the primary becomes the way forward ("Try again", "Ask again") or stays; the quiet alternative offers the second way |
| Loading | the primary shows its busy state and keeps its width |

## Props

`steps { labels, current }`, `title`, `lead`, `failure`, `onBack`, `primary { label, onPress, disabled, loading }`, `secondary` (same), `children`.

## Accessibility

The step line has an accessible label "Step 2 of 6, Master password". The title is a heading. The failure banner is an alert. Back is a button with a name.

## Copy

Sentence case. A button is a verb ("Reserve this name", "Set master password"). Every failure names the next step. No em dashes.

## Gaps

- [ ] The strip does not yet scroll its labels on a very narrow phone with six steps.

