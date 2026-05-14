#!/bin/bash
cd "$(dirname "$0")"

echo "=== Sprint 13 Commit: Prism Main 总控能力升级 ==="
git add \
  resources/builtin-agents/prism-main/agent.json \
  resources/builtin-agents/prism-main/.claude/skills/prism-control/SKILL.md \
  resources/builtin-agents/prism-main/.claude/plugins.json \
  commit_sprint13.command

git commit --signoff -m "feat(agents): Sprint 13 — Prism Main total control upgrade

[PRISM] 2026-05-14 — Sprint 13

Upgrade Prism Main from a dev assistant to a true system control brain:

- agent.json: Expand System Prompt with 8-section structure
  - Total control authority declaration (bypassPermissions)
  - Full self-knowledge: tools / skills / API / memory layers
  - Agent creation capability with standard workflow
  - System omniscience: all services, data paths, source paths
- prism-control skill: Complete operational manual
  - Full Prism API reference (CRUD for agents, sessions, messages)
  - New Agent creation decision framework
  - System diagnostics checklist
  - Skills management reference
- plugins.json: Register prism-control as 5th skill"

git push origin v2
echo ""
echo "✅ Sprint 13 pushed to v2"
