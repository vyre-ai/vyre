#!/bin/bash
# How the desk pictures in this folder were drawn (ImageMagick 7, run once by hand; the PNGs are what ships, nothing is drawn at image build). Needs no network.
set -e
OUT=${1:-out}; T="$OUT/tmp"; mkdir -p "$OUT" "$T"
S=448; R=104
mask() { magick -size ${S}x${S} xc:none -fill white -draw "roundrectangle 0,0 $((S-1)),$((S-1)) $R,$R" "$T/mask.png"; }
mask
tile() { # name top bottom : a rounded square with a vertical gradient, a soft top sheen and a thin rim
  magick -size ${S}x${S} gradient:"$2-$3" "$T/g.png"
  magick "$T/g.png" -alpha set \( -size ${S}x240 gradient:'rgba(255,255,255,0.24)-rgba(255,255,255,0)' -background none -extent ${S}x${S} \) -compose over -composite \
    \( -size ${S}x${S} xc:none -fill none -stroke 'rgba(255,255,255,0.20)' -strokewidth 6 -draw "roundrectangle 3,3 $((S-4)),$((S-4)) $((R-3)),$((R-3))" \) -composite \
    "$T/mask.png" -compose DstIn -composite "$T/$1.tile.png"
}
clip() { # layer : keep only what is inside the tile
  magick "$1" "$T/mask.png" -alpha off -compose CopyOpacity -composite -compose over "$1" 2>/dev/null || true
}
done_() { # name : the 2x master and the three sizes the dock uses (56 resting, 62 beside the pointer, 68 under it)
  mkdir -p "$OUT/dock"
  magick "$1" -filter Lanczos -depth 8 -resize 112x112 "$OUT/dock/$2-112.png"
  for n in 56 62 68; do magick "$1" -filter Lanczos -depth 8 -resize ${n}x${n} "$OUT/dock/$2-$n.png"; done
}

# Browser: a navy tile with a colour globe (original, not any browser's logo)
tile browser '#27407A' '#0B1429'
magick -size 330x330 gradient:'#7BDCFF-#2A6BEA' \( -size 330x330 xc:black -fill white -draw "circle 165,165 165,1" \) -alpha off -compose CopyOpacity -composite "$T/globe.png"
magick -size 330x330 xc:none -fill '#52DB92' \
  -draw "polygon 62,78 118,44 176,66 166,112 206,140 168,190 112,172 70,142" \
  -draw "polygon 214,176 262,150 300,196 272,262 222,248" \
  -draw "polygon 206,50 252,46 282,84 244,104 214,88" \
  -fill none -stroke 'rgba(255,255,255,0.5)' -strokewidth 6 -draw "ellipse 165,165 72,164 0,360" -draw "ellipse 165,165 164,70 0,360" -draw "line 0,165 330,165" -draw "line 165,0 165,330" \
  "$T/land.png"
magick "$T/globe.png" "$T/land.png" -compose over -composite \( -size 330x330 xc:black -fill white -draw "circle 165,165 165,2" \) -alpha off -compose CopyOpacity -composite \
  \( -size 330x330 xc:none -fill none -stroke 'rgba(255,255,255,0.42)' -strokewidth 7 -draw "circle 165,165 165,5" \) -compose over -composite \
  \( -size 330x330 xc:none -fill 'rgba(255,255,255,0.30)' -draw "ellipse 120,86 78,38 -25,335" -blur 0x10 \) -compose over -composite "$T/globe2.png"
magick "$T/browser.tile.png" "$T/globe2.png" -gravity center -geometry +0+0 -compose over -composite "$T/browser.png"
done_ "$T/browser.png" browser

# Terminal: near-black tile, a pale chevron and a warm cursor
tile terminal '#3A3733' '#100F0E'
magick "$T/terminal.tile.png" -fill none -stroke '#F1EEE6' -strokewidth 36 -draw "stroke-linecap round stroke-linejoin round polyline 118,152 204,224 118,296" \
  -stroke '#FFDFA8' -strokewidth 36 -draw "stroke-linecap round line 244,300 340,300" "$T/terminal.png"
done_ "$T/terminal.png" terminal

