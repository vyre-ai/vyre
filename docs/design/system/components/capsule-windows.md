---
title: Capsule on Windows
summary: How the Mac Capsule's Design A translates to a native Windows panel, Mica and Acrylic, Segoe fallback fonts, the tray, system notifications and the Windows Hello prompt.
audience: builders
owner: app-design
status: draft
---

# Capsule on Windows

Same job as the [Mac Capsule](capsule-mac.md): a floating panel that opens over whatever you are
doing, answers the Needs rows, streams the assistant's reply, and works offline. Same content
model, same tools and events, same tokens. What changes is the shell: the backdrop material, the
window chrome, the fonts, the tray and how it hands off to the OS when it's not the thing on
screen. This spec assumes Tier C's shell (`docs/design/windows-plan.md`: Tauri, built directly on
`docs/design/system/components/*`, not a reimplementation). Not built; see Gaps.

| Surface | Implementing file | Status |
|---|---|---|
| Capsule (Windows) | none yet (`local/capsule-win`, Tier C, `docs/design/windows-plan.md`) | not built |

## The one call to make first: it should look like Windows and still be unmistakably Vyre

Principle 4 (`docs/design/one-app/DIRECTION.md`) is "quiet chrome, loud content." On Windows,
quiet chrome means the window material and font come from the OS; loud content means every colour
role, every card, row, button and status still comes from `tokens.json`, unchanged. The panel
should feel like it belongs on this PC (Mica, Segoe fallback, native tray, native corner
rounding) while its rows, cards and words are identical to the Mac and the Deck, because a person
who uses Vyre on both should never have to re-learn it. Nothing here re-derives the interaction
language (`docs/design/interaction.md`, binding for 0.1.1); the Windows Capsule inherits it, same
as the Mac one.

## Anatomy

Content is byte-for-byte the Mac Capsule's five rows (capsule-mac.md's Anatomy, unchanged): input
row, "Sends to," the waiting list, the streaming reply, the footer. Do not re-spec them here; this
section only covers what's different about the shell around them.

1. **Window.** Borderless (no native Windows titlebar, no min/max/close buttons; Esc and losing
   focus both close it, same as the Mac). Width 680, same as the Mac. Radius `--radius-sheet` (14)
   through DWM's rounded-corner API (`DWMWA_WINDOW_CORNER_PREFERENCE`, `DWMWCP_ROUND`), so it
   reads as one of Windows 11's own elevated surfaces (a flyout, a widget), not a stray rectangle
   with CSS-only corners cut into a square native window.
2. **Backdrop.** [Mica](https://learn.microsoft.com/en-us/windows/apps/design/style/mica)
   (`DWM_SYSTEMBACKDROP_TYPE.DWMSBT_MAINWINDOW`), not Acrylic, on the panel itself: Mica is
   Microsoft's own guidance for a persistent app-level surface (it samples the desktop wallpaper
   behind it, tinted, opaque enough to read), where Acrylic is for transient layers (flyouts,
   context menus) that sit on top of other content and go away fast. The Capsule is persistent
   while it's open, so Mica. The tray's right-click menu (below) is transient, so Acrylic there.
   `--panel` stops being a flat fill and becomes a translucent tint over Mica at the same token
   value (roughly 70% alpha; tune so every AA pair in tokens.md's contrast rules still holds
   measured against a light desktop wallpaper, the worst case). Every other colour role (rule,
   text, text2, primaryBg, signalWash, focus) stays fully opaque, unchanged: only the ground
   layer gains translucency, never text, never a status colour, never bone.
3. **Fonts.** Instrument Sans stays the brand face; the fallback stack gains the Windows system
   font ahead of the Mac-only `Helvetica Neue`: `'Instrument Sans', 'Segoe UI Variable', 'Segoe UI',
   sans-serif` (Windows 11 ships Segoe UI Variable; Windows 10 falls to Segoe UI). JetBrains Mono
   is bundled and unaffected. This only matters before the web font loads or if it fails to load;
   Instrument Sans should still be the face a person actually sees.
4. **Tray.** A system tray (notification area) icon, not a menu-bar item: the Vyre mark, its dot
   turning `--beacon-ink` the same way the Mac menu-bar item's dot does when something waits.
   Left-click (or the hotkey) opens the Capsule; right-click opens a small native-feeling context
   menu on Acrylic: "Open Capsule" with the hotkey as its accelerator, a "Needs you" line with the
   live count when non-zero (opens straight to the waiting list), a separator, "Settings," "Quit
   Vyre." Kept close to a stock Windows context menu (system font, system sizing, the accent-free
   neutral palette Windows context menus use), not reskinned in the full token set: a tray menu is
   OS chrome by principle 4, and people expect it to open with zero transition, not a panel
   animation.
