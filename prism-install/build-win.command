#!/bin/bash
# [PRISM] 2026-05-14 — Sprint 14-B: 一键安装包 — Windows NSIS 构建脚本
# 用法：双击此文件，或 bash prism-install/build-win.command
# 注意：Windows 跨平台构建需要 Wine + Mono（见 README）
# 产物：dist/Prism-<version>-x64-setup.exe  +  portable.exe

set -e
cd ~/Prism

VERSION=$(node -p "require('./package.json').version" 2>/dev/null || echo "0.2.0")

echo "╔══════════════════════════════════════════╗"
echo "║  🔮 Prism Windows Builder  v${VERSION}   ║"
echo "╚══════════════════════════════════════════╝"
echo ""
echo "⚠️  Cross-platform Windows build from macOS requires Wine."
echo "   If Wine is not installed, run: brew install --cask wine-stable"
echo ""

# Check Wine
if ! command -v wine &>/dev/null; then
  echo "❌ Wine not found. Install with: brew install --cask wine-stable"
  echo "   Then re-run this script."
  echo "[Process completed]"
  exit 1
fi

# ── Step 1: electron-vite build ──────────────────────────────────────────────
echo "▶ Step 1/2 — Building source..."
NODE_TLS_REJECT_UNAUTHORIZED=0 npm_config_strict_ssl=false \
  node_modules/.bin/electron-vite build
echo "✅ Source built."
echo ""

# ── Step 2: electron-builder Windows ─────────────────────────────────────────
echo "▶ Step 2/2 — Packaging NSIS + Portable (x64)..."
NODE_TLS_REJECT_UNAUTHORIZED=0 npm_config_strict_ssl=false \
  node_modules/.bin/electron-builder --win nsis portable --x64
echo "✅ Package ready."
echo ""

# ── Summary ──────────────────────────────────────────────────────────────────
SETUP=$(ls ~/Prism/dist/*-setup.exe 2>/dev/null | tail -1)
PORT=$(ls ~/Prism/dist/*-portable.exe 2>/dev/null | tail -1)

echo "╔══════════════════════════════════════════╗"
echo "║  ✅ Windows build complete!              ║"
echo "╚══════════════════════════════════════════╝"
[ -n "$SETUP"  ] && echo "  🪟 Setup    : $SETUP"
[ -n "$PORT"   ] && echo "  📦 Portable : $PORT"
echo ""
open ~/Prism/dist/
echo "[Process completed]"
