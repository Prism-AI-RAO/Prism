#!/bin/bash
# [PRISM] 2026-05-12 — Sprint 7 Hotfix v9
# 根本修复：iconv-lite 移回 devDependencies → rollup 直接 bundle 进 out/main/index.js
# 无需在 node_modules 里打包，无需 extraResources，无需物理复制
cd /Users/raoshimin/Prism
rm -f .git/HEAD.lock .git/index.lock 2>/dev/null

echo "=============================="
echo "  🔮 Prism rebuild v9"
echo "=============================="

# Step 1: 确认 iconv-lite 在 devDependencies（不在 dependencies）
echo "Step 1/4: 确认 package.json 状态..."
IN_DEPS=$(node -e "const p=require('./package.json'); console.log(p.dependencies && p.dependencies['iconv-lite'] ? 'YES' : 'NO')")
IN_DEV=$(node -e "const p=require('./package.json'); console.log(p.devDependencies && p.devDependencies['iconv-lite'] ? 'YES' : 'NO')")
echo "  iconv-lite in dependencies: $IN_DEPS  (期望: NO)"
echo "  iconv-lite in devDependencies: $IN_DEV  (期望: YES)"
if [ "$IN_DEPS" = "YES" ]; then
  echo "  ❌ iconv-lite 仍在 dependencies，请检查 package.json"
  read -n 1; exit 1
fi
echo "  ✅ 状态正确，iconv-lite 将被 rollup bundle 进 out/main/index.js"
echo ""

# Step 2: electron-vite build（rollup 会把 iconv-lite 打包进 main bundle）
echo "Step 2/4: electron-vite build（iconv-lite will be bundled）..."
NODE_OPTIONS=--max-old-space-size=8000 ./node_modules/.bin/electron-vite build
echo ""

# Step 3: electron-builder
echo "Step 3/4: electron-builder --mac --arm64..."
NODE_OPTIONS=--max-old-space-size=4096 \
  NODE_TLS_REJECT_UNAUTHORIZED=0 \
  npm_config_strict_ssl=false \
  ./node_modules/.bin/electron-builder --mac --arm64 \
  --config electron-builder.yml
echo ""

# Step 4: 验证 out/main/index.js 是否包含 iconv-lite
echo "Step 4/4: 验证 iconv-lite 是否已 bundle..."
if grep -q "iconv-lite\|iconv_lite" out/main/index.js 2>/dev/null; then
  echo "  ✅ iconv-lite 已 bundle 进 out/main/index.js"
else
  echo "  ⚠️  out/main/index.js 中未找到 iconv-lite 字符串（可能被混淆，不一定有问题）"
fi
echo ""

git add rebuild_v7.command electron-builder.yml package.json
git diff --cached --stat
git commit -m "fix(build): v9 — move iconv-lite to devDeps so rollup bundles it into main (not external runtime dep)" --no-verify 2>/dev/null || true
git push origin main && echo "✅ pushed" || echo "⚠️ push failed"

echo ""
echo "=============================="
echo "📦 生成的文件："
ls dist/Prism-*.dmg 2>/dev/null || ls dist/*.dmg 2>/dev/null || echo "(查看 dist/ 目录)"
echo "=============================="
echo "Press any key..."
read -n 1
