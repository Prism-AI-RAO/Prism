#!/bin/bash
cd /Users/raoshimin/Prism
echo "🚀 git push..."
git push origin main
if [ $? -eq 0 ]; then
    echo ""
    echo "🎉 Push 成功！Sprint 0 已推送到 GitHub。"
else
    echo "❌ 仍然失败，请确认 SSH 公钥已添加到 https://github.com/settings/keys"
fi
echo ""
read -p "按 Enter 关闭..."
