#!/bin/bash
# [PRISM] Sprint 2 — Hermes 记忆层集成提交脚本
cd /Users/raoshimin/Prism

echo "🔮 Prism — Sprint 2: Hermes 记忆层集成..."

rm -f .git/index.lock
git config user.email "matrix.sunmoon@gmail.com"
git config user.name "RAO"

git add -A

git commit -m "feat: [PRISM] Sprint 2 — Hermes 记忆层集成（@prism/memory MCP 服务器）

核心改动：
- 新增 src/main/mcpServers/prismMemory.ts
  → PrismMemoryServer：内置 MCP 服务器，基于 MemoryService（SQLite + 向量）
  → 5 个 Hermes 风格工具：prism_memory_add / search / list / delete / clear
  → AI 助手可跨会话存储和检索用户记忆

- 注册到内置 MCP 系统：
  → src/renderer/src/types/index.ts：BuiltinMCPServerNames 添加 prismMemory
  → src/main/mcpServers/factory.ts：工厂函数注册
  → src/renderer/src/store/mcp.ts：builtinMCPServers 列表，isActive: true（默认启用）
  → src/renderer/src/i18n/label.ts：i18n 标签映射

- i18n 支持：
  → en-us.json / zh-cn.json：添加 prism_memory 描述文案

技术细节：
- 复用 MemoryService 单例（已有 libsql/SQLite + 可选向量嵌入）
- 用户 ID 域：prism-default-user（单用户应用，可扩展）
- InMemoryTransport（进程内，零网络开销）
- 幂等注册：initializeMCPServers 自动跳过已注册的服务器

Signed-off-by: RAO <matrix.sunmoon@gmail.com>"

echo ""
echo "✅ Committed! Pushing..."
git push origin main

if [ $? -eq 0 ]; then
    echo ""
    echo "🎉 Sprint 2 已推送到 GitHub！"
    echo ""
    echo "下一步：Settings > MCP 服务器 → 可看到 @prism/memory 已自动启用"
    echo "AI 助手现在可以使用 prism_memory_* 工具跨会话记住你的信息！"
else
    echo "❌ Push 失败，请检查网络或 SSH 配置"
fi

echo ""
read -p "按 Enter 关闭..."
