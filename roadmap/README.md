# Roadmap by version

Each planned version has its own branch and its own plan.

- One branch per planned version, named `release/<version>` (for example `release/0.6`).
- The branch starts with one document, `roadmap/<version>.md`, that outlines everything planned for that version. It is the first commit on the branch.
- Items move into the document from the backlog. An item has one line of what and why, a one-line acceptance test, and a size when there is an estimate. Items that fit no planned version wait under "Later" in the nearest plan.
- Work for the version lands on its branch. The document is edited as scope changes, so it always matches what the version will ship.
- When the version ships, its branch merges to `main` and the branch is deleted. The document stays in `roadmap/` as the record of what the version set out to do.

The line-by-line list of what each release contains is in [docs/roadmap.md](../docs/roadmap.md). The plans here are the detail behind it.

Version numbers: the middle number goes up for features or a considerable change, and the last number is fixes only. 0.5.1 is a patch: the onboarding order fix plus the stability fixes merged since 0.5.0. It has no plan document. Planned feature work is 0.6 and 0.7.

Item ids such as R051-01 are stable names: they do not change when an item moves to another release.

Plans: [0.6](0.6.md), [0.7](0.7.md).
