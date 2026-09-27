---
title: Copy
summary: How Vyre's screens talk: voice, the words we use and never use, names, times and counts.
audience: builders
owner: app-design
status: draft
---

# Copy

## Voice

- Plain, short, calm. Say what happened and what the person can do. No exclamation marks, no
  cheerleading, no apologies for normal behaviour.
- Sentence case everywhere: titles, buttons, labels, menus. No caps labels and no letter-spaced
  mono captions.
- No em dashes and no section-sign character, in any text: use a colon, a comma or a middle dot.
- Labels carry no full stop. Sentences in a description do.
- One idea per line. A second line is meta (`--label`), not a longer sentence.

## Names

- The person is "you" on their own screens: "You handed back to kit", "Your phone has the
  keyboard". Never their name where they are the reader. Other people's names appear only where
  they did something.
- Agents by name, lower case as they are set: kit, juno. The assistant's name comes from
  onboarding.
- Devices by their names: "alex's iPhone", "Chrome on alex's Pixel 8". On owner-facing copy,
  "Your phone", "Your laptop", "Your Capsule".
- Projects by name: Harlow Legal. Another client's name never appears on a screen that belongs to a
  different project (screens are shared with clients).
- Machine words stay in mono and only where they are what the person types or reads back:
  commands, paths, IDs, keys, codes. Tool names are never shown to the person.

## Buttons

- A verb, or a verb and an object: Allow once, Send, Start building, Trust this browser, Add your
  phone. Not OK, Yes, Submit (except a question card's Submit), Confirm.
- Destructive labels name what goes, with a count: "Delete 214 files", "Forget 3 memories",
  "Remove alex's Pixel 8".
- Busy labels keep the button's width and use the verb in progress: Allowing, Sending, Saving.
- "Always in Harlow Legal", not "Always allow" or "Remember".
- Cancel, Deny, Discard, Not now and Later are ghosts.

## States

- Empty: a short noun phrase and the first action inline ("No projects yet" and a name field).
  No illustrations, no "Oops".
- Loading: no words at first (the skeleton says it); after 10 s "The box is slow to answer".
- Error: what failed, in plain words, then the detail in mono, then a way out: "Couldn't load kit's
  history" / `ECONNRESET after 15 s` / Retry.
- Offline: say what waits and when it goes: "Queued · sends when the box is back".
- Decided: past tense and who: "Allowed once by you · 14:22", "Expired after 24 h".
- Never blame the person; never say "unknown error".

## Numbers, times and units

- Times of day 24-hour: 14:22. Relative ages short: 12m, 3h, 2d; "just now" under a minute.
- Durations: "2m 14s", "0:42" for a running timer, "5 min" in a sentence.
- Counts with the noun: "3 of 5", "99+" on badges, "Load 40 more".
- Money with the currency: "$5 cap per session".
- Middle dot ( · ) joins meta: "kit · Harlow Legal · 12m".

## Words

| Say | Not |
|---|---|
| Needs you | Inbox, notifications, alerts |
| Ask, question, draft | Request, prompt, popup |
| Held (by the Gate) | Blocked, pending approval |
| Box | Server, backend |
| Relay, Tailscale | Tunnel, VPN (except where iOS calls it that) |
| Face ID, Touch ID | Biometrics, authenticate |
| Sign in on this device | Log in, authenticate |
| Steer, queue for after | Interrupt, append |
| Stop | Cancel (for a running turn) |
| Doesn't ask | Bypass, YOLO |
| Your phone has the keyboard | Session locked |
