#!/bin/bash
# [PRISM] Sprint 0 注释语法修复 — 提交脚本
cd /Users/raoshimin/Prism

echo "🔧 Prism — 修复 [PRISM] 注释语法问题..."

rm -f .git/index.lock
git config user.email "matrix.sunmoon@gmail.com"
git config user.name "RAO"

git add -A

git commit -m "fix: [PRISM] 修复 Sprint 0 品牌替换中注释位置错误导致的语法报错

修复文件（共 7 处）：
- src/main/index.ts: productName 逗号、setAppUserModelId 闭括号
- src/main/services/MCPService.ts: Client 构造函数 version/capabilities 被注释
- src/main/apiServer/app.ts: name 属性逗号
- src/main/services/mcp/oauth/provider.ts: clientName 逗号
- src/main/services/agents/services/claudecode/index.ts: 数组元素逗号
- src/renderer/src/services/KnowledgeService.ts: if 条件闭括号和块起始花括号

问题根源：Sprint 0 品牌替换时，[PRISM] 注释插入位置错误，
导致 rolldown-vite 编译时将代码标记吞入注释。

Signed-off-by: RAO <matrix.sunmoon@gmail.com>"

echo ""
echo "✅ Committed! Pushing..."
git push origin main

if [ $? -eq 0 ]; then
    echo ""
    echo "🎉 Hotfix 已推送到 GitHub！"
else
    echo "❌ Push 失败，请检查网络或 SSH 配置"
fi

echo ""
read -p "按 Enter 关闭..."
