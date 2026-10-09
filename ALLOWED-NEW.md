# Adding a dependency (R031-00b)

Vyre uses one library or service per job, reused through the kernel. Before a new dependency lands, show that nothing already in the repo or the kernel does the job.

1. Look first: the consolidation inventory (`team/0.3.1/INVENTORY.md` in the team repo) lists the jobs already done, with the one to use. `lib/` holds the shared helpers (addresses in `lib/netguard.js`, known secrets in `lib/scrub.js`, credential shapes in `lib/credential-shapes.js`, time in `lib/time`, ids in `lib/id.js`).
2. If nothing serves, add the dependency, and add one line for it in `test/allowed-dependencies.json` under its manifest: the name and **why no existing one serves**. That line is the review: a reviewer reads it and the diff, nothing else.
3. `test/dependency-guard.test.js` fails in CI on a dependency that has no line, on a line with no reason, and on a package imported in server code that no manifest declares.

What counts: every `package.json` (except test fixtures), `Cargo.toml`, `go.mod`, Gradle `implementation` lines, a package installed by a workflow or a Dockerfile, a base image, and a bare `import` of a package nobody declared.

What does not: Node's built-ins, and the `@vyre/*` aliases the app and the module SDK map to files in this repo.

A dependency that replaces another removes the old one's line in the same change.
