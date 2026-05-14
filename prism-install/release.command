#!/bin/bash
# [PRISM] 2026-05-14 — Sprint 14-B: 一键发布脚本
# 功能：版本号管理 → 构建 macOS DMG → 生成 Changelog → 准备 GitHub Release
# 用法：双击此文件，或 bash prism-install/release.command

set -e
cd ~/Prism

CURRENT=$(node -p "require('./package.json').version")

echo "╔══════════════════════════════════════════╗"
echo "║  🔮 Prism Release Manager               ║"
echo "╚══════════════════════════════════════════╝"
echo ""
echo "  当前版本: v${CURRENT}"
echo ""

# ── Version bump prompt ───────────────────────────────────────────────────────
IFS='.' read -r MAJOR MINOR PATCH <<< "$CURRENT"
PATCH_NEXT=$((PATCH + 1))
MINOR_NEXT=$((MINOR + 1))

echo "  选择版本类型:"
echo "  [1] Patch  → v${MAJOR}.${MINOR}.${PATCH_NEXT}  (bugfix)"
echo "  [2] Minor  → v${MAJOR}.${MINOR_NEXT}.0          (新功能)"
echo "  [3] 保持   → v${CURRENT}              (重新打包)"
echo "  [4] 手动输入"
echo ""
read -p "  选择 [1]: " CHOICE
CHOICE=${CHOICE:-1}

case "$CHOICE" in
  1) NEW_VERSION="${MAJOR}.${MINOR}.${PATCH_NEXT}" ;;
  2) NEW_VERSION="${MAJOR}.${MINOR_NEXT}.0" ;;
  3) NEW_VERSION="$CURRENT" ;;
  4)
    read -p "  输入版本号 (例: 0.3.0): " NEW_VERSION
    ;;
  *) NEW_VERSION="${MAJOR}.${MINOR}.${PATCH_NEXT}" ;;
esac

echo ""
echo "  🏷️  新版本: v${NEW_VERSION}"
read -p "  确认? [Y/n]: " CONFIRM
CONFIRM=${CONFIRM:-Y}
[[ "$CONFIRM" =~ ^[Nn]$ ]] && { echo "已取消。"; exit 0; }

# ── Bump version in package.json ──────────────────────────────────────────────
if [ "$NEW_VERSION" != "$CURRENT" ]; then
  echo ""
  echo "▶ 更新 package.json 版本..."
  node -e "
    const fs = require('fs');
    const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
    pkg.version = '${NEW_VERSION}';
    fs.writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\n');
    console.log('  package.json → v${NEW_VERSION}');
  "
fi

# ── Generate changelog entry ──────────────────────────────────────────────────
echo ""
echo "▶ 生成 Changelog..."
DATE=$(date +%Y-%m-%d)
LOG_ENTRY="## v${NEW_VERSION} — ${DATE}

$(git log --oneline --no-merges $(git describe --tags --abbrev=0 2>/dev/null || echo HEAD~10)..HEAD 2>/dev/null | sed 's/^/- /' || echo '- Release v${NEW_VERSION}')"

CHANGELOG_FILE="CHANGELOG.md"
if [ -f "$CHANGELOG_FILE" ]; then
  echo "$LOG_ENTRY" | cat - "$CHANGELOG_FILE" > /tmp/prism_changelog_tmp && mv /tmp/prism_changelog_tmp "$CHANGELOG_FILE"
else
  echo "# Prism Changelog" > "$CHANGELOG_FILE"
  echo "" >> "$CHANGELOG_FILE"
  echo "$LOG_ENTRY" >> "$CHANGELOG_FILE"
fi
echo "  ✅ CHANGELOG.md 已更新"

# ── Build macOS DMG ───────────────────────────────────────────────────────────
ARCH=$(uname -m)
[ "$ARCH" = "arm64" ] && BUILDER_ARCH="--arm64" || BUILDER_ARCH="--x64"

echo ""
echo "▶ Step 1/2 — Building source (electron-vite)..."
NODE_TLS_REJECT_UNAUTHORIZED=0 npm_config_strict_ssl=false \
  node_modules/.bin/electron-vite build
echo "  ✅ Source built."

echo ""
echo "▶ Step 2/2 — Packaging macOS DMG + ZIP..."
NODE_TLS_REJECT_UNAUTHORIZED=0 npm_config_strict_ssl=false \
  node_modules/.bin/electron-builder --mac dmg zip $BUILDER_ARCH
echo "  ✅ Packages ready."

# ── Git tag + commit ──────────────────────────────────────────────────────────
if [ "$NEW_VERSION" != "$CURRENT" ]; then
  echo ""
  read -p "▶ 创建 git commit + tag v${NEW_VERSION}? [Y/n]: " TAG_CONFIRM
  TAG_CONFIRM=${TAG_CONFIRM:-Y}
  if [[ ! "$TAG_CONFIRM" =~ ^[Nn]$ ]]; then
    rm -f .git/index.lock
    git add package.json CHANGELOG.md
    git commit --signoff -m "chore(release): bump version to v${NEW_VERSION}

[PRISM] ${DATE} — Sprint 14-B release v${NEW_VERSION}"
    git tag -a "v${NEW_VERSION}" -m "Prism v${NEW_VERSION}"
    echo "  ✅ commit + tag v${NEW_VERSION} 已创建"
    echo "  ⬆️  推送: git push origin main --tags"
  fi
fi

# ── Summary ───────────────────────────────────────────────────────────────────
DMG=$(ls ~/Prism/dist/*.dmg 2>/dev/null | tail -1)
ZIP=$(ls ~/Prism/dist/*.zip 2>/dev/null | tail -1)

echo ""
echo "╔══════════════════════════════════════════╗"
echo "║  ✅ Release v${NEW_VERSION} ready!       ║"
echo "╚══════════════════════════════════════════╝"
[ -n "$DMG" ] && echo "  📦 DMG : $DMG"
[ -n "$ZIP" ] && echo "  🗜️  ZIP : $ZIP"
echo ""
echo "  下一步 → GitHub Release:"
echo "  gh release create v${NEW_VERSION} dist/*.dmg dist/*.zip \\"
echo "    --title 'Prism v${NEW_VERSION}' \\"
echo "    --notes-file CHANGELOG.md"
echo ""
open ~/Prism/dist/
echo "[Process completed]"
