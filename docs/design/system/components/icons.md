---
title: Icons
summary: The one 16-grid stroke icon set, its sizes and colours, and the Vyre mark, shared by every surface.
audience: builders
owner: app-design
status: draft
---

# Icons

One set of line icons on a 16 grid, drawn in the text colour they sit in. Every icon on every
board comes from this list (`docs/design/one-app/icons.txt`); a new icon needs a design review.
Drawn on "Vyre one app, the system" and used on every board.

| Surface | Implementing file | Status |
|---|---|---|
| Deck | `deck/js/icons.js` `icon(name, size)` (main; same on work/pwa, work/chat, work/native-core) | partial |
| App | none (work/mobile) | not built |
| Capsule | SF Symbols inline in `local/capsule/native/Sources/UI/CapsuleView.swift` and others (work/capsule-pro) | not built |

## Anatomy

- `<svg viewBox="0 0 16 16">` with `fill: none; stroke: currentColor; stroke-width: 1.5;
  stroke-linecap: round; stroke-linejoin: round`. The drawing is the path data below, unchanged.
- The colour is inherited (`currentColor`): an icon is never given its own colour. It takes the
  ink of its row, button or chip (`--text`, `--text-2` or `--label`).
- Decorative by default (`aria-hidden="true"`). The control around it carries the name.

## The set

