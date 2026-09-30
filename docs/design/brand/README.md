---
title: Vyre product icons, brand sheet
summary: The four Vyre product icons (Lumen, Drive, Vault, Memory), what each one means, the glass material, how to use and wire them, and where every export lives.
audience: builders
owner: app-design
status: draft
---

# Vyre product icons

Approved by the user on 30 Sep 2026: the recommended family. Trademark check is pending, so keep
these internal until the lead confirms.

| Product | Icon | The idea |
|---|---|---|
| Vyre Lumen | Lens | A glass lens catching one point of light on its rim. The core flips the image, as a real lens does. |
| Vyre Drive | Parcel | A glass crate with its lid lifted and light escaping. Your files are delivered and safe. |
| Vyre Vault | Keyhole | An arched slab with a keyhole that lets a little light through onto the floor. |
| Vyre Memory | Pearls | Glass pearls on a lit thread, the largest holding a glow. What Vyre keeps, and how it connects. |

| Vyre (the phone app and master) | Wire and light | The Vyre wire drawn as a glass tube ending in a bead of light. The master mark stays as it is; this is its glass form. |
| Vyre for Chrome | Window | A glass browser window with a bead of light waiting in its address bar. Bone glow only: never Chrome's logo or colours ("for Chrome" is the permitted form). |

Four silhouettes that stay apart at a glance: circle, cube, arch, diagonal necklace. The Chrome
extension adds a fifth, a window with a tab.

## Material and light (the rules that make them a family)

- **Tile.** A continuous-corner squircle (superellipse, exponent 5) filled with a deep Bone-warm
  gradient (`#2C2824` to `#0A0908`), a faint sheen from the upper left, and fine grain at 13 percent.
- **Glass.** Every object is one recipe: a translucent white fill (28 to 7 percent), a lit inner
  edge offset toward the upper left, a rim stroke that fades from bright at the top left to faint at
  the bottom right, and light from behind refracted through it (magnified, or inverted for a lens).
- **Light direction.** Upper left, always. One warm or cool glow per product, quiet:
  Lumen `#FFDFA8`, Drive `#BFDCF0`, Vault `#F3A25E`, Memory `#F4C4B4`. No product uses violet
  (violet means "needs you" in the app).
- **Camera.** Front-on, objects centred, isometric only where the object is a box.
- **Signature.** The Vyre wire-and-dot at the foot of the tile in Bone at 55 percent. Dropped below
  100 px.
- **Small sizes.** 16 to 64 px use hand-simplified art (fewer layers, bolder shapes), not scaled
  master art. Menu bar and tray glyphs are one-colour templates.

## Where things are

Everything is under `export/<product>/` where product is `lumen`, `drive`, `vault`, `memory` or `chrome`. `chrome` has only the extension set: `extension/icon-16|32|48|128.png` (16 is a hand-tuned pixel grid from `tools/chrome16.py`, 32 is its exact 2x, 128 has the 16 px transparent padding Chrome asks for), `store-512.png`, the master, glyph and lockups, and a favicon.

| Path | What |
|---|---|
| `<p>-master.svg`, `<p>-master-1024.png` | The full-detail master (squircle, transparent corners) |
| `<p>-master-square-1024.png` | Full-bleed square, opaque, for stores that round it themselves |
| `<p>-small.svg` | The hand-simplified small art |
| `<p>-template.svg` | One-colour glyph (black) |
| `macos/<Name>.icns`, `macos/<Name>.iconset/` | App icon, with the standard 824 px body and shadow at large sizes |
| `macos/menubar/<p>Template.png`, `@2x`, `@3x` | Menu bar template images (18, 36, 54 px) |
| `windows/<p>.ico` (16 to 256), `windows/png/` | App icon |
| `windows/<p>-tray-white.ico`, `-tray-black.ico` | Tray glyphs for dark and light taskbars (16 to 32 px) |
| `ios/AppIcon-1024.png`, `ios/Contents.json`, `ios/AppIcon-<n>.png` | Single-size iOS icon, plus the legacy sizes |
| `android/mipmap-*/` | `ic_launcher`, `ic_launcher_round`, adaptive `foreground` and `monochrome` per density |
| `android/drawable-nodpi/ic_launcher_background.png`, `mipmap-anydpi-v26/ic_launcher.xml` | Adaptive icon background and definition |
| `android/playstore-512.png` | Store listing |
| `web/favicon.svg`, `favicon.ico`, `favicon-16/32/48.png` | Favicons |
| `web/apple-touch-icon.png`, `icon-192.png`, `icon-512.png`, `maskable-192.png`, `maskable-512.png` | Home screen and PWA |
| `web/<p>-glyph.svg` | One-colour glyph in `currentColor`, for in-app navigation and menus |
| `lockup/<p>-lockup-dark.svg`, `-light.svg`, `@2x.png` | "Vyre Lumen" and the others, text as outlines |
| `lumen-motion.html` (this folder) | Lumen open and summon motion, running |

