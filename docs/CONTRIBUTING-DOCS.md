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
| `owner` | yes | One team: `tailnet`, `capsule-pro`, `capsule-sight`, `connectors`, `mobile`, `polish-cli`, `polish-surfaces`, `e2e`, `integrator`, `docs`, `planner`, `cc-plugin`, `glass-live`, `pwa`. The owner keeps the page true (`scripts/lib/docs/check.js` holds the list). |
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

## Page syntax

Beyond plain Markdown, pages have a few blocks of their own. Every one renders to useful static
HTML with JavaScript off; the script only adds to it. Raw HTML stays forbidden.

### Commands and what they print

Every fenced block gets a Copy button. In an `sh` or `console` block, a leading `$ ` is not
copied, and in a `console` block that has prompts, lines without one are output and are not
copied either. A command ending in `\` carries on to the next line.

````md
```console
$ vyre status
vyred is up
```
````

Put what the reader should see after a command in an `output` block. It is labelled "You should
see" and has no Copy button.

````md
```output
  Vyre is ready.
```
````

### Tabs

For a choice of path or system. Without JavaScript each tab is a section with its label above it;
with it, a tab bar. Picking a tab picks the same label in every tab group on the site, and the
choice is remembered.

```md
::: tabs
::: tab On a server
Markdown for this path. Headings (h3, h4) are fine and get anchors.
::: tab On this Mac
Markdown for this path.
:::
```

Use the same labels on every page (`On a server`, `On this Mac`) so one choice follows the reader.

### Callouts

`> [!NOTE]`, `> [!TIP]`, `> [!IMPORTANT]`, `> [!WARNING]`, `> [!CAUTION]` and `> [!GAP]` (shown as
Known gap). Any of them may carry a title after the marker:

```md
> [!WARNING] The HTTPS switch is off
> Turn on HTTPS for your tailnet, then press Check again.
```

`> [!SNAG]` is an "If this happens" box: the title (required) is what the reader sees, the body is
what to do. It is never collapsed, and its title makes an anchor like a heading does, so
[troubleshooting](get-started/troubleshooting.md) can link to `#the-page-says-not-found`:

```md
> [!SNAG] The page says "not found"
> Wait a minute for the certificate, then reload.
```

`> [!WHY]` answers a question for the curious, collapsed until clicked:

```md
> [!WHY] Why does Vyre need a server?
> Your agents keep working while the Mac sleeps.
```

### Screenshots

Keep shots next to the page in a `shots/` folder (`docs/get-started/shots/`). An image alone in
its paragraph becomes a figure, captioned by its alt text, or by its title when it has one. Write
alt text that says what the screen shows.

```md
![The Tailscale step, waiting for the server to join](shots/onboarding-tailscale.png "Tailscale")
```

If `onboarding-tailscale.dark.png` sits beside it, the dark theme shows that file instead. The
build reads each PNG's width and height from the file, so the page does not jump as shots load.

Shots are taken, not drawn. `npm run docs:shots` (on the test box, never the Mac) starts the sample
world in a temp home and captures every shot listed in `scripts/lib/docs/shots.js`, in light and
dark, with `CHROME` pointing at a headless Chrome. Each entry there names the source files the
shot shows. `docs/shots.json` records a hash of those files at capture time, and docs-check fails a
shot once any of them changes, so a screen that moved on gets retaken before the next deploy.
`npm test` only notes stale shots, so a Deck change never turns another team's suite red. To add a shot, add an entry
to `shots.js`, run `npm run docs:shots -- --only <name>`, and put it on the page. Command output
is text, not a picture: paste it into an `output` block (`npm run docs:shots -- --cli` prints the
real output of the common commands from the sample world).

### Demos

A widget that replaces its fallback when the page's script runs. The fallback is what readers
without JavaScript (and agents reading the `.md`) get, so make it complete: a screenshot and a
sentence, or a list of screenshots.

```md
::: demo capsule
![The Capsule, with results for north](shots/capsule-north.png)
Type in the Capsule and it finds agents, projects, threads, notes and logins.
:::
```

