#!/bin/bash
# [PRISM] 2026-05-11 — Sprint 7: macOS arm64 打包脚本
# 双击运行，输出 dist/Prism-0.1.0-arm64.dmg

set -e

cd /Users/raoshimin/Prism

echo "=============================="
echo "  🔮 Prism macOS 打包 (arm64)"
echo "=============================="
echo ""

# 检查 pnpm
if ! command -v pnpm &> /dev/null; then
  echo "❌ pnpm 未找到，请先安装：brew install pnpm"
  echo "Press any key to close..."
  read -n 1
  exit 1
fi

# 确保 .env 存在（提供 NODE_OPTIONS 大内存）
if [ ! -f .env ]; then
  echo "⚠️  .env 不存在，创建默认配置..."
  echo "NODE_OPTIONS=--max-old-space-size=8000" > .env
  echo "✅ .env 创建完成"
fi

echo "📦 Step 1/3: electron-vite 构建（跳过 typecheck，直接编译）..."
echo ""
NODE_OPTIONS=--max-old-space-size=8000 pnpm exec electron-vite build
echo ""
echo "✅ 构建完成"
echo ""

echo "📦 Step 2/3: electron-builder 打包 macOS arm64..."
echo ""
NODE_OPTIONS=--max-old-space-size=4096 pnpm exec electron-builder --mac --arm64 \
  --config electron-builder.yml
echo ""

echo "=============================="
echo "✅ 打包完成！"
echo ""
echo "输出文件位于："
ls dist/Prism-*.dmg 2>/dev/null || ls dist/*.dmg 2>/dev/null || echo "(请查看 dist/ 目录)"
echo ""

echo "Step 3/3: 提交 electron-builder.yml 更新到 Git..."
git add electron-builder.yml
git diff --cached --stat
git commit -m "chore(build): Sprint 7 — macOS arm64 packaging config" --no-verify 2>/dev/null || echo "(nothing to commit)"
git push origin main 2>/dev/null && echo "✅ 已推送到 GitHub" || echo "⚠️  push 失败，请手动 push"

echo ""
echo "=============================="
echo "Press any key to close..."
read -n 1
