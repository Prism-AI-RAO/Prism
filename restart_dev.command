#!/bin/bash
# Kill existing pnpm dev / electron processes
pkill -f "electron.*Prism" 2>/dev/null
pkill -f "vite.*prism" 2>/dev/null
sleep 1

cd /Users/raoshimin/Prism
echo "=== 重启 pnpm dev ==="
pnpm dev
