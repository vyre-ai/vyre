# Capsule parity vectors (C2)

Golden vectors so the Windows panel (JavaScript) and the Mac Capsule (Swift) test against the same
facts. Every file is plain JSON with a top-level `"v": 1`. Values come from the existing Swift
tests' assertions (RouteTests.swift, AutoAskTests.swift, CommandRunTests.swift, MatchTests.swift);
nothing here invents behaviour that wasn't already asserted or directly traceable from the
algorithm those tests cover. The sample world is the one the team's rules require: alex, Harlow
Legal, Northwind Bakery, juno, kit, pax.

## route.json

Source: `Sources/Vyred/Route.swift` (`Route.destinations`, `Route.asksQuestion`, `Route.ownThings`)
and `Sources/Host/AutoAsk.swift` (`CapsuleModel.wantsAnswer`, `CapsuleModel.doRequest`), matched
against `Tests/RouteTests.swift` and `Tests/AutoAskTests.swift`.

Shape: `{v, world, catalogs, threadSets, cases: [{input, expect, note?}]}`.

- `world`: shared constants (`now`, `day` in ms since 1970) the fixture times are relative to.
  A thread/project `last` field is written as `"now-2h"`/`"now-4day"`/etc. rather than a raw
  number, so the fixture reads the way the tests do; a loader parses `now[-N(h|day)]`.
- `catalogs`: named, self-contained `VyreCatalog` fixtures (`default`, `none`, `empty`,
  `onCurrentKit`). Each carries its own full `agents`/`projects`/`threads`, so a loader never has
  to merge an override into a base catalog. `agents: null` means the whole field is nil (no
  switchboard at all); `agents: []` means a switchboard with nothing on it yet.
- `threadSets`: named thread lists built from a catalog with one field forced. `kitThreads`
  pulls `ids` out of `catalogs[catalog].threads` and sets `.agent` on each to the given name,
  because `Route.destinations`'s `agentThreads` parameter needs threads already tagged to the
  acting agent, which the base catalog's own threads don't carry.
- `cases[].input.fn` picks the function under test: `destinations`, `asksQuestion`, `ownThings`,
  `wantsAnswer`, or `doRequest`. Each `fn` has its own input fields (see the cases themselves;
  `destinations` takes `target`, `text`, `catalog` (a key into `catalogs`), optional `agentThreads`
  (a key into `threadSets`) and `quick`).
- `cases[].expect` is shaped per `fn`:
  - `destinations`: any of `kinds` (the `"kind:agent-or-model"` list a case checks), `options`
    (a parallel array of partial `VyreDestination` field checks, only the fields given are
    checked), `optionCount`, `firstKind`, `why` / `whyContains`, and `describeOptions0`/
    `describeOptions1` (the `Route.describe()` result for that option index).
  - `asksQuestion`, `wantsAnswer`: a boolean.
  - `ownThings`: `null`, or `{contains: "..."}` for a substring check (the real return also carries
    the word or name that matched, which is not pinned down further here).
  - `doRequest`: a string or `null`.

## commands.json

Source: `Sources/Host/CommandRun.swift` (`CLIRun.parse`, `.forCapsule`, `.refused`), matched
against `Tests/CommandRunTests.swift`.

Shape: `{v, cases: [{input: {fn, ...}, expect, note?}]}`. `fn` is `parse` (`text` -> `[String]?`),
`forCapsule` (`argv` -> `[String]`), or `refused` (`argv` -> `String?`).

## match.json

Source: `Sources/Core/Match.swift` (`Match.score`, `.words`), matched against `Tests/MatchTests.swift`.

Shape: `{v, cases: [{input: {fn, ...}, expect, note?}]}`. `fn` is `score` (`query`, `label`,
optional `synonyms` -> a number 0..1), `words` (`label` -> `[String]`), or `hits` (`query`,
`names` -> the subsequence of `names` that score above 0, in the same rank order `Route.rank`
would show them: higher score first, ties keep the input order). A couple of `score` cases
(`ote`/`nts` against `Notes`) give an exact tier value derived from Match.swift's own documented
tiers (0.5 substring, 0.3 subsequence) rather than only the test's `> 0` check, since the function
is pure and deterministic; if a Swift change ever moves the tier, `SpecVectorsTests` catches it.

## strings.json

Source: every `Text("...")` literal and message string assigned to a Capsule-owned property
(`line`, `why`, `failure:`, etc.) across `Sources/Host`, `Sources/UI`, `Sources/Agent`,
`Sources/Extensions`, `Sources/Vyred` and `Sources/Kit`. Debug/log text (the test harness's stderr
trace lines, code comments) is excluded, as are pure layout glyphs with no words (`"›"`,
`"·"`).

Shape: `{v, note, strings: [{id, text, where, leaks, leakWord?, note?}]}`.

- `id`: a stable slug, namespaced by rough area (`hotkey.*`, `cli.*`, `agent.*`, ...).
- `text`: the string as written, with `{placeholder}` for interpolated Swift (`\(...)`) segments.
- `where`: the source file(s) the string lives in (a relative path under `local/capsule/native`).
- `leaks`: `true` when the line names an internal system word a person never typed and shouldn't
  read: `vyred` (the daemon's process name; the product name is "Vyre"), `switchboard`, an
  internal tool name (`vault.connect`, `core/learn`, `local/voice`), or anything shaped like
  "no such tool". These are flagged, not fixed, here, so the plain-wording pass has a checklist.
  `leakWord` names which word leaked, when it isn't simply the whole line.

## keys.json

Source: `Sources/Host/Panel.swift` (`key()`, the switch that owns every in-panel keystroke),
`Sources/Host/Hotkeys.swift` (Control-twice and the Option-Space chord that open the Capsule from
anywhere), and `Sources/UI/CapsuleView.swift` (`CapsuleLayout.footerHints`/`hints`, the footer's
per-state key hints, which is the plain-language mirror of the same switch).

Shape: `{v, note, global: [...], panel: [...], footer_hints: {states: [...]}}`.

- `global`: keys that open the Capsule when it is hidden, from anywhere (Mac-only; Windows opens
  its own panel with its own hotkey per C1w and isn't in this file).
- `panel`: keys handled while the Capsule is shown, each with the macOS virtual key code(s)
  (`keyCode`), modifiers where they matter, a `condition` when the binding only fires in a
  particular state, and the action in plain words.
- `footer_hints.states`: the footer's hint rows per state, as `CapsuleLayout.hints(_:)` chooses
  them (at most 4, left to right). A hint's `keys` are the caps the footer draws; some titles are
  conditional or templated (noted inline) because the real function reads live model state
  (whether a reply has a thread, whether a row declares a `cmd+return` action, and so on) that a
  static fixture can't fully stand in for. `SpecVectorsTests` on the Swift side checks the
  non-conditional rows exactly; the Node shape test only checks the file's structure.

## What the two test files do

- `test/capsule-spec.test.js` (Node): validates shape only — every case in route/commands/match
  has `input` and `expect`, every `strings[].id` and `keys` id is unique, every file has `v: 1`.
  It does not reimplement Route, CLIRun or Match in JavaScript; that port is the Windows team's.
- `Tests/SpecVectorsTests.swift` (Swift, marker `specVectorsSuite`): loads these same JSON files
  from the repo and asserts the real Swift implementations (`Route`, `CLIRun`, `Match`) produce
  exactly what each case expects. This is the side that proves the vectors are true today; it runs
  on GitHub Actions (`capsule-mac.yml`), never on the user's Mac.
