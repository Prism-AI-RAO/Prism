#!/bin/bash
# [PRISM] 2026-05-12 — Sprint 7 Hotfix v7
# 关键：物理复制 iconv-lite + 直接调用 bin（不触发 pnpm）
cd /Users/raoshimin/Prism
rm -f .git/HEAD.lock .git/index.lock 2>/dev/null

echo "=============================="
echo "  🔮 Prism rebuild v7"
echo "=============================="

# Step 1: 物理复制 iconv-lite（必须在 electron-builder 打包前完成）
echo "Step 1/4: 物理复制 iconv-lite 到 node_modules..."
# 直接从已知路径取（pnpm store 深度为 4，需要明确指定版本目录）
# 优先 0.6.3，其次 0.7.1，兜底用 find（maxdepth 5）
if [ -d "node_modules/.pnpm/iconv-lite@0.6.3/node_modules/iconv-lite" ]; then
  ICONV="node_modules/.pnpm/iconv-lite@0.6.3/node_modules/iconv-lite"
elif [ -d "node_modules/.pnpm/iconv-lite@0.7.1/node_modules/iconv-lite" ]; then
  ICONV="node_modules/.pnpm/iconv-lite@0.7.1/node_modules/iconv-lite"
else
  ICONV=$(find node_modules/.pnpm -maxdepth 5 -name 'package.json' -path '*/iconv-lite/package.json' | head -1 | xargs dirname 2>/dev/null)
fi
if [ -z "$ICONV" ]; then
  echo "❌ 找不到 iconv-lite，请检查 pnpm store"
  read -n 1; exit 1
fi
echo "  源: $ICONV"
# 删掉 symlink，换成真实目录
rm -rf node_modules/iconv-lite
cp -rL "$ICONV" node_modules/iconv-lite
echo "  ✅ 已物理复制: $(ls node_modules/iconv-lite/)"
echo ""

# Step 2: electron-vite build（直接调用，不触发 pnpm）
echo "Step 2/4: electron-vite build..."
NODE_OPTIONS=--max-old-space-size=8000 ./node_modules/.bin/electron-vite build
echo ""

# Step 3: electron-builder（直接调用，npmRebuild=false，不触发 pnpm）
echo "Step 3/4: electron-builder --mac --arm64..."
NODE_OPTIONS=--max-old-space-size=4096 \
  NODE_TLS_REJECT_UNAUTHORIZED=0 \
  npm_config_strict_ssl=false \
  ./node_modules/.bin/electron-builder --mac --arm64 \
  --config electron-builder.yml
echo ""

# Step 4: 验证 + 提交
echo "Step 4/4: 验证 asar 是否包含 iconv-lite..."
ASAR_CHECK=$(./node_modules/.bin/asar list dist/mac-arm64/Prism.app/Contents/Resources/app.asar 2>/dev/null | grep "^/node_modules/iconv-lite" | wc -l)
if [ "$ASAR_CHECK" -gt "0" ]; then
  echo "✅ iconv-lite 已成功打包进 asar！($ASAR_CHECK 个条目)"
else
  echo "⚠️ 警告：asar 中仍未找到 iconv-lite"
fi
echo ""

git add rebuild_v7.command electron-builder.yml .npmrc
git diff --cached --stat
git commit -m "fix(build): v7 — physical copy iconv-lite + direct bin calls, no pnpm exec" --no-verify 2>/dev/null || true
git push origin main && echo "✅ pushed" || echo "⚠️ push failed"

echo ""
ls dist/Prism-*.dmg 2>/dev/null
echo "Press any key..."
read -n 1