| Name | Used for | Drawing |
|---|---|---|
| now | Now page, rail | `<path d="M1.5 8h3l2-5 3 10 2-5h3"/>` |
| chat | Chats, sessions | `<path d="M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2z"/>` |
| agents | Agents place, teammates | `<circle cx="8" cy="5.5" r="2.5"/><path d="M3 13.5c.8-2.6 2.7-4 5-4s4.2 1.4 5 4"/>` |
| projects | Projects place | `<path d="M1.5 4.5v8h13v-6.5h-6.5l-1.5-1.5z"/>` |
| memory | Memory place | `<path d="M8 2l6 3-6 3-6-3z"/><path d="M2 8l6 3 6-3"/><path d="M2 11l6 3 6-3"/>` |
| vault | Vault place, locked item | `<rect x="3" y="7" width="10" height="7" rx="1.5"/><path d="M5 7V5a3 3 0 0 1 6 0v2"/>` |
| planner | Planner place | `<rect x="2" y="3" width="12" height="11" rx="1.5"/><path d="M2 6.5h12M5.5 1.5v3M10.5 1.5v3"/>` |
| devices | Devices place | `<rect x="1.5" y="3" width="9" height="7" rx="1"/><path d="M4 13h4"/><rect x="11" y="5.5" width="3.5" height="8" rx="0.8"/>` |
| settings | Settings | `<path d="M2 4.5h7M12 4.5h2M2 11.5h2M7 11.5h7"/><circle cx="10.5" cy="4.5" r="1.5"/><circle cx="5.5" cy="11.5" r="1.5"/>` |
| search | Search fields, Find | `<circle cx="7" cy="7" r="4.5"/><path d="M10.5 10.5l3.5 3.5"/>` |
| check | Done, selected row, Saved | `<path d="M3 8.5l3 3 7-7"/>` |
| x | Close, clear, remove | `<path d="M4 4l8 8M12 4l-8 8"/>` |
| failed | The failed status mark | `<circle cx="8" cy="8" r="6"/><path d="M6 6l4 4M10 6l-4 4"/>` |
| chev-r | Opens to detail, push | `<path d="M6 3.5l4.5 4.5-4.5 4.5"/>` |
| chev-l | Back | `<path d="M10 3.5l-4.5 4.5 4.5 4.5"/>` |
| chev-d | Select, menu chip | `<path d="M3.5 6l4.5 4.5 4.5-4.5"/>` |
| plus | New, add, stepper up | `<path d="M8 3v10M3 8h10"/>` |
| more | Overflow menu | `<circle cx="3.5" cy="8" r="0.8"/><circle cx="8" cy="8" r="0.8"/><circle cx="12.5" cy="8" r="0.8"/>` |
| terminal | Terminal tab, shell rows | `<rect x="1.5" y="2.5" width="13" height="11" rx="1.5"/><path d="M4.5 6l2 2-2 2M8.5 10.5h3"/>` |
| mic | Dictate, hold to talk | `<rect x="6" y="1.5" width="4" height="8" rx="2"/><path d="M3.5 7.5a4.5 4.5 0 0 0 9 0M8 12v2.5"/>` |
| send | Send, steer | `<path d="M8 13V3M4 7l4-4 4 4"/>` |
| stop | Stop a turn | `<rect x="4" y="4" width="8" height="8" rx="1.5"/>` |
| faceid | Face ID, Touch ID proof | `<path d="M2 5V3.5A1.5 1.5 0 0 1 3.5 2H5M11 2h1.5A1.5 1.5 0 0 1 14 3.5V5M14 11v1.5a1.5 1.5 0 0 1-1.5 1.5H11M5 14H3.5A1.5 1.5 0 0 1 2 12.5V11"/><path d="M5.5 6v1M10.5 6v1M8 6v3h-.8M6 10.8c1.2.9 2.8.9 4 0"/>` |
| eye | Watch, reveal, Plan first | `<path d="M1.5 8s2.5-4.5 6.5-4.5S14.5 8 14.5 8s-2.5 4.5-6.5 4.5S1.5 8 1.5 8z"/><circle cx="8" cy="8" r="2"/>` |
| hand | Take over, Asks first | `<path d="M5.5 8V3.5a1 1 0 0 1 2 0V7M7.5 7V2.5a1 1 0 0 1 2 0V7M9.5 7V3.5a1 1 0 0 1 2 0V9c0 3-1.8 5-4.3 5C5 14 4 12.7 3 11L2 9.2a1 1 0 0 1 1.7-1L5.5 10"/>` |
| clock | Time, snooze, scheduled | `<circle cx="8" cy="8" r="6"/><path d="M8 4.5V8l2.5 1.5"/>` |
| bell | Notifications | `<path d="M4 11V7a4 4 0 0 1 8 0v4l1.5 1.5h-11zM6.5 14h3"/>` |
| file | Files, Edits allowed | `<path d="M4 1.5h5l3 3v10H4z"/><path d="M9 1.5v3h3"/>` |
| key | API key, SSH key | `<circle cx="5" cy="11" r="2.5"/><path d="M6.8 9.2l6.2-6.2M11 5l2 2M9.5 6.5l1.5 1.5"/>` |
| copy | Copy | `<rect x="5" y="5" width="9" height="9" rx="1.5"/><path d="M11 5V3.5A1.5 1.5 0 0 0 9.5 2h-6A1.5 1.5 0 0 0 2 3.5v6A1.5 1.5 0 0 0 3.5 11H5"/>` |
| qr | Pair, scan | `<rect x="2" y="2" width="4.5" height="4.5" rx="0.5"/><rect x="9.5" y="2" width="4.5" height="4.5" rx="0.5"/><rect x="2" y="9.5" width="4.5" height="4.5" rx="0.5"/><path d="M9.5 9.5h2v2M14 9.5v4.5h-4.5"/>` |
| phone | A phone | `<rect x="4" y="1.5" width="8" height="13" rx="1.5"/><path d="M7 12.5h2"/>` |
| laptop | A laptop or desktop | `<rect x="3" y="3" width="10" height="7" rx="1"/><path d="M1.5 12.5h13"/>` |
| box | The box (server) | `<rect x="2" y="3" width="12" height="4" rx="1"/><rect x="2" y="9" width="12" height="4" rx="1"/><path d="M4.5 5h.5M4.5 11h.5"/>` |
| wifi-off | Offline | `<path d="M2 2l12 12M5.5 8.5a4 4 0 0 1 2.5-1M3 6a8 8 0 0 1 3-1.7M10.5 5A8 8 0 0 1 13 6.2M7 11.5a1.5 1.5 0 0 1 2 0"/>` |
| refresh | Retry, reload | `<path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9M13.5 2.5v3h-3"/>` |
| drive | VyreDrive | `<path d="M1.5 10.5l2.5-7h8l2.5 7v2h-13z"/><path d="M1.5 10.5h13M11.5 12h.5"/>` |
| link | Link, login item | `<path d="M7 9a3 3 0 0 0 4.2 0l2-2a3 3 0 0 0-4.2-4.2l-.8.8M9 7a3 3 0 0 0-4.2 0l-2 2a3 3 0 0 0 4.2 4.2l.8-.8"/>` |
| download | Download, install | `<path d="M8 2v8M4.5 6.5L8 10l3.5-3.5M2.5 13.5h11"/>` |
| share | iOS Share, export | `<path d="M8 10V1.5M5 4.5l3-3 3 3M4.5 7h-2v7h11V7h-2"/>` |
| globe | Web, fetched page | `<circle cx="8" cy="8" r="6"/><path d="M2 8h12M8 2c1.8 1.8 2.5 3.8 2.5 6S9.8 12.2 8 14M8 2C6.2 3.8 5.5 5.8 5.5 8S6.2 12.2 8 14"/>` |
| shield | The floor and the Gate | `<path d="M8 1.5l5.5 2v4c0 3.5-2.4 6-5.5 7-3.1-1-5.5-3.5-5.5-7v-4z"/>` |
| pause | Pause | `<path d="M5.5 3.5v9M10.5 3.5v9"/>` |
| play | Resume, run | `<path d="M5 3l8 5-8 5z"/>` |
| cable | USB install | `<path d="M5 1.5v4M11 1.5v4M3.5 5.5h9v3a4.5 4.5 0 0 1-9 0zM8 13v1.5"/>` |
| alarm | Alarm, reminder | `<circle cx="8" cy="9" r="5"/><path d="M8 6.5V9l1.5 1.5M2 3.5l2-2M14 3.5l-2-2"/>` |
| todo | Todo list | `<rect x="2" y="2" width="12" height="12" rx="2"/><path d="M5 8l2 2 4-4"/>` |
| minus | Stepper down (proposed: drawn on boards, not yet in icons.txt) | `<path d="M3 8h10"/>` |
| unlock | Doesn't ask (proposed: drawn on boards, not yet in icons.txt) | `<rect x="3" y="7" width="10" height="7" rx="1.5"/><path d="M5 7V5a3 3 0 0 1 5.8-1.1"/>` |

