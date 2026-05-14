#!/bin/bash
# Sprint 11-C Option B + Sprint 11-D commit script
# Double-click in Finder to run

set -e
cd "$(dirname "$0")"

echo "🔮 Prism — Committing Sprint 11-C (Option B) + Sprint 11-D..."
echo ""

# Show what will be committed
echo "📁 Files to commit:"
echo "  - src/main/services/agents/services/claudecode/index.ts (Sprint 11-C Option B)"
echo ""

git add src/main/services/agents/services/claudecode/index.ts
git add commit_sprint11c.command

git commit \
  --signoff \
  -m "feat(agents): route Agent execution through Prism API Server when running

[PRISM] Sprint 11-C Option B — 2026-05-14

When Prism API Server is active (apiServer.isRunning()), Agent execution
now routes through it via the /:provider/v1/messages endpoint instead of
connecting directly to the provider:

- ANTHROPIC_BASE_URL = http://{host}:{port}/{provider.id}
- ANTHROPIC_API_KEY  = Prism internal key (cs-sk-...)

This way the Agent SDK never holds the real provider API key.
Falls back to direct connection when API Server is not running.

Import: @main/apiServer/server (apiServer singleton)
Trigger: apiServer.isRunning() check before env construction"

echo ""
echo "✅ Sprint 11-C committed. Pushing to v2..."
git push origin v2

echo ""
echo "🎉 Done! Sprint 11-C Option B is on v2 branch."
echo "   Next: Sprint 11-D (OpenClaw Retirement Guide) — doc only, no push needed."
read -p "Press Enter to close..."
