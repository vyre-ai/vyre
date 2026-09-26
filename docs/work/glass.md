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

## Needs from others

- computers: the relay and image fixes in ADR 0005 decision 1; `computers.shield`;
  `computers.helper`; accept the computerd `/fs` routes.
- security: `computers.takeover` and `computers.giveback` on the human-only list.
- vault: the remote fill route (ADR 0001 addendum B).
- link: keep the denied-path list equal to `core/glass/guard.js`; a `mac` target later.
- capsule: an "Open Glass" action for threads whose agent has a computer.
- deck: the `/glass/:target` route (the loader is already there).
- box: run the stack with a computers container labelled `run.vyre.glass*` for the live check.
