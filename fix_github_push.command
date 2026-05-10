#!/bin/bash
# [PRISM] 2026-05-10 — 修复 GitHub push 认证：切换到 SSH remote
# Double-click in Finder to run

cd /Users/raoshimin/Prism

echo "🔧 Prism — 修复 GitHub push 认证..."
echo ""

# 检查当前 remote
echo "当前 remote 配置："
git remote -v
echo ""

# 切换为 SSH remote
git remote set-url origin git@github.com:Prism-AI-RAO/Prism.git

echo "已切换为 SSH remote："
git remote -v
echo ""

# 检查是否有 SSH key
if [ -f ~/.ssh/id_ed25519.pub ] || [ -f ~/.ssh/id_rsa.pub ]; then
    echo "✅ 找到已有 SSH 公钥："
    if [ -f ~/.ssh/id_ed25519.pub ]; then
        cat ~/.ssh/id_ed25519.pub
    else
        cat ~/.ssh/id_rsa.pub
    fi
    echo ""
    echo "请确认此公钥已添加到 GitHub："
    echo "→ https://github.com/settings/keys"
    echo ""
else
    echo "⚠️  未找到 SSH 公钥，正在生成..."
    ssh-keygen -t ed25519 -C "matrix.sunmoon@gmail.com" -f ~/.ssh/id_ed25519 -N ""
    echo ""
    echo "✅ 已生成 SSH 公钥，请将以下内容添加到 GitHub："
    echo "→ https://github.com/settings/keys （点 New SSH key）"
    echo ""
    cat ~/.ssh/id_ed25519.pub
    echo ""
    # 复制到剪贴板
    cat ~/.ssh/id_ed25519.pub | pbcopy
    echo "（公钥已复制到剪贴板 📋）"
    echo ""
fi

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "完成以上操作后，按 Enter 执行 git push..."
read

# 测试 SSH 连接
echo "测试 GitHub SSH 连接..."
ssh -T git@github.com 2>&1
echo ""

# Push
echo "执行 git push..."
git push origin main

if [ $? -eq 0 ]; then
    echo ""
    echo "🎉 Push 成功！Sprint 0 代码已推送到 GitHub。"
else
    echo ""
    echo "❌ Push 仍然失败。请检查 SSH 公钥是否已添加到 GitHub Settings → SSH Keys"
fi

echo ""
read -p "按 Enter 关闭..."
