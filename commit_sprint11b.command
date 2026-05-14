#!/bin/zsh
# commit_sprint11b.command
# Sprint 11-B: /v1/chat/completions 多 Provider 路由（Anthropic + Ollama + new-api）
cd "$(dirname "$0")"
export PATH="/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$HOME/.local/share/pnpm:$HOME/.local/bin:$HOME/Library/pnpm:$PATH"
[ -f "$HOME/.zprofile" ] && source "$HOME/.zprofile" 2>/dev/null || true
[ -f "$HOME/.zshrc"   ] && source "$HOME/.zshrc"   2>/dev/null || true

echo "========================================"
echo "  Sprint 11-B: Prism API Server 多 Provider 路由"
echo "========================================"

echo ""
echo "Step 1: 检查 git 状态..."
git status --short

echo ""
echo "Step 2: 暂存改动..."
git add \
  src/main/apiServer/services/chat-completion.ts \
  commit_sprint11b.command

echo ""
echo "Step 3: 提交..."
git commit --signoff -m "feat(api-server): extend chat/completions to support anthropic/ollama/new-api providers

[PRISM] Sprint 11-B — 2026-05-14

Previously /v1/chat/completions only routed to openai-type providers.
Now supports all major provider types:
  - openai (unchanged)
  - anthropic: uses OpenAI-compatible endpoint + required anthropic-version header
  - ollama: OpenAI-compatible local endpoint
  - new-api: aggregator with OpenAI-compatible interface

This unifies the API surface and is a prerequisite for retiring OpenClaw.

Prism API Server defaults: host=127.0.0.1, port=23333
Full gateway: /v1/models + /v1/chat/completions + /v1/messages (Anthropic protocol)"

echo ""
echo "Step 4: 推送到 GitHub..."
git push origin v2

echo ""
echo "✅ Sprint 11-B commit 完成！"
echo ""
echo "下一步: Sprint 11-C — Agent 模型选择器 UI 统一"
