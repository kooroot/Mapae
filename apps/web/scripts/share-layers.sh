#!/bin/sh
# Converts the guardian layer art (WebP, in Mapae-arcade-asset) to the PNGs the share card Worker composes:
# a Worker has no WebP decoder, and src/arcade/share/png.ts reads 8-bit RGBA PNG only. 320px is above every size the card
# draws a layer at (the largest, the head, lands at 278px). Re-run after the wardrobe art changes, then bump CARD_REVISION.
set -eu
cd "$(dirname "$0")/../public/arcade"
mkdir -p share
for src in wardrobe/*.webp guardians/charm-*.webp; do
    name=$(basename "$src" .webp)
    sips -Z 320 -s format png "$src" --out "share/$name.png" >/dev/null
done
ls share | wc -l
