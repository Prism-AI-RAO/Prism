#!/bin/bash
# [PRISM] 2026-05-11 — Sprint 7 Hotfix v4: 物理复制 iconv-lite（绕过 pnpm symlink 问题）
cd /Users/raoshimin/Prism
rm -f .git/HEAD.lock .git/index.lock 2>/dev/null

echo "=============================="
echo "  🔮 Prism Hotfix v4 (force copy iconv-lite)"
echo "=============================="
echo ""

# Step 1: 找到 pnpm store 里 iconv-lite 的实际路径并物理复制
echo "Step 1/4: 物理复制 iconv-lite 到 node_modules（bypass pnpm symlink）..."
ICONV_SRC=$(find node_modules/.pnpm/iconv-lite@0.6.3/node_modules/iconv-lite -maxdepth 0 -type d 2>/dev/null)
if [ -z "$ICONV_SRC" ]; then
  ICONV_SRC=$(find node_modules/.pnpm -maxdepth 3 -name 'iconv-lite' -type d 2>/dev/null | head -1)
fi

if [ -z "$ICONV_SRC" ]; then
  echo "❌ iconv-lite 源目录未找到，请检查 pnpm store"
  read -n 1; exit 1
fi

echo "  源路径: $ICONV_SRC"
# 删除原来的 symlink，换成真实目录
rm -f node_modules/iconv-lite
cp -rL "$ICONV_SRC" node_modules/iconv-lite
echo "✅ iconv-lite 已物理复制到 node_modules/iconv-lite"
ls node_modules/iconv-lite/
echo ""

# Step 2: electron-vite build
echo "Step 2/4: electron-vite build..."
NODE_OPTIONS=--max-old-space-size=8000 pnpm exec electron-vite build
echo ""

# Step 3: electron-builder 打包
echo "Step 3/4: electron-builder 打包 macOS arm64..."
NODE_OPTIONS=--max-old-space-size=4096 \
  NODE_TLS_REJECT_UNAUTHORIZED=0 \
  npm_config_strict_ssl=false \
  pnpm exec electron-builder --mac --arm64 \
  --config electron-builder.yml
echo ""

# Step 4: 提交推送（.npmrc + 构建脚本）
echo "Step 4/4: 提交推送..."
git add .npmrc fix_iconv_copy_rebuild.command
git diff --cached --stat
git commit -m "fix(build): copy iconv-lite physically to bypass pnpm symlink — electron-builder pnpm compatibility" --no-verify 2>/dev/null || echo "(nothing new to commit)"
git push origin main && echo "✅ 已推送到 GitHub" || echo "⚠️ push 失败"

echo ""
echo "=============================="
echo "✅ 完成！输出文件："
ls dist/Prism-*.dmg 2>/dev/null
echo ""
echo "Press any key to close..."
read -n 1
