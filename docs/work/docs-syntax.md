# docs.vyre.run page syntax, round 2 (the spec every agent writes to)

Everything below renders to useful static HTML with JavaScript off. JS only enhances.
Raw HTML in pages stays forbidden (the renderer escapes `<`). New syntax is Markdown-shaped.

## Code blocks
- Every fenced block gets a Copy button (JS). The copy text is the block's text; for `sh`/`console`
  blocks, a leading `$ ` on a line is stripped from the copied text and lines that do not start
  with `$ ` in a `console` block are treated as output (not copied).
- Info string `output` marks expected output: rendered with a small label "You should see", no
  copy button. Example:
  ```output
    Vyre is ready.
  ```

## Tabs (a choice of path or OS)
```
::: tabs
::: tab On a server
Markdown for this path.
::: tab On this Mac
Markdown for this path.
:::
```
- No JS: each tab renders as a section with its label as a small heading, one after another.
- JS: a tab bar. Choosing a tab switches every tab group on the site whose labels include that
  label, and is remembered (localStorage, wrapped in try/catch).
- Headings inside tabs are allowed (h3/h4) and get anchors as usual.

## Callouts
- Existing: `> [!NOTE]`, `> [!TIP]`, `> [!IMPORTANT]`, `> [!WARNING]`, `> [!CAUTION]`, `> [!GAP]` (label "Known gap").
- New: an alert line may carry a title after the marker: `> [!WARNING] The HTTPS switch is off`.
- New `> [!SNAG] <what you see>`: an "If this happens" box. Label "If this happens", title = the
  rest of the line (required), body = what to do. Visible, not collapsed. Gets an anchor id from
  the title (slug) so troubleshooting can link to it.
- New `> [!WHY] <question>`: an expandable "why" section, rendered as `<details><summary>`,
  collapsed by default (works without JS).

## Screenshots
- `![Alt text that says what the screen shows](shots/onboarding-tailscale.png)`. If a sibling
  `onboarding-tailscale.dark.png` exists, the page shows the light file in the light theme and the
  dark file in the dark theme (CSS only, driven by the same data-theme / prefers-color-scheme the
  site uses). width/height attributes come from the PNG header; loading=lazy.
- An image alone in a paragraph becomes a `<figure>`; its alt text is also the caption, unless a
  title is given: `![alt](shots/x.png "Caption")`.
- Shots live next to the page in a `shots/` folder: docs/get-started/shots/, docs/using/shots/ ...
- docs/shots.json records, for each shot, the files it shows and their hashes; docs-check fails a
  shot whose files changed since it was taken.

## Demos
```
::: demo capsule
Fallback Markdown shown without JS (a screenshot and a sentence).
:::
```
- Renders `<div class="demo" data-demo="capsule">fallback</div>`; JS mounts the widget named
  `capsule` in place of the fallback. Widgets: `capsule` (a Capsule mock you can type into, with
  results from the sample world: alex, Harlow Legal, Northwind Bakery, juno, kit),
  `onboarding` (a step-through of the six onboarding screens: the fallback holds the screenshots
  as a list; the widget turns them into Back/Next slides with the step names).
- The demo script is a separate asset loaded only on pages that have a demo.

## Colours
- A line `<!-- colors: dark -->` or `<!-- colors: light -->` alone on its line (outside fences)
  renders the palette from core/config/theme.js (THEME_COLORS[mode], THEME_USE) as a table of
  live swatches: swatch, token, value, use. The raw .md served for agents gets a Markdown table
  with the same data in its place.

## Search
- The search index has one entry per heading (page title, heading, anchor, a short text).
  Typing shows matches; Enter or a click jumps to page#anchor. `/` focuses search.
