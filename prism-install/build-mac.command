#!/bin/bash
# [PRISM] 2026-05-14 — Sprint 14-B: 一键安装包 — macOS DMG 构建脚本
# 用法：双击此文件，或 bash prism-install/build-mac.command
# 产物：dist/Prism-<version>-arm64.dmg  (+ .zip)

set -e
cd ~/Prism

VERSION=$(node -p "require('./package.json').version" 2>/dev/null || echo "0.2.0")
ARCH=$(uname -m)
[ "$ARCH" = "arm64" ] && BUILDER_ARCH="--arm64" || BUILDER_ARCH="--x64"

echo "╔══════════════════════════════════════════╗"
echo "║  🔮 Prism macOS Builder  v${VERSION}      ║"
echo "╚══════════════════════════════════════════╝"
echo "  Arch  : $ARCH"
echo "  Output : dist/Prism-${VERSION}-${ARCH}.dmg"
echo ""

# ── Step 1: electron-vite build ──────────────────────────────────────────────
echo "▶ Step 1/2 — Building source..."
NODE_TLS_REJECT_UNAUTHORIZED=0 npm_config_strict_ssl=false \
  node_modules/.bin/electron-vite build
echo "✅ Source built."
echo ""

# ── Step 2: electron-builder DMG + ZIP ───────────────────────────────────────
echo "▶ Step 2/2 — Packaging DMG + ZIP ($ARCH)..."
NODE_TLS_REJECT_UNAUTHORIZED=0 npm_config_strict_ssl=false \
  node_modules/.bin/electron-builder --mac dmg zip $BUILDER_ARCH
echo "✅ Package ready."
echo ""

# ── Summary ──────────────────────────────────────────────────────────────────
DMG=$(ls ~/Prism/dist/*.dmg 2>/dev/null | tail -1)
ZIP=$(ls ~/Prism/dist/*.zip 2>/dev/null | tail -1)

echo "╔══════════════════════════════════════════╗"
echo "║  ✅ macOS build complete!                ║"
echo "╚══════════════════════════════════════════╝"
[ -n "$DMG" ] && echo "  📦 DMG : $DMG"
[ -n "$ZIP" ] && echo "  🗜️  ZIP : $ZIP"
echo ""
open ~/Prism/dist/
echo "[Process completed]"
