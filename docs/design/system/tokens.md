---
title: Tokens
summary: The one tokens.json and what each surface generates from it; theme overrides and the rules no theme may break.
audience: builders
owner: app-design
status: draft
---

# Tokens

One file, `lib/theme/tokens.json`, holds every value (it moved from `docs/design/one-app/` so it
ships in the package: vyred reads it at run time). Nobody edits a generated file: change the JSON
and run `npm run tokens` (`scripts/gen-tokens`). `--check` fails when an output is stale, and CI
runs it (the design workflow).

| Surface | Generated file | Read it as |
|---|---|---|
| Deck (web, PWA) | `deck/css/tokens.css` | custom properties: roles, `--radius-*`, `--size-*`/`--line-*`, `--space-0` to `--space-9`, `--control-*`, `--motion-*`, `--ease`, `--float`, `--popover`, `--sans`, `--mono` |
| App (Expo) | `apps/app/src/theme/tokens.ts` | `tokens.color.dark.text2`, `tokens.type.phone.read`, `attention(scheme, alt)` |
| Lumen (Swift) | `local/capsule/native/Sources/UI/Tokens.generated.swift` | `Tokens.dark.text2`, `Tokens.Radius.card`, `Tokens.Control.touch`, `Tokens.monoSizes` |

The generator writes a surface only when its folder exists in the tree.

**Generated, never hand written.** Every token file a surface ships is generated from the hub's
tokens: at build time from `lib/theme/tokens.json` through `gen-tokens`, and at run time from
`appearance.resolve` or `/v1/theme`. A hand-written token file, or a copy of token values in a
surface's own file, fails the design check (cohesion, ADR 0036).

## The values

- **Colour roles**, dark and paper: bg, panel, hover, rule, ruleStrong, text, text2, label,
  primaryBg, primaryHover, primaryInk, focus, signalWash, delWash, beacon, codeBg, scrim, markWire,
  markDot. The CSS names are kebab case (`--text-2`, `--rule-strong`); the attention colour is
  `--beacon-ink` and `--beacon-dot`, and a count on a badge is `--beacon-badge-ink` (the App and
  Swift read `primaryInk`, the same value). Teal is the one alternative attention colour.
- **Type**: Instrument Sans and JetBrains Mono, weights 400 and 600. Desktop steps meta 12/16,
  base 13/18, read 15/22, title 20/26, hero 28/34. Phone: read 17/24, title 22/28, the rest shared.
  In CSS the phone steps apply under 720 px automatically. Mono uses 12 or 13.
- **Space**: 0, 2, 4, 8, 12, 16, 24, 32, 48, 64 (`--space-0` to `--space-9`).
- **Radius**: chip 4, field 8, button 8 (touch 10), card 12 (phone 10), sheet 14, bubble 12, full.
- **Controls**: 28 and 32 on the desktop, 44 and 54 on touch. Nothing a finger taps is under 44.
- **Motion**: tap 120 ms, panel 220, sheet 280, text reveal 150, hold 600, undo 4000, ease
  (0.25, 0.1, 0.25, 1). Reduced motion stops shine, spin and slides; state changes still show.
- **Shadow**: `float` for sheets and Lumen, `popover` for menus. Nothing else casts a shadow.
- **Status**: the order needs you, failed, running, unread, done, each with a mark, a colour role and
  a word. The keys are a contract (see [status-mark](components/status-mark.md)).

## Themes

Themes are hub values (ADR 0035, section 3), declared and served by the appearance module:

- `appearance.theme` is the preset: `vyre` (the shipped tokens) or `<module>/<name>`. A preset
  carries both schemes. Its choices come from `appearance.presets`.
- `appearance.scheme` is `system` (follow the device), `dark` or `paper`, usually set per device.
- `appearance.tokens` is the person's own changes, a partial tokens.json merged over the preset.

A module's `themes/<name>.json` (a preset) and `appearance.tokens` are both partial tokens.json
files merged over the shipped one (ADR 0033). They may change colour roles, fonts, type, space,
radius, control, motion, shadow and popover. They may not change status, layout, icons or add keys.
The merged result must keep every rule below, or the whole file is refused and each failure is
named (`node scripts/gen-tokens --validate <file>`, or the `appearance.check` tool, which the hub
calls before it stores a value; the rules are `lib/theme`'s `applyOverride` and `check`):

- every text and ground pair the surfaces draw at AA (washes composited over their ground);
- the focus ring at 3:1 on bg and panel;
- the attention colour used by no other role;
- no text under 12, no touch target under 44, no empty font family.

Modules never override the global tokens; a module theme is only something the person can pick.

All three keys are set at account or device level; a device's value wins for that device. Surfaces
read the result for their own device from the two routes ADR 0035 names, which vyred serves by
calling `appearance.resolve { device }`: `GET /v1/theme?device=<id>` (JSON: preset, scheme, the
whole merged tokens.json, the CSS, a version and the hub's `rev`) and `GET /theme.css?device=<id>`
(the custom properties alone). The ETag is `"<rev>-<device>"`. resolve checks the merged tokens
again on every read: a stored value that no longer passes paints the preset instead and is named
under `problems`, so a bad value never paints. A surface repaints on `settings.changed` for any
`appearance.*` key, the contract; `appearance.changed` is a convenience. The old `appearance.theme` values `system`, `dark` and `paper` read as `vyre` with
that scheme for one release, and `config.theme.colors` folds in under the preset for one release.

## Retired names

These Deck names have no role in Design A. Replace them; never give them a token.

| Old name | Use instead |
|---|---|
| `--recall`, `--recall-ink` (memory's gold: `.dot.recall`, icons, "From memory") | `--text-2` for the icon or dot; a memory source is a source chip (1 px `--rule-strong`), never gold |
| `--recall-wash` (the "From memory" card fill) | no fill, or `--hover` where the card needs a ground |
| `--beacon-wash` (the violet `.needs-pill`) | no fill: the needs count is text in `--beacon-ink` (top-bar.md), or the count badge |
| `--beacon-rule` (violet rules on Needs rows) | `--rule` |

Violet stays only for "needs you": the dot, the label and the count. Gold is gone from the system.
