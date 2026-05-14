#!/bin/zsh
# start_dev.command — 启动 Prism pnpm dev（Sprint 10 新版本）
cd "$(dirname "$0")"
export PATH="/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$HOME/.local/share/pnpm:$HOME/.local/bin:$HOME/Library/pnpm:$PATH"
[ -f "$HOME/.zprofile" ] && source "$HOME/.zprofile" 2>/dev/null || true
[ -f "$HOME/.zshrc"   ] && source "$HOME/.zshrc"   2>/dev/null || true

echo "========================================"
echo "  Prism Dev Mode — Sprint 10 启动中..."
echo "========================================"
echo ""
echo "目录：$(pwd)"
echo ""
echo "正在启动 pnpm dev..."
pnpm dev