# Files: a pale sky tile with a blue folder
tile files '#F1F7FF' '#C4D9F7'
magick -size ${S}x${S} xc:none -fill '#2A62D6' -draw "roundrectangle 66,112 224,262 30,30" -draw "roundrectangle 66,150 382,352 32,32" "$T/folder-back.png"
magick -size 316x202 gradient:'#7FC0FF-#2F78EA' \( -size 316x202 xc:black -fill white -draw "roundrectangle 0,0 315,201 32,32" \) -alpha off -compose CopyOpacity -composite \
  \( -size 316x202 xc:none -fill none -stroke 'rgba(255,255,255,0.45)' -strokewidth 5 -draw "roundrectangle 3,3 312,198 30,30" \) -compose over -composite "$T/folder-front.png"
magick "$T/files.tile.png" -fill '#1F4FB8' -draw "roundrectangle 66,112 224,262 30,30" \
   \( "$T/folder-front.png" \) -geometry +66+168 -compose over -composite "$T/files.png"
# the folder's back panel peeks above the front
magick "$T/files.tile.png" \( -size ${S}x${S} xc:none -fill '#2155C8' -draw "roundrectangle 66,112 218,250 28,28" -draw "roundrectangle 66,146 382,330 30,30" \) -compose over -composite "$T/folder-front.png" -geometry +66+160 -compose over -composite "$T/files.png"
done_ "$T/files.png" files

# The clean Vyre mark (the V and its bead, no card, no folded corner: docs/design/brand/export/vyre/web/vyre-glyph.svg's shapes), 1024 square on transparent, for the wallpaper
magick -size 1024x1024 xc:black -fill white -stroke white -strokewidth 112 -draw "stroke-linecap round stroke-linejoin round fill none path 'M256,330 L496,720 L634,490'" "$T/v.mask.png"
magick -size 1024x1024 gradient:'#FAF7F0-#A9A296' "$T/v.mask.png" -alpha off -compose CopyOpacity -composite "$T/v.png"
magick -size 1024x1024 xc:black -fill white -draw "circle 736,320 736,224" -alpha off "$T/bead.mask.png"
magick -size 1024x1024 xc:none \( -size 1024x1024 xc:none -fill '#FFDFA8' -draw "circle 736,320 736,200" -blur 0x60 -channel A -evaluate multiply 0.55 +channel \) -compose over -composite \
  \( -size 1024x1024 radial-gradient:'#FFFFFF-#FFDFA8' "$T/bead.mask.png" -alpha off -compose CopyOpacity -composite \) -compose over -composite "$T/bead.png"
magick "$T/v.png" \( -size 1024x1024 xc:none -fill none -stroke 'rgba(255,255,255,0.0)' \) -compose over -composite "$T/bead.png" -compose over -composite -trim +repage -bordercolor none -border 70 -depth 8 "$OUT/vyre-mark.png"

# The dock's glass: 276 x 84, a frosted bar over the dark wallpaper (opaque, drawn for the colour behind it), a bright top edge, a soft rim and a darker lower edge
W=276; H=84; RR=26
mkdir -p "$OUT"
magick -size $((W*4))x$((H*4)) gradient:'#47443F-#24221F' -alpha set \
  \( -size $((W*4))x$((H*4)) xc:none -fill none -stroke 'rgba(255,255,255,0.30)' -strokewidth 5 -draw "roundrectangle 4,4 $((W*4-5)),$((H*4-5)) $((RR*4-4)),$((RR*4-4))" \) -compose over -composite \
  \( -size $((W*4))x$((H*4)) xc:none -fill none -stroke 'rgba(255,255,255,0.28)' -strokewidth 4 -draw "line $((RR*4)),9 $((W*4-RR*4)),9" -blur 0x1.5 \) -compose over -composite \
  \( -size $((W*4))x$((H*4)) xc:none -fill none -stroke 'rgba(0,0,0,0.30)' -strokewidth 8 -draw "roundrectangle 12,12 $((W*4-13)),$((H*4-13)) $((RR*4-8)),$((RR*4-8))" -blur 0x2 \) -compose over -composite \
  -filter Lanczos -resize ${W}x${H} \
  \( -size ${W}x${H} xc:none -fill white -draw "roundrectangle 0,0 $((W-1)),$((H-1)) $RR,$RR" \) -compose DstIn -composite -background '#0E0D0C' -compose over -flatten -depth 8 "$OUT/dock/panel.png"
