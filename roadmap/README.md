# Roadmap by version

Each planned version has its own branch and its own plan.

- One branch per planned version, named `release/<version>` (for example `release/0.5.1`).
- The branch starts with one document, `roadmap/<version>.md`, that outlines everything planned for that version. It is the first commit on the branch.
- Items move into the document from the backlog. An item has one line of what and why, a one-line acceptance test, and a size when there is an estimate. Items that fit no planned version wait under "Later" in the nearest plan.
- Work for the version lands on its branch. The document is edited as scope changes, so it always matches what the version will ship.
- When the version ships, its branch merges to `main` and the branch is deleted. The document stays in `roadmap/` as the record of what the version set out to do.

The line-by-line list of what each release contains is in [docs/roadmap.md](../docs/roadmap.md). The plans here are the detail behind it.

Plans: [0.5.1](0.5.1.md), [0.5.2](0.5.2.md).
