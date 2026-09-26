---
title: Writing the docs
summary: The contract every page on docs.vyre.run follows: front matter, the nav, redirects, includes, generated reference pages, the checks, the build, and the style.
audience: builders, agents
owner: docs
status: stable
---

# Writing the docs

docs.vyre.run is built from the Markdown files under `docs/` in the Vyre repository. People read the rendered pages; agents read the same files raw. So every page follows one contract, and `npm test` fails when a page breaks it. This page is that contract. The decision behind it is [ADR 0019](adr/0019-docs-site.md).

Every feature merges with its doc page. A feature is not done until the page that describes it is true, in the same change.

## Where a page lives

A page is a `.md` file under `docs/`, in the folder of its section: `get-started/`, `using/`, `concepts/`, `build/`, `reference/`, `architecture/`, `adr/`, `security/`, `contributing/`. Its URL is its path without `.md`:

| File | Page | Raw Markdown |
| --- | --- | --- |
| `docs/index.md` | `/` | `/index.md` |
| `docs/using/vault.md` | `/using/vault` | `/using/vault.md` |
| `docs/architecture/index.md` | `/architecture/` | `/architecture/index.md` |

Three folders are internal and never published, whatever is in them: `docs/work/` (workstream notes), `docs/proposals/` and `docs/design/boards/`. They are listed under `unpublished` in `docs/nav.json`. A published page may not link into them.

## Front matter

Every published page starts with a front matter block, then one `# H1` that matches the title:

```
---
title: Vault
summary: One sentence, what the reader gets from this page.
audience: users, agents
owner: docs
status: stable
---

# Vault
```

| Key | Required | Allowed values |
| --- | --- | --- |
| `title` | yes | The page's name, as the nav and the `# H1` show it. |
| `summary` | yes | One sentence. It appears in search, in `/llms.txt` and under the title. |
| `audience` | yes | A comma list from `users`, `builders`, `operators`, `agents`. |
| `owner` | yes | One team: `tailnet`, `capsule-pro`, `capsule-sight`, `connectors`, `mobile`, `polish-cli`, `polish-surfaces`, `e2e`, `integrator`, `docs`. The owner keeps the page true. |
| `status` | yes | `stable` (shipped on main), `draft` (partly shipped, may change), `planned` (not built yet). |
| `generated` | no | The script that writes the page. Only generated reference pages carry it. |

Any other key is an error. The lists live in `scripts/lib/docs/check.js` (`AUDIENCES`, `STATUSES`, `OWNERS`); change them there, not here only.

The front matter parser reads a small subset of YAML: `key: value`, optional quotes, a trailing `# comment` after whitespace, and inline `[a, b]` lists.

## The nav

`docs/nav.json` lists every published page, in order, by section:

```json
{
  "site": { "title": "Vyre docs", "url": "https://docs.vyre.run", "repo": "https://github.com/vyre-ai/vyre" },
  "sections": [
    { "title": "Start here", "pages": ["index.md"] },
    { "title": "Get started", "pages": ["get-started/install.md", "get-started/onboarding.md"] }
  ],
  "unpublished": ["work/", "proposals/", "design/boards/"]
}
```

Only pages in the nav are published. A published page that is not in the nav fails the check, and so does a nav entry with no file, a page listed twice, or a nav entry in an unpublished folder. The order in the nav is the order of the sidebar, the previous and next links, `/llms.txt` and `/llms-full.txt`.

## Moving a page: redirect stubs

When a page moves, leave a stub at the old path with only a `title` and a `redirect`:

```
---
title: Specification
redirect: architecture/spec.md
---
```

The redirect is a docs-relative path. The build turns each stub into two 301s in `_redirects`, one for the pretty URL and one for the `.md`, and a link to the old path is rewritten to the new page. A stub is not listed in the nav (list its target), may not point into an unpublished folder, and may not point at another stub.

## Links

- Link between pages with relative `.md` paths: `[the vault](../using/vault.md#share-a-secret)`. The build rewrites them to page URLs.
- Every link and every `#anchor` must resolve. Anchors are GitHub-style heading slugs: lowercase, punctuation dropped, spaces to hyphens, `-1`, `-2` for repeats. `## 11. The security floor` is `#11-the-security-floor`.
- A link to a file elsewhere in the repository (`../../core/vault/index.js`) becomes a link to that file on GitHub.
- Absolute paths on the site (`/llms.txt`, `/using/vault`) are checked against what the site serves. External links are not checked.
- Link to the generated reference pages rather than repeating their tables.

## Includes

A line holding only an HTML comment that names a file splices that file into the page:

```md
<!-- include: ../CHANGELOG.md -->
```

Inside fenced code, as above, the line is an example and is left alone.

The path is relative to the page and must stay inside the repository. The included file's front matter is dropped, and links inside it resolve from its own folder. Includes nest a few levels deep. The raw `.md` the site serves has the include already spliced in. The check scans included files for the same characters and hygiene problems as pages, and fails on an include whose file does not exist.

## Generated reference pages

`docs/reference/{cli,tools,events,config,modules}.md` are written from the code by `scripts/gen-docs-reference`:

