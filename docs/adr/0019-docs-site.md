---
title: ADR 0019 · The docs site
summary: Why docs/ is the single source for docs.vyre.run, how pages are checked and built without a docs framework, and how agents get every page as raw Markdown.
audience: builders, agents
owner: docs
status: draft
---

# ADR 0019 · The docs site

Status: accepted, pending the lead's and the user's sign-off before the first public deploy, 27 Sep 2026 · Workstream: docs · Spec: principles 5, 8 and 9 (Section 2), engineering rules (Section 14)

## The problem

Vyre's documentation was scattered. The spec, the install guide, getting started, the install journey, the module guide and the performance audit were loose files at the top of `docs/`. The ADRs sat beside internal workstream notes in `docs/work/` that were never meant for readers. The landing page carried its own copy of the setup steps. Nothing said which pages were for users and which for builders, nothing said whether a page described shipped code or a plan, and nothing failed when a link broke or a command in a page stopped existing.

Two readers need the docs, and they need different things. People want a site they can browse and search. Agents (the user's own Claude Code sessions, and the agents Vyre runs) need the same content as plain text they can fetch and quote, without scraping HTML. A page that is true for one and stale for the other is worse than no page.

## Decision

1. **`docs/` is the source.** Every published page is a Markdown file under `docs/`, organised by reader (`get-started/`, `using/`, `concepts/`, `build/`, `reference/`, `architecture/`, `adr/`, `security/`, `contributing/`). The site is built from it and from nothing else. Moved pages leave a stub with `redirect:` in its front matter, which the build turns into a 301, so old links and the spec's section numbers keep working.
2. **`docs/nav.json` decides what is published, and in what order.** A page not in the nav is not published, and fails the check unless it is a redirect stub. The nav also names the folders that are never published: `work/`, `proposals/` and `design/boards/`. Internal notes stay in the repository, where the teams use them, and never reach the site, even by a link.
3. **A front matter contract.** Every page carries `title`, `summary`, `audience` (from `users`, `builders`, `operators`, `agents`), `owner` (one team, which keeps it true) and `status` (`stable`, `draft` or `planned`). The status lets a reader, and an agent, tell shipped behaviour from intent.
4. **`docs-check` runs under `npm test`.** `scripts/docs-check` (and `test/docs-check.test.js`) fails on missing or invalid front matter, a page missing from the nav, a broken link or `#anchor`, a link into an unpublished folder, a bad redirect, an em dash or section sign, a real name, a secret, a non-example email or IP address, or a stale reference page. A broken doc fails the build the same way a broken test does.
5. **Reference pages are generated.** `scripts/gen-docs-reference` writes `docs/reference/{cli,tools,events,config,modules}.md` from the code: the CLI's command list, every `ctx.tool` definition, every `module.json`, the `emit` calls and `core/config`. Nobody edits them by hand, and `docs-check` fails when they differ from what the code makes, so the reference cannot drift.
6. **A static build, deployed to Cloudflare Pages.** `scripts/build-docs` renders every page to HTML with a small renderer in `scripts/lib/docs/`, with no dependencies. It is deterministic: the same tree builds the same bytes. The output goes to the Cloudflare Pages project `vyre-docs`, served at docs.vyre.run.
7. **Raw Markdown at every path, plus llms.txt.** Each page is also published as its own Markdown at the same path with `.md` (front matter kept, includes spliced), served as `text/markdown`. The build writes `/llms.txt`, an index of every page with its `.md` URL and summary, and `/llms-full.txt`, every page in nav order in one file.
8. **Every feature merges with its doc page.** The owner team updates its pages in the same change as the code. The contract is written down for contributors in [Writing the docs](../CONTRIBUTING-DOCS.md).

## Alternatives considered

- **A docs framework (Docusaurus, VitePress, MkDocs and the like).** Rejected. Each brings a large dependency tree and usually a bundler, where Vyre has no build step for its core and one optional runtime dependency; the package's `package.json` lists no docs framework, and adding one would make the docs the heaviest part of the repository (Section 2, principle 5: dependencies need a reason). It would also run against principle 8, light by default: a framework's client runtime is more than a docs page needs. And the checks that matter here (front matter, the nav, generated reference, hygiene, raw Markdown beside each page) would have to be written as plugins anyway.
- **Keep the docs in the repository only, read on GitHub.** Rejected. GitHub renders Markdown, but has no nav, no search across pages, no redirects when a page moves, and no single file an agent can fetch for the whole set. Internal notes would sit next to user pages with nothing marking the difference.
- **A hosted docs service.** Rejected. It moves the source of truth out of the repository, so a feature and its page could no longer merge together, and it cannot run the same check as `npm test`.

## Consequences

- One place to write, one check, one build. A contributor who changes a command's summary or a tool's description regenerates the reference with `npm run docs:ref`, and `npm test` says so if they forget.
- Agents get every page as Markdown at a predictable URL, and all of them at `/llms-full.txt`. The front matter tells them what is shipped.
- The renderer is Vyre's to maintain. It covers CommonMark plus the GFM parts the docs use (tables, task lists, alerts) and nothing more: no raw HTML, no indented code blocks. A page that needs more has to do without, or the renderer grows, with a test.
- The site is hosted on a Cloudflare Pages project. Deploying needs the lead's account access. Nothing about the user reaches it; the site holds only the docs.
- Internal notes stay in the repository and remain visible there. Unpublished means not on the site, not secret; nothing sensitive may go in them either.
- The first public deploy waits for the lead's and the user's sign-off on the built site.
