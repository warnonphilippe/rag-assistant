#!/bin/sh
# Génère build/icon.icns à partir de build/icon.svg (outils macOS : qlmanage, sips, iconutil).
set -e
cd "$(dirname "$0")"
qlmanage -t -s 1024 -o . icon.svg >/dev/null 2>&1
mv icon.svg.png icon.png
rm -rf icon.iconset && mkdir icon.iconset
for size in 16 32 128 256 512; do
  sips -z $size $size icon.png --out icon.iconset/icon_${size}x${size}.png >/dev/null
  sips -z $((size * 2)) $((size * 2)) icon.png --out icon.iconset/icon_${size}x${size}@2x.png >/dev/null
done
iconutil -c icns icon.iconset -o icon.icns
rm -rf icon.iconset icon.png
