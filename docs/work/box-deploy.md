# box-deploy

Branch: work/box-deploy · Worktree: ../vyre-box-deploy · Owner session: box-deploy

## Done
- ADR 0038 terminology sweep, my two lines in `core/cli/commands/projects.js` (docs' inventory
  under `## box-deploy`): the `vyre projects` summary and the `move` verb summary both said
  "on a box"; now "on a server". Left `core/projects/index.js`'s "box-deploy has validated it on
  a copy" line and the internal comment at `core/cli/commands/projects.js:295` alone — those name
  our team or aren't user-facing, not the retiring "box" terminology. Ran `npm run docs:ref`
  (regenerated `docs/reference/cli.md`) and `test/docs-*.test.js` (61/61 pass, no terminology
  hits). `docs:check` still reports its pre-existing 244 stale-screenshot warnings, unrelated to
  this change and unfixable off testbox.

## Doing
- Nothing else queued.

## Next
- Send the sha to the integrator once this lands (docs asked for it).

## Needs from others
- None.

## Changed contracts
- None (CLI help text only; no tool schema, event or route changed).
