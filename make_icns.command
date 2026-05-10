#!/bin/bash
# [PRISM] 2026-05-10 — Generate icon.icns from the Prism PNG icons
# Double-click this file in Finder to run. Requires macOS iconutil.

set -e
cd /Users/raoshimin/Prism

echo "🔮 Prism — generating icon.icns..."

# Create iconset directory
ICONSET="build/Prism.iconset"
rm -rf "$ICONSET"
mkdir -p "$ICONSET"

# Source: build/icon.png (512x512 master)
# We need all the sizes in build/icons/
SRC_DIR="build/icons"

cp "$SRC_DIR/16x16.png"     "$ICONSET/icon_16x16.png"
cp "$SRC_DIR/32x32.png"     "$ICONSET/icon_16x16@2x.png"
cp "$SRC_DIR/32x32.png"     "$ICONSET/icon_32x32.png"
cp "$SRC_DIR/64x64.png"     "$ICONSET/icon_32x32@2x.png"
cp "$SRC_DIR/128x128.png"   "$ICONSET/icon_128x128.png"
cp "$SRC_DIR/256x256.png"   "$ICONSET/icon_128x128@2x.png"
cp "$SRC_DIR/256x256.png"   "$ICONSET/icon_256x256.png"
cp "$SRC_DIR/512x512.png"   "$ICONSET/icon_256x256@2x.png"
cp "$SRC_DIR/512x512.png"   "$ICONSET/icon_512x512.png"
cp "$SRC_DIR/1024x1024.png" "$ICONSET/icon_512x512@2x.png"

# Build the .icns
iconutil -c icns "$ICONSET" -o build/icon.icns

# Cleanup
rm -rf "$ICONSET"

echo ""
echo "✅ build/icon.icns generated successfully!"
echo ""
read -p "Press Enter to close..."
