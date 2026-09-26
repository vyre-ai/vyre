# computers

Branch: work/computers · Worktree: ../vyre-computers · Milestone: M8 · Wave 2 (after switchboard merges)

## Scope

Owns `core/computers/`, `modules/hands-desktop/`, `modules/hands-chrome/`, and the Glass views
in `deck/glass/` (agree the folder with the deck session first).

Each agent gets its own computer: a container with a desktop, Chrome and a terminal. Screens come
from a shared pool and are checked out only while an agent needs to look; idle containers freeze.
Glass streams a screen to the Deck, with take-over (one keyboard at a time, via the switchboard lease).

- Containers with Docker on Linux (the box). Image: Xvfb or a Wayland compositor, a VNC or WebRTC
  stream, Chrome with remote debugging, a terminal.
- `hands-chrome`: Chrome control over CDP from one long-lived connection (port the measured
  design in `the prototype's bin/macd.cjs`: a persistent daemon was 137x faster than per-call spawns).
- `hands-desktop`: the accessibility tree over AT-SPI (`the prototype's bin/desktop.cjs`), with
  verified actions (`act.cjs`, `verify.cjs`, `selector.cjs`).

## Done when

An agent thread opens a page in its own container's Chrome, the user watches it live in Glass
on the Deck, takes over, types, and hands back.
