#!/bin/zsh
# commit_sprint10.command
# Sprint 10 A-D + Session 25 修复：Hermes 记忆引擎融入 Prism 全系统基因
cd "$(dirname "$0")"
export PATH="/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$HOME/.local/share/pnpm:$HOME/.local/bin:$HOME/Library/pnpm:$PATH"
[ -f "$HOME/.zprofile" ] && source "$HOME/.zprofile" 2>/dev/null || true
[ -f "$HOME/.zshrc"   ] && source "$HOME/.zshrc"   2>/dev/null || true

echo "========================================"
echo "  Sprint 10: Hermes × Prism 全系统基因"
echo "========================================"

echo ""
echo "Step 1: 检查 git 状态..."
git status --short

echo ""
echo "Step 2: 暂存所有改动..."
git add \
  src/main/mcpServers/hermesMemory.ts \
  src/main/mcpServers/factory.ts \
  src/renderer/src/types/index.ts \
  src/renderer/src/store/mcp.ts \
  src/renderer/src/i18n/label.ts \
  src/renderer/src/i18n/locales/en-us.json \
  src/renderer/src/i18n/locales/zh-cn.json \
  src/renderer/src/services/PrismDreamingService.ts \
  src/main/services/agents/services/channels/ChannelMessageHandler.ts \
  src/renderer/src/aiCore/prepareParams/parameterBuilder.ts \
  resources/builtin-agents/cherry-assistant/.claude/plugins.json \
  resources/builtin-agents/cherry-assistant/.claude/skills/prism-guide \
  start_dev.command \
  commit_sprint10.command

echo ""
echo "Step 3: 提交..."
git commit -m "feat(sprint10): Hermes memory engine wired into Prism DNA

Sprint 10-A: @prism/hermes-memory global built-in MCP Server
  - src/main/mcpServers/hermesMemory.ts (new, 376 lines)
  - Tools: hermes_context_get / hermes_memory_write / hermes_memory_search
  - Auto-registered isActive:true — all Agents get memory tools on startup
  - src/renderer/src/types/index.ts: BuiltinMCPServerNames.hermesMemory
  - src/main/mcpServers/factory.ts: case hermesMemory
  - src/renderer/src/store/mcp.ts: builtinMCPServers entry
  - src/renderer/src/i18n/label.ts: hermes_memory label
  - src/renderer/src/i18n/locales/en-us.json: hermes_memory description (EN)
  - src/renderer/src/i18n/locales/zh-cn.json: hermes_memory description (ZH)

Sprint 10-B: PrismDreaming dual-write to Hermes
  - src/renderer/src/services/PrismDreamingService.ts
  - syncMemoryToHermes(): after local MEMORY.md write, notify Hermes API
  - Non-blocking (void), silent fail when Hermes offline

Sprint 10-C: Channel messages route through Hermes memory
  - src/main/services/agents/services/channels/ChannelMessageHandler.ts
  - Pre-message: getHermesChannelContext() injects user memory
  - Post-reply: writeChannelExchangeToHermes() logs exchange async

Sprint 10-D: Global system prompt injection middleware
  - src/renderer/src/aiCore/prepareParams/parameterBuilder.ts
  - fetchHermesContextForInjection(): 30s cache + 5s timeout
  - Prepends [User Memory from Hermes] to ALL agent system prompts

Fix: prism-guide replaces cherry-assistant-guide in builtin agent
  - resources/builtin-agents/cherry-assistant/.claude/plugins.json
  - resources/builtin-agents/cherry-assistant/.claude/skills/prism-guide (new)"

echo ""
echo "Step 4: Push 到 GitHub..."
git push origin main

echo ""
echo "✅ Sprint 10 已提交并推送！"
echo ""
echo "变更摘要："
echo "  10-A  @prism/hermes-memory MCP — 全 Agent 记忆工具"
echo "  10-B  PrismDreaming 双写 Hermes — 学习闭环"
echo "  10-C  Channels 记忆路由 — Telegram 等感知用户历史"
echo "  10-D  System Prompt 全局注入 — 所有对话带记忆上下文"
echo "  Fix   prism-guide 替换 cherry-assistant-guide"
echo ""
echo "按任意键关闭..."
read -k 1