**The Vyre mark** (20 to 22): `<svg viewBox="0 0 24 24">` with a wire `<path d="M3.5 5.5L12
19.5L17.96 9.69" stroke-width="2.4">` in `--mark-wire` and a dot `<circle cx="20.5" cy="5.5"
r="2.3">` in `--mark-dot`. When anything needs you, the dot is `--beacon-dot`; when nothing does,
it goes back to `--mark-dot`. The mark is not an icon and never sits in a control.

## Sizes

| Size | Where |
|---|---|
| 12 | Inside chips, tags, status words, meta lines, chev-d on a select or menu chip |
| 16 | Default: buttons, icon buttons, rows, fields, popover rows |
| 20 | Rail buttons, empty-state tile (inside a 40 tile) |

The stroke stays 1.5 at every size. No other sizes; never scale an icon with transform.

## States

An icon has no states of its own. It follows its control: `--label` idle in a rail or field,
`--text-2` in an icon button, `--text` on hover, selected or pressed, `--primary-ink` inside a
primary button. Inside a busy button the spinner replaces the leading icon.

## Keyboard and touch

Not interactive. The 44 touch target belongs to the control (see icon-button).

## Motion

None, except chev-r, which rotates 90 degrees over `--motion-tap` when its row opens. Reduced
motion: no rotation, the open state swaps the drawing to chev-d.

## Copy

Icons never replace a word where the meaning is not obvious. A control with an icon only has an
`aria-label` in sentence case ("New session", "Dictate", "More"). Never an emoji as an icon.

## Accessibility

`aria-hidden="true"` on every decorative icon; on the web the name lives on the button. Native:
`accessibilityElementsHidden` (React Native) or `.accessibilityHidden(true)` (SwiftUI). The failed
glyph is the one exception when it stands alone: its label is "failed" (see status-mark).

## Gaps

- [ ] Deck: `icons.js` drawings differ from icons.txt for now, projects, memory, agents, vault,
  settings, search, plus, mic, send (points right, not up), file, copy, bell, clock, key.
- [ ] Deck: missing planner, devices, x (has close), failed, chev-d (has chevron), more, stop,
  faceid, eye, hand, qr, box, wifi-off, refresh, drive, link, download, share, globe, shield,
  pause, play, cable, alarm, todo, unlock.
- [ ] Deck: extra names not in the set (lock, watch, pin, mute, edit, lines, mail, branch, login,
  pass, ask): add to icons.txt through a design review or retire.
- [ ] Deck: `mark()` fills the dot with `--signal`, which the tokens no longer define; use
  `--mark-dot` and `--beacon-dot`.
- [ ] App: no icon component; build one `Icon` from this table with react-native-svg.
- [ ] Capsule: SF Symbols everywhere (xmark, chevron.down, sparkle.magnifyingglass, mic.fill);
  draw this set as SwiftUI `Shape`s from the same path data.
- [ ] System: add minus and unlock to `icons.txt`; the Vault board draws the faceid frame without
  its face, which is not in the set.
