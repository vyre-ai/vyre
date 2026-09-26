# pwa

Branch: work/pwa · Worktree: ../vyre-pwa · Owner session: pwa

Scope (lead, 2026-09-27): the phone app ships first as the Deck installed as a web app (PWA) over
Tailscale; the native apps (team mobile) come after, on the same API and design. Branched from
work/polish-surfaces (phone Chat, five tabs, title truncation), with main merged in (2e5d78a).

## Plan
1. Shell: manifest (standalone, TOKENS colours, maskable icons, apple-touch-icon, iOS splash),
   iOS home-screen meta, safe-area insets, no rubber-band on the shell, 100dvh.
2. Phone Capsule (Find): one search box over box files, sessions, agents, memory and the assistant.
   A tab, and a pull-down from the top of any screen.
3. Chat on the phone: projects, sessions, streaming, sending (queue to a busy session once
   capsule-now lands it), asks inline, held drafts edited inline.
4. Web push (ADR 0011) for asks and held items, iOS 16.4+ home-screen push.
5. Offline: precached shell, last view, a clear "box unreachable" line.
6. Passkey on the phone (presence.enroll with a code).
7. Shots at 390x844 and 430x932 on the test box (chromedp/headless-shell container, mobile UA, touch).

## Done
- 2e5d78a merge main into work/pwa (CHANGELOG kept both sides, world.js kept breach: off).

## Doing
- Starting the plan above.

## Next
- See Plan.

## Needs from others
- capsule-now: the queue-to-busy-session contract (tool and event names). Asked 2026-09-27.
- link / files: the box cannot search the Mac's files (link carries Mac to box only). The phone
  shows box files and says Mac files need the Mac online through the link.

## Changed contracts
- None yet.
