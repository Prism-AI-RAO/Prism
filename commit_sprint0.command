#!/bin/bash
# [PRISM] Sprint 0 Day 2 — Git commit script
# Double-click this file in Finder to run

cd /Users/raoshimin/Prism

echo "🔮 Prism — committing Sprint 0 Day 2 brand replacement..."

# Remove stale lock file if exists
rm -f .git/index.lock

git config user.email "matrix.sunmoon@gmail.com"
git config user.name "RAO"

git add -A

git commit -m "feat: [PRISM] Sprint 0 Day 2 — brand replacement + Prism icon set

- package.json: name, version 0.1.0, description, author
- electron-builder.yml: productName, appId, protocol scheme
- HTML titles: Prism / Prism Quick Assistant / Prism Selection*
- i18n: all 12 locale files, Cherry Studio → Prism
- env.ts: APP_NAME = 'Prism'
- src/main/index.ts: productName, AUMID, Linux window class
- HTTP headers: X-Title, User-Agent, APP all → Prism
- GitHub URLs: all → github.com/Prism-AI-RAO/Prism
- AboutSettings, AppMenuService, WelcomePage: brand links
- MCPService, TrayService, BackupManager, drizzle.config: Prism
- ErrorDiagnosisService, NodeTraceService, WebviewService: Prism
- BackupManager: backward-compatible restore (Cherry Studio + Prism)
- Dexie('CherryStudio') intentionally preserved (IndexedDB key)

Signed-off-by: RAO <matrix.sunmoon@gmail.com>"

echo ""
echo "✅ Committed! Pushing to GitHub..."

git push origin main

echo ""
echo "🎉 Sprint 0 Day 2 brand replacement pushed to GitHub."
echo ""
read -p "Press Enter to close..."
