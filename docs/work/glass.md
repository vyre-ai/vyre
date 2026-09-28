# glass

Branch: work/glass · Worktree: ../vyre-glass · Design: [ADR 0005](../adr/0005-glass.md)

## Proposal

Glass becomes a real module and a real set of Deck views, on top of computers rather than beside
it. You open an agent's computer (or the box) from the Deck, the Capsule or the phone; you watch
it live; you take the keyboard with Touch ID or Face ID and hand it back; you sign in to a site in
the agent's Chrome with the agent's eyes and hands shielded; you browse, preview, upload,
download and move files on the agent's computer and the box.

## Scope

- `core/glass/`: the `glass` module (targets, sessions, take and release with presence, files
  with one guard and two ticketed byte streams).
- `deck/glass/`: watch, take-over, sign-in, files and phone views; noVNC vendored.
- computerd `/fs` routes, contributed to the computers image.
- Capsule "Open Glass" for a thread, with the capsule session.

## Done when

On the box stack, an agent's computer runs Chrome; the Deck at 1440 and 390 shows it live; a
person takes over, types and hands back; the file browser lists, previews, uploads and downloads
in the agent's home and a box folder; secret paths are refused; everything is torn down after.

## Done

- ADR 0005 and this design.
- `core/glass`, `deck/glass`, the Capsule entry, `/glass/:name` in the Deck.
- computers additions: `computers.helper`, `computers.shield`, computerd `/fs` (sent to computers
  for review).
- Live on the box (26 Sep): Chrome in an agent's computer watched in the Deck at 1440 and 390, a
  take-over with typing that arrived and a non-holder's input dropped, the private shield through
  the API, files on the agent's computer and a box folder with preview, a one-use download and
  uploads, `.env` and `.ssh` hidden. Frozen and unwatched: vyred idle at 0 CPU ticks in 30 s,
  81 MB RSS; one viewer: about 0.3% for vyred and 1 to 1.5% for the computer; it froze again
  about 75 s after the viewer left. Everything created for the run was removed.

## Next

- Reviewer's HIGH on 1ae6fe9e (Chrome's FIFOs pre-plantable via /tmp/vyre-chrome + xterm's
  .bashrc race) fixed at 0a07c6a3: CHROME_DIR moves to /var/lib/vyre/chrome-pipes (vyre's own
  volume, agent's uid can't write there), created early in entrypoint.sh before as_agent's xterm,
  fails closed (bare mkdir, symlink/owner checks, `|| exit 1` on every chgrp/chmod/mkfifo). Bounding-
  set gap accepted as a documented residual (no SETPCAP). Live-verified on a throwaway compose
  project (vyre-glass-throwaway, own network, no ports, never /srv/vyre) on testbox: 13/13
  isolation.test.js pass, 0 fail, 0 skipped, including the new FIFO test and the shielded-freeze
  test. Stack fully torn down after. Sent to the reviewer, integrator and team-lead.
- Presence enforced once security merges; a passkey step in the Deck.
- Idle hand-back after 5 minutes, the 4-viewer cap, relay backpressure, dropping SetDesktopSize
  and xvp, clipboard to the holder only while shielded (computers).
- Vault remote fill; the private sign-in from the Deck checked live.
- Chrome's `--no-sandbox` bar and the restore-pages bubble in the image.

## Needs from others

- computers: the relay and image fixes in ADR 0005 decision 1; `computers.shield`;
  `computers.helper`; accept the computerd `/fs` routes.
- security: `computers.takeover` and `computers.giveback` on the human-only list.
- vault: the remote fill route (an addendum to ADR 0010).
- link: keep the denied-path list equal to `core/glass/guard.js`; a `mac` target later.
- capsule: an "Open Glass" action for threads whose agent has a computer.
- deck: the `/glass/:target` route (the loader is already there).
- box: run the stack with a computers container labelled `run.vyre.glass*` for the live check.
