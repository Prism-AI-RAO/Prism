// [PRISM] 2026-05-14 — Sprint 12: 用 Prism Main 统一取代 CherryClaw + CherryAssistant 双 Agent 架构
export const PRISM_MAIN_AGENT_ID = 'prism-main-default'

// Legacy IDs — kept only for migration cleanup on startup, no longer active built-in agents
export const LEGACY_CHERRY_CLAW_AGENT_ID = 'cherry-claw-default'
export const LEGACY_CHERRY_ASSISTANT_AGENT_ID = 'cherry-assistant-default'

const BUILTIN_AGENT_IDS = new Set([PRISM_MAIN_AGENT_ID])

export function isBuiltinAgentId(id: string): boolean {
  return BUILTIN_AGENT_IDS.has(id)
}
