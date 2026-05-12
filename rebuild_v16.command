#!/bin/zsh
# Prism Rebuild v16 — unpack proxy deps (ipaddr.js / ms / es-object-atoms)
# Root cause: out/proxy/index.js runs from asar.unpacked and cannot require()
#             modules inside the asar. Fix: add 3 deps to asarUnpack.
set -e

export PATH="/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$HOME/.local/share/pnpm:$HOME/.local/bin:$HOME/Library/pnpm:$PATH"
[ -f "$HOME/.zprofile" ] && source "$HOME/.zprofile" 2>/dev/null || true
[ -f "$HOME/.zshrc" ] && source "$HOME/.zshrc" 2>/dev/null || true

cd "$(dirname "$0")"

echo "==================================================="
echo "  Prism Rebuild v16 — proxy deps unpack fix"
echo "==================================================="

# Step 1: Verify asarUnpack has the 3 proxy deps
echo ""
echo "Step 1: Verify electron-builder.yml asarUnpack..."
for pkg in "ipaddr.js" "ms" "es-object-atoms"; do
  if grep -q "node_modules/${pkg}" electron-builder.yml; then
    echo "  ✅ $pkg in asarUnpack"
  else
    echo "  ❌ $pkg MISSING from asarUnpack — aborting"
    exit 1
  fi
done

# Step 2: Kill any running Prism
echo ""
echo "Step 2: Kill existing Prism..."
pkill -f "Prism.app" 2>/dev/null && echo "  Killed" || echo "  None running"
sleep 1

# Step 3: electron-vite build
echo ""
echo "Step 3: electron-vite build..."
export NODE_OPTIONS="--max-old-space-size=4096"
pnpm exec electron-vite build 2>&1
echo "  ✅ electron-vite build done"

# Step 4: electron-builder
echo ""
echo "Step 4: electron-builder (mac arm64)..."
pnpm exec electron-builder --mac --arm64 2>&1
echo "  ✅ electron-builder done"

# Step 5: Remove quarantine
echo ""
echo "Step 5: Remove quarantine..."
xattr -rd com.apple.quarantine dist/mac-arm64/Prism.app 2>/dev/null && echo "  ✅ Done" || echo "  No quarantine"

# Step 6: Verify proxy deps are in asar.unpacked
echo ""
echo "Step 6: Verify proxy deps in asar.unpacked..."
UNPACKED="dist/mac-arm64/Prism.app/Contents/Resources/app.asar.unpacked/node_modules"
for pkg in "ipaddr.js" "ms" "es-object-atoms"; do
  if [ -d "$UNPACKED/$pkg" ]; then
    echo "  ✅ $pkg"
  else
    echo "  ❌ $pkg MISSING from asar.unpacked"
  fi
done

# Step 7: Check output size
echo ""
echo "Step 7: Output..."
ls -lh dist/mac-arm64/Prism.app 2>/dev/null
ls -lh dist/*.dmg 2>/dev/null || ls -lh dist/*arm64*.dmg 2>/dev/null || true

echo ""
echo "==================================================="
echo "  ✅ Rebuild v16 complete!"
echo "  👉 Launch Prism and test DeepSeek conversation"
echo "==================================================="
echo ""
echo "Press any key to close..."
read -k 1
