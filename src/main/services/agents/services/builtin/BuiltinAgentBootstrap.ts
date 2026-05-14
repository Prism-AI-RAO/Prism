/**
 * BuiltinAgentBootstrap
 *
 * Encapsulates all startup initialization logic for built-in skills and agents.
 * [PRISM] 2026-05-14 — Sprint 12: 重构为单一 Prism Main 架构，移除 CherryClaw + CherryAssistant
 */
import { loggerService } from '@logger'
import { installBuiltinSkills } from '@main/utils/builtinSkills'

import type { BuiltinAgentInitResult } from '../AgentService'
import { agentService } from '../AgentService'
import { schedulerService } from '../SchedulerService'
import { sessionService } from '../SessionService'
import {
  LEGACY_CHERRY_ASSISTANT_AGENT_ID,
  LEGACY_CHERRY_CLAW_AGENT_ID,
  PRISM_MAIN_AGENT_ID
} from './BuiltinAgentIds'
import { provisionBuiltinAgent } from './BuiltinAgentProvisioner'

const logger = loggerService.withContext('BuiltinAgentBootstrap')
const RETRY_DELAYS_MS = [5000, 15000, 30000]
const retryAttempts = new Map<string, number>()
const retryTimers = new Map<string, NodeJS.Timeout>()

/**
 * Initialize all built-in skills and agents. Safe to call multiple times (idempotent).
 *
 * Execution order:
 *   1. cleanupLegacyAgents — remove old CherryClaw / CherryAssistant from DB
 *   2. installBuiltinSkills — install global skills (prism-guide etc.)
 *   3. initPrismMain        — create/update the single Prism Main brain agent
 */
export async function bootstrapBuiltinAgents(): Promise<void> {
  // [PRISM] 2026-05-14 — Sprint 12: 清理旧内置 Agent，迁移至 Prism Main
  await cleanupLegacyAgents()

  try {
    await installBuiltinSkills()
  } catch (error) {
    logger.error('Failed to install built-in skills', error as Error)
  }

  await initPrismMain()
}

// ── Legacy cleanup ───────────────────────────────────────────────────

/**
 * Force-remove old CherryClaw and CherryAssistant agents from the database.
 * Safe to call when they don't exist (no-ops gracefully).
 */
async function cleanupLegacyAgents(): Promise<void> {
  const legacyIds = [LEGACY_CHERRY_CLAW_AGENT_ID, LEGACY_CHERRY_ASSISTANT_AGENT_ID]
  for (const id of legacyIds) {
    try {
      const deleted = await agentService.deleteAgent(id)
      if (deleted) {
        logger.info('[PRISM] Removed legacy built-in agent', { id })
      }
    } catch (error) {
      // Agent doesn't exist or already removed — this is expected after first migration
      logger.debug('[PRISM] Legacy agent cleanup skipped (not found or already removed)', { id, error })
    }
  }
}

// ── Shared helpers ───────────────────────────────────────────────────

function clearRetry(agentId: string): void {
  const timer = retryTimers.get(agentId)
  if (timer) {
    clearTimeout(timer)
    retryTimers.delete(agentId)
  }
  retryAttempts.delete(agentId)
}

function scheduleRetry(agentId: string, label: string, initFn: () => Promise<void>): void {
  if (retryTimers.has(agentId)) {
    return
  }

  const attempt = retryAttempts.get(agentId) ?? 0
  const delay = RETRY_DELAYS_MS[attempt]
  if (delay === undefined) {
    logger.info(`Built-in ${label} bootstrap retries exhausted`, { agentId, attempts: attempt })
    return
  }

  retryAttempts.set(agentId, attempt + 1)
  logger.info(`Scheduling built-in ${label} bootstrap retry`, {
    agentId,
    attempt: attempt + 1,
    delayMs: delay
  })

  const timer = setTimeout(() => {
    retryTimers.delete(agentId)
    void initFn()
  }, delay)
  retryTimers.set(agentId, timer)
}

async function ensureDefaultSession(agentId: string, label: string): Promise<void> {
  const { total } = await sessionService.listSessions(agentId, { limit: 1 })
  if (total === 0) {
    await sessionService.createSession(agentId, {})
    logger.info(`Default session created for ${label} agent`)
  }
}

async function handleInitResult(
  agentId: string,
  label: string,
  result: BuiltinAgentInitResult,
  initFn: () => Promise<void>,
  onReady?: (resolvedAgentId: string) => Promise<void>
): Promise<void> {
  if (result.agentId) {
    clearRetry(agentId)
    await ensureDefaultSession(result.agentId, label)
    if (onReady) {
      await onReady(result.agentId)
    }
    return
  }

  if (result.skippedReason === 'deleted') {
    clearRetry(agentId)
    return
  }

  scheduleRetry(agentId, label, initFn)
}

// ── Prism Main ───────────────────────────────────────────────────────

export { PRISM_MAIN_AGENT_ID }

async function initPrismMain(): Promise<void> {
  try {
    const result = await agentService.initBuiltinAgent({
      id: PRISM_MAIN_AGENT_ID,
      builtinRole: 'main',
      agentType: 'claude-code',
      provisionWorkspace: provisionBuiltinAgent
    })
    await handleInitResult(PRISM_MAIN_AGENT_ID, 'Prism Main', result, initPrismMain, async (agentId) => {
      await schedulerService.ensureHeartbeatTask(agentId, 30)
    })
  } catch (error) {
    logger.warn('Failed to init Prism Main agent:', error as Error)
  }
}