5. **System notifications.** When the Capsule is closed and something new starts waiting, a native
   Windows Toast (Action Center) carries the same words the Needs row would show ("kit needs you ·
   Push q3-report," never different marketing copy), with the row's own actions inline as the
   toast's action buttons where the platform allows it (Allow once / Deny for an ask). This is a
   different thing from `toast.md`'s in-app Undo toast, which still runs inside the panel for
   optimistic actions once it's open; the system notification is only for "something happened
   while you weren't looking," and only ever a Needs-you item, never a marketing or status ping
   (the no-nagging principle applies to notifications too).

## States

Same table as capsule-mac.md (empty, something waits, row focused, streaming, offline, proof
needed, decided), unchanged. Two Windows-only additions:

| State | What shows |
|---|---|
| Transparency effects off (Windows Settings > Personalization > Colors) | the panel falls back to a fully opaque `--panel` fill, same as the Mac; Mica is a bonus, never load-bearing for legibility |
| High contrast mode | Mica and Acrylic are both skipped; the panel and tray menu use Windows' high-contrast colour set, which the OS supplies, not `tokens.json` (Windows has no Mac equivalent of this state; the Mac Capsule spec has nothing to port here) |

## Keyboard and touch

- The global hotkey opens and closes the Capsule from anywhere, mirroring Control-twice on the
  Mac. **Open question, flagged for windows to verify before committing to it**: the lead named
  Alt+Space, but Alt+Space is Windows' own reserved shortcut for the active window's system menu
  (minimize/restore/close). A global-hotkey hook (`tauri-plugin-global-shortcut`) may still catch
  it while another app is focused, but the moment the Capsule panel itself has focus, native
  Alt+Space could reopen the OS system menu on top of a borderless window that has no menu to
  show, instead of closing the Capsule. Test that exact case (Capsule open and focused, press
  Alt+Space) before shipping it as the default; if it's unreliable, Ctrl+Alt+Space or a
  user-remappable binding (Windows users already expect hotkeys to be configurable, more than Mac
  users do) is the fallback.
- ↑ ↓ move the waiting list, A allows once, D denies, ⏎ opens a draft, ⌘⏎ becomes Ctrl+⏎ (Windows
  has no Command key; every Mac-only key hint in capsule-mac.md and key-hint.md swaps ⌘ for Ctrl
  on this surface, same word order otherwise). Esc closes.
- "@" completes agents and projects, same as the Mac.

## Motion

Same tokens as the Mac (`--motion-panel` 220 open, `--motion-reveal` 150 close, paced streaming
text, Reduced Motion fades only). Windows' own "Show animations" setting (Settings >
Accessibility > Visual effects) is a second reduced-motion signal alongside `prefers-reduced-
motion`; treat it the same way.

## Copy

- Placeholder, list header, footer: identical to the Mac ("Ask juno, @ to target, or run," "Needs
  you," "Works offline · 1 queued").
- **Windows Hello**, not "Touch ID" or "fingerprint": Microsoft's own guidance is to always say
  "Windows Hello" regardless of whether the device actually verifies with a face, a fingerprint or
  a PIN, since the modality is hardware-dependent and the brand name is what's consistent. The
  Confirm-send card (capsule-mac.md's Anatomy, last item) is otherwise identical, word for word,
  with the icon and two words swapped: the Windows Hello shield glyph in place of the fingerprint
  icon, button "Send with Windows Hello" (primary) in place of "Send with Touch ID," and "Windows
  Hello covers sends for 30 min" in place of the Touch ID line. Same rule underneath (DIRECTION.md
  principle 6): only sends, posts, payments and deletes outside ask for it; allowing an ask never
  does.
- Tray menu: sentence case, no ellipsis theatre ("Settings," not "Settings..."), "Quit Vyre," never
  "Exit" (Windows convention, but "Exit" reads as an error state in this system's voice).
- Never caps labels, never "Approve?" dialogs: same rule as everywhere else in the system.

## Accessibility

- Windows Narrator, not VoiceOver: the panel is a named automation element ("Vyre Capsule"), same
  labelling contract as the Mac (the input's placeholder as its accessible name, each waiting row
  reading its full sentence). UI Automation is the target tree (the same technology
  `windows-plan.md` already anchors Tier D's screen-context work on), not MSAA.
- High contrast mode (above) is a real Windows-only accessibility requirement with no Mac
  equivalent; Tier C should not ship without it, since it's how a meaningful number of Windows
  users run their whole desktop, not an edge case.
- Every action's key stays in its accessible hint, Ctrl in place of ⌘.

## Copy the accent color question, once, so nobody wires it up by accident

Windows exposes the user's system accent colour (`GetSystemAccentColor` on the Composition API),
and Mica's tint uses it under the hood. That accent colour should influence nothing else: bone
stays the one primary action colour everywhere in Vyre (DIRECTION.md's System section, "one
accent"), on Windows exactly as on the Mac and the Deck. Don't read the system accent into
`--primary-bg`, `--focus` or any status colour; if the panel needs to feel like it's sitting on
this specific Windows desktop, that's Mica's job, not a colour swap.

## Gaps

Windows (work/windows, Tier C, not started)
- [ ] Everything above: the Windows Capsule does not exist yet. This spec exists so building it
  starts from Design A and the Mac Capsule's already-built content model, not a blank Tauri app.
- [ ] The Alt+Space hotkey conflict (Keyboard and touch, above) needs a hands-on check on a real
  Windows box before it ships as the default binding.
- [ ] Windows Hello's actual availability and API surface (Windows Hello for Business vs. consumer
  Hello, and whether a Node-native binding exists at helper-binary quality) is windows-plan.md's
  own open question under Tier D; this spec assumes it lands, not how.
