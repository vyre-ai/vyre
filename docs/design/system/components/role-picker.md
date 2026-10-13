---
title: Role picker
summary: The list a person chooses a role from when inviting someone, each role with one sentence of what it can see, then optional projects and, for Guest, an end date.
audience: builders
owner: app-design
status: draft
---

# Role picker

The one place a role is chosen: the invite step (onboarding and Settings) and the people list.
Built-in roles (Admin, Member, Guest) and the space's custom roles sit in one list, so a custom
role is as easy to give as a built-in one. Owner is never in the list. Drawn from
`team/0.3.4/ROLES-proposal.html` section 5.

| Surface | Implementing file | Status |
|---|---|---|
| App | `apps/app/ui/components/RolePicker.tsx`, exported from `@vyre/ui` | built |
| Deck, Lumen | not used | |

## Anatomy

1. **Role list.** One flush card of dense rows (56). Title is the role's name (medium); the line
   under it is one sentence of what the role can see ("The projects they are on. Edits Clients.
   Mail and calendar on."). The chosen row sits on `--selected` and shows a 18 check at the end,
   so colour is never the only signal. The card is a radio group; each row's accessible name is
   the name and the sentence.
2. **Projects (optional).** Section label "Projects" with the quiet meta "Optional", then filter
   chips that toggle (see the chip spec). A line under them says what none chosen means: "None
   chosen: they join with the role's own reach." With some chosen: "They are added to these
   projects when they join." Under the chips, one control row per chosen project asks the seat:
   Lead, Contributor or Viewer, Contributor by default (a seat only narrows what the role allows).
3. **Access ends.** Only while the guest role is chosen: the segmented control of end dates
   (1 week, 30 days, 3 months). Hidden for every other role.

## States

- **Default.** The first offered role is chosen; nothing is chosen under Projects.
- **Chosen.** Row on `--selected`, check shown. Choosing another role moves both.
- **Guest.** The end-date control appears, with the previous choice kept if the person flips back
  and forth.
- **No projects in the space.** The Projects block is not drawn.
- **Nothing to offer.** The caller shows an empty state ("Only an owner or admin invites"); the
  picker is not drawn with no rows.

## Keyboard and touch

Arrow keys move the chosen role in the radio group; Space or Enter chooses. Rows are 56 high on
every size; chips are 24 (26 on a phone) and sit in a wrapping row with the segmented control
under them.

## Motion

The check and the end-date control fade with `--motion-tap`. Nothing changes height above the
fold except the end-date block appearing under the list.

## Copy

"Projects", never "matters". Role names are the owner's own words for custom roles. The line
under a role is one sentence, no trailing list longer than three.

## Gaps

- [ ] A custom end date (a calendar) beyond the three presets.
- [ ] Arrow-key movement is not wired on the web build.
