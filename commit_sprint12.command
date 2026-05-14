#!/bin/bash
cd "$(dirname "$0")"

echo "=== Sprint 12 Commit: Prism Main 单脑架构 ==="
git add \
  src/main/services/agents/services/builtin/BuiltinAgentIds.ts \
  src/main/services/agents/services/builtin/BuiltinAgentBootstrap.ts \
  src/main/services/agents/services/builtin/BuiltinAgentProvisioner.ts \
  src/main/services/agents/services/AgentService.ts \
  resources/builtin-agents/prism-main/agent.json \
  resources/builtin-agents/prism-main/.claude/plugins.json \
  commit_sprint12.command

git commit --signoff -m "feat(agents): replace dual built-in agents with single Prism Main brain

[PRISM] Sprint 12 — 2026-05-14

BREAKING CHANGE: CherryClaw (cherry-claw-default) and CherryAssistant
(cherry-assistant-default) are retired. Prism Main (prism-main-default)
is now the sole built-in Agent — the central brain of the Prism system.

Changes:
- BuiltinAgentIds: add PRISM_MAIN_AGENT_ID, keep LEGACY_* for cleanup
- BuiltinAgentBootstrap: cleanupLegacyAgents() + initPrismMain() with heartbeat
- BuiltinAgentProvisioner: add 'main' -> 'prism-main' role mapping
- AgentService: DEFAULT_AGENT_ID = PRISM_MAIN_AGENT_ID
- resources/builtin-agents/prism-main/: bilingual System Prompt + 4 skills"

git push origin v2
echo ""
echo "✅ Sprint 12 pushed to v2"
