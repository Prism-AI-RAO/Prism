#!/bin/bash
# Prism dev restart script — kills existing process, clears cache, restarts

echo "🔴 Killing existing pnpm dev / Electron processes..."
pkill -f "pnpm dev" 2>/dev/null
pkill -f "Electron" 2>/dev/null
sleep 2

cd /Users/raoshimin/Prism

echo "🧹 Clearing Vite dep cache..."
rm -rf node_modules/.vite

echo "🔗 Ensuring moment symlink..."
if [ ! -e node_modules/moment ]; then
  MOMENT_PATH=$(find node_modules/.pnpm -name "moment" -type d -path "*/node_modules/moment" 2>/dev/null | head -1)
  if [ -n "$MOMENT_PATH" ]; then
    ln -sf "$MOMENT_PATH" node_modules/moment
    echo "  ✅ moment symlinked from $MOMENT_PATH"
  fi
fi

echo ""
echo "🚀 Starting pnpm dev..."
pnpm dev
