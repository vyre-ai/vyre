---
title: ADR 0019: The docs site
summary: Why docs/ is the single source for docs.vyre.run, how pages are checked and built without a docs framework, how agents get every page as raw Markdown, and the round-2 additions (page syntax that needs no JavaScript, screenshots that go stale with the code, a terms index, colours from the code).
audience: builders, agents
owner: docs
status: draft
---

# ADR 0019: The docs site

Status: accepted, 27 Sep 2026, amended the same day after the user's review of the preview (decisions 9 to 12) · Workstream: docs · Spec: principles 5, 8 and 9 (Section 2), engineering rules (Section 14)

The preview is deployed at `preview.vyre-docs.pages.dev`. Production at docs.vyre.run waits for the user's yes.

## The problem

Vyre's documentation was scattered. The spec, the install guide, getting started, the install journey, the module guide and the performance audit were loose files at the top of `docs/`. The ADRs sat beside internal workstream notes in `team/archive/work-journals/` that were never meant for readers. The landing page carried its own copy of the setup steps. Nothing said which pages were for users and which for builders, nothing said whether a page described shipped code or a plan, and nothing failed when a link broke or a command in a page stopped existing.

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

The user reviewed the preview and asked for pages that show more and ask less of the reader. Round 2 adds four decisions:

9. **Richer pages that work with JavaScript off.** New syntax stays Markdown-shaped, and raw HTML stays forbidden. Every addition renders to useful static HTML first; JavaScript only improves it. The syntax:
   - `::: tabs` / `::: tab <label>` for a choice of path or OS. Without JavaScript each tab is a section with its label as a heading. With it, a tab bar, and choosing a label switches every tab group on the site that has it, remembered in the browser.
   - A title after a callout marker (`> [!WARNING] The HTTPS switch is off`), and two new callouts: `> [!SNAG] <what you see>`, an "If this happens" box with its own anchor so troubleshooting can link to it, and `> [!WHY] <question>`, background a first-time reader can skip, rendered as a collapsed `<details>`.
   - A Copy button on every code block (a leading `$ ` is not copied), and `output` code blocks for expected output, labelled "You should see", with no Copy button.
   - `::: demo <widget>` for a live widget (a Capsule mock, the onboarding steps) over a Markdown fallback. The widget script loads only on pages that have a demo.
   - Search over every heading, not only page titles. `/` focuses it.
10. **Screenshots that go stale with the code.** A shot lives in a `shots/` folder beside its page, with an optional `.dark.png` twin that the dark theme shows instead. Each shot names the source files it shows, and `docs/shots.json` records a SHA-256 of each file's content when the shot is taken. `docs-check` fails a shot whose files have changed since, a PNG no entry lists, and an entry whose PNG is gone. Content hashes, not dates, because the checkout the shots are taken in has no Git history or trustworthy file times.
11. **A terms index.** `docs/index.json` lists the terms a reader meets (commands, tools, config keys, concepts) and the page that explains each, published as a page under Reference. `docs-check` fails a page that mentions a term the code no longer has.
12. **Colours from the code.** The palette on the design pages is not copied by hand. A `<!-- colors: dark -->` or `<!-- colors: light -->` line renders `THEME_COLORS` and `THEME_USE` from `core/config/theme.js` as a table of swatches (in the raw Markdown, a plain table), so the docs cannot show a colour the product does not use.

## Alternatives considered

- **A docs framework (Docusaurus, VitePress, MkDocs and the like).** Rejected. Each brings a large dependency tree and usually a bundler, where Vyre has no build step for its core and one optional runtime dependency; the package's `package.json` lists no docs framework, and adding one would make the docs the heaviest part of the repository (Section 2, principle 5: dependencies need a reason). It would also run against principle 8, light by default: a framework's client runtime is more than a docs page needs. And the checks that matter here (front matter, the nav, generated reference, hygiene, raw Markdown beside each page) would have to be written as plugins anyway.
- **Keep the docs in the repository only, read on GitHub.** Rejected. GitHub renders Markdown, but has no nav, no search across pages, no redirects when a page moves, and no single file an agent can fetch for the whole set. Internal notes would sit next to user pages with nothing marking the difference.
- **A hosted docs service.** Rejected. It moves the source of truth out of the repository, so a feature and its page could no longer merge together, and it cannot run the same check as `npm test`.

## Consequences

- One place to write, one check, one build. A contributor who changes a command's summary or a tool's description regenerates the reference with `npm run docs:ref`, and `npm test` says so if they forget.
- Agents get every page as Markdown at a predictable URL, and all of them at `/llms-full.txt`. The front matter tells them what is shipped.
- The renderer is Vyre's to maintain. It covers CommonMark plus the GFM parts the docs use (tables, task lists, alerts) and the syntax in decision 9, and nothing more: no raw HTML, no indented code blocks. A page that needs more has to do without, or the renderer grows, with a test.
- A page must read well with JavaScript off, in a terminal browser, and as raw Markdown. Tabs, demos and copy buttons are conveniences on top.
- A change to a screen can fail `docs-check` because a shot shows it. The fix is to retake the shot (`scripts/docs-shots`), not to edit `docs/shots.json`.
- The site is hosted on the Cloudflare Pages project `vyre-docs`. Deploying needs the lead's account access. Nothing about the user reaches it; the site holds only the docs.
- Internal notes stay in the repository and remain visible there. Unpublished means not on the site, not secret; nothing sensitive may go in them either.
- The first production deploy waits for the user's sign-off on the preview.