- `capsule`: a Capsule you can type into, with results from the sample world only.
- `onboarding`: the fallback's list of screenshots, one per step, as Back and Next slides. Each
  step's name is its screenshot's title:

```md
::: demo onboarding
1. ![Your name and a name for your assistant](shots/onboarding-you.png "You")
2. ![Sign in with Claude, or paste a key](shots/onboarding-claude.png "Claude Code")
:::
```

Only pages with a demo load the demo script. A name the site does not know fails the check.

### Colours

A line holding only `<!-- colors: dark -->` or `<!-- colors: light -->` shows the palette from
`core/config/theme.js` as a table of live swatches (token, value, use). The `.md` the site serves
gets a Markdown table in its place. Change colours in `theme.js` (and TOKENS.md), not in a page.

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

### The index

`npm run docs:ref` also writes `docs/reference/index.md` and `docs/index.json` (served at
`/index.json`): every command and subcommand, tool, event, config key, `VYRE_` variable, Deck
screen and concept, with the code file that defines it, the page that explains it, and every page,
line and heading anchor that mentions it. One lookup finds every instance of a thing. It reads
every published page, so run `npm run docs:ref` after editing any page, not only after changing
code; docs-check fails when the index is out of date.

docs-check also fails a stale mention: inline code or a `sh`/`console` command line naming a `vyre`
command or subcommand, a tool, a config key under a known section, or a `VYRE_` variable that the
code no longer has. Placeholders (`<name>`), flags, file names and example modules are left alone,
and ADRs, the changelog, known gaps and the spec are indexed but never failed. If a line must show
an old or made-up name on purpose, end it with `<!-- terms: ignore -->`. Curated concepts live in
`CONCEPTS` in `scripts/lib/docs/terms.js`; add one there, with the page and heading that explain
it, when a page teaches a new word.

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
- **syntax**: every `:::` container is known and closed, a demo names a widget that exists, a
  `[!SNAG]` or `[!WHY]` has its title, a colors line says dark or light. Headings inside tabs and
  `[!SNAG]` titles count as anchors;
- **characters**: no em dash and no section sign, in pages and in files they include;
- **hygiene**: no real person's or business's name, nothing shaped like a secret, no email address outside the example domains, no IP address outside the documentation and private ranges (`scripts/lib/hygiene.js`);
- **reference**: the generated pages and the index match what the code and the pages make now;
- **stale**: no page names a command, tool, config key or variable the code no longer has;
- **shots**: every screenshot is in `docs/shots.json`, and none is older than the code it shows.

`test/docs-check.test.js` runs the same check on the real tree under `npm test`, so a broken page fails the suite.

## Build the site

```
npm run docs:build                   # into docs-site/ (gitignored)
node scripts/build-docs --out DIR    # somewhere else
```

`scripts/build-docs` empties the output folder, then writes:

- each page as HTML at its pretty URL, and its Markdown source beside it at the same path with `.md`, front matter kept and includes spliced;
- `search-index.json` for the search box: one item per page intro, heading and `[!SNAG]`, each with
  its anchor, so a result jumps to the section. Press `/` to search;
- `llms.txt`, an index of every page by section with its `.md` link and summary, and `llms-full.txt`, every page's Markdown in nav order in one file;
- `sitemap.xml`, `robots.txt`, `404.html`, `favicon.svg`;
- `_redirects` (a 301 for every stub) and `_headers` (Markdown and text content types, cache rules) for Cloudflare Pages;
- one stylesheet and one script under `assets/`, named by content hash, and the demo widgets'
  stylesheet and script, linked only from pages with a demo.

The same tree builds the same bytes: nothing reads the clock or the network. The renderer (`scripts/lib/docs/markdown.js`) has no dependencies. It renders CommonMark plus GFM tables, task lists, strikethrough and alerts (`> [!NOTE]`, and `> [!GAP]`, shown as Known gap), and the [page syntax](#page-syntax) above. It does not render raw HTML: every `<` shows as text, so write `<you>.vyre.run` as it is. Indented code blocks are not supported; use fences.

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