## Lockups

The icon at the left, then "Vyre" in a lighter weight (62 percent) and the product name at full
weight, set in Instrument Sans SemiBold, both drawn as outlines so no font is needed. Clear space
around a lockup is half the icon height. Minimum lockup height 32 px.

## Motion (Lumen)

Two moments, quiet, in the same glass. No glow pulse, no bounce, nothing loops. Running version:
`lumen-motion.html`.

- **Open** (first launch and app start, 1.6 s): the tile eases in (320 ms, scale from .94), the lens
  catches its point of light (the flare blooms from 0 at 380 ms over 260 ms), the "Vyre Lumen"
  lockup slides in 8 px and fades in (from 640 ms over 300 ms), everything fades out over the last
  300 ms.
- **Summon** (every time): the bar arrives over 220 ms (opacity and a 4 px rise). The lens glyph in
  the bar draws: ring stroked round over 260 ms from 60 ms, bead fades in at 260 ms over 160 ms.
  Dismiss is a plain fade. Reduced motion: shown at once.

## Wiring, by owner

- **capsule-pro (Lumen):** copy `export/lumen/macos/Lumen.icns` into the app bundle Resources and
  set `CFBundleIconFile` to `Lumen`. Menu bar: `export/lumen/macos/menubar/lumenTemplate*.png` as an
  `NSImage` with `isTemplate = true`. The open and summon motion is specified above.
- **native-core (Deck):** product icons and favicons from `export/<p>/web/`; nav glyphs from
  `web/<p>-glyph.svg` (uses `currentColor`). Manifest icons: `icon-192`, `icon-512`, `maskable-*`.
- **launch (setup page, site, phone apps):** favicons and lockups from `lumen/web/` and
  `lumen/lockup/`; iOS and Android sets are in each product folder, to be wired into the phone apps
  through launch. The phone app itself keeps the Vyre master icon; these are the product icons.
- **capsule-sight (Vyre for Chrome):** `export/chrome/extension/` goes into the manifest `icons` (16, 32, 48, 128) and `action.default_icon` (16 and 32). The 16 px icon is a hand-tuned pixel grid: a window with a tab and a white bead in its address bar, on a dark tile with transparent corners. If it reads poorly in the real toolbar, send the screenshot.
- **phone apps (via launch):** the Vyre app icon is `export/vyre/`: `ios/` (single 1024 plus legacy sizes), `android/` (adaptive, legacy, round, monochrome), `web/` (favicons, apple-touch, PWA and maskable). It carries no signature (it is the signature). Drive, Vault, Memory phone icons are in their own folders.
- **drive, vault, iq (now Memory):** your own surface takes `export/drive/`, `export/vault/`,
  `export/memory/`; product name on screen is "Vyre Drive", "Vyre Vault", "Vyre Memory".

## Regenerating

The generator is in `tools/`: `gen.py` (the art), `export.py` (rasters; add `chrome` as a second argument for the extension set), `post.py` (icns, ico, lockups, Android XML; also takes `chrome`), `motion.py`. It needs Google Chrome for rasterising, ImageMagick and
`iconutil`, and the lockups need `tools/text.json` (outlines of Instrument Sans, made with
opentype.js from the OFL font). Run `python3 export.py <out>` then `python3 post.py <out>`.

## Do and do not

- Do use the icon on its own tile. Do not put it on a coloured tile or recolour a product's glow.
- Do keep the light coming from the upper left. Do not flip or rotate the icon.
- Do use the template glyphs at 24 px and under. Do not scale the full-detail master below 64 px.
- Do write "Vyre Lumen", "Vyre Drive", "Vyre Vault", "Vyre Memory". Do not abbreviate.