| Page | Source |
| --- | --- |
| `cli.md` | the command list in `core/cli` (what `vyre help` prints) |
| `tools.md` | every `ctx.tool` definition, recorded by starting each module in a child process with a throwaway home |
| `events.md` | each manifest's watches, with payload fields read from the `emit` calls |
| `config.md` | `core/config/index.js` and every `process.env.VYRE_` the shipped code reads |
| `modules.md` | every `module.json` `vyred` would load |

Do not edit them by hand. Change the code (a command's summary, a tool's description), then:

```
npm run docs:ref            # write the pages
node scripts/gen-docs-reference --check   # exit 1 if any page is stale, write nothing
```

## Check your pages

```
npm run docs:check                          # everything
node scripts/docs-check --no-reference      # skip regenerating the reference pages
```

It prints one `path:line: problem` per problem and exits 1 if there are any. It checks:

- **front matter**: present, every required key, allowed values, no unknown keys;
- **nav**: every published page listed, every entry a real file;
- **links**: relative links, `#anchors` and docs.vyre.run paths resolve, nothing links into an unpublished folder;
- **redirect**: stubs point at real, published, non-stub pages;
- **characters**: no em dash and no section sign, in pages and in files they include;
- **hygiene**: no real person's or business's name, nothing shaped like a secret, no email address outside the example domains, no IP address outside the documentation and private ranges (`scripts/lib/hygiene.js`);
- **reference**: the generated pages match what the code makes now.

`test/docs-check.test.js` runs the same check on the real tree under `npm test`, so a broken page fails the suite.

## Build the site

```
npm run docs:build                   # into docs-site/ (gitignored)
node scripts/build-docs --out DIR    # somewhere else
```

`scripts/build-docs` empties the output folder, then writes:

- each page as HTML at its pretty URL, and its Markdown source beside it at the same path with `.md`, front matter kept and includes spliced;
- `search-index.json` for the search box;
- `llms.txt`, an index of every page by section with its `.md` link and summary, and `llms-full.txt`, every page's Markdown in nav order in one file;
- `sitemap.xml`, `robots.txt`, `404.html`, `favicon.svg`;
- `_redirects` (a 301 for every stub) and `_headers` (Markdown and text content types, cache rules) for Cloudflare Pages;
- one stylesheet and one script under `assets/`, named by content hash.

The same tree builds the same bytes: nothing reads the clock or the network. The renderer (`scripts/lib/docs/markdown.js`) has no dependencies. It renders CommonMark plus GFM tables, task lists, strikethrough and alerts (`> [!NOTE]`, and `> [!GAP]`, shown as Known gap). It does not render raw HTML: every `<` shows as text, so write `<you>.vyre.run` as it is. Indented code blocks are not supported; use fences.

The site deploys to the Cloudflare Pages project `vyre-docs`:

```
npx wrangler pages deploy docs-site --project-name vyre-docs --branch main
```

## Style

- No em dash and no section-sign character, anywhere. Use a colon, a comma, or two sentences. Write "Section 5.1" for spec references. The check enforces this.
- Examples use the sample world only: the user alex, the firms Harlow Legal and Northwind Bakery, the assistant and agents juno and kit, the domains `example.com`, `harlowlegal.com` and `*.example`, tailnet names like `vyre.tail1234.ts.net`, and addresses from `192.0.2.x` or `100.64.x.x`. The check enforces names, emails and addresses.
- Plain, direct English, in the second person. Short paragraphs. Concrete commands in fenced blocks. No marketing adjectives, no "simply", no "seamless".
- Write only what is true on main. Copy commands, flags, config keys, tool names and paths from the code. When something is designed but not built, say "Not built yet." or mark the page `draft` or `planned`.
- A reader who is an agent should be able to act from the page alone.

A user page has this shape: one paragraph of what it is and why; the common tasks, with headings that are tasks ("Share a secret with an agent"); what it will not do; where to go next.

## Known gaps

Document what the code does. When that differs from the spec, an ADR or a screen, say so on the
page in a callout and give the gap its own section in [known gaps](known-gaps.md), with what is
true now, what to do instead, and the owning team:

```md
> [!GAP]
> The switch pauses but does not resume. See [known gaps](../known-gaps.md#the-decks-pause-switch-does-not-resume-a-watcher).
```

The change that closes a gap removes its callouts and its section.

## A page template

```
---
title: Watchers
summary: Small programs Claude writes that watch something for you and file what they find into a project.
audience: users
owner: docs
status: draft
---

# Watchers

One paragraph: what a watcher is, and why you would want one.

## Write a watcher

Steps, with the exact commands:

    vyre watchers create <name>

## Pause one

...

## What watchers will not do

...

## Where to go next

- [Projects and threads](projects-and-threads.md)
- [Tools reference](../reference/tools.md)
```

(In a real page, fence the command with three backticks instead of indenting it; indented code is not rendered.)

## Where to go next

- [ADR 0019](adr/0019-docs-site.md), why the docs work this way.
- [Contributing](contributing/index.md), the rules for code.
