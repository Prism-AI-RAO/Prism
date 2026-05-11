// [PRISM] 2026-05-11 — Sprint 5: Multi-Agent 会话管理服务（renderer 侧）
// ─────────────────────────────────────────────────────────────────────────────
// 封装 window.api.openclaw.bridge.* 的会话操作：
//   - spawn(agentId, prompt?)  → 创建新 OpenClaw Agent 会话
//   - send(sessionId, msg)     → 发送消息并接收流式响应
//   - history(sessionId)       → 获取历史消息
//   - listSessions()           → 查看本地会话注册表
//
// 流式响应通过 Emittery 事件分发：
//   'delta' → { sessionId, text }  (每个流式 chunk)
//   'done'  → { sessionId }        (流结束)
//   'error' → { sessionId, error } (出错)
//
// 会话状态机：idle → sending → idle | error
// ─────────────────────────────────────────────────────────────────────────────

import { loggerService } from '@logger'
import Emittery from 'emittery'

const logger = loggerService.withContext('PrismMultiAgentService')

// ── Types ─────────────────────────────────────────────────────────────────────

export interface AgentMessage {
  role: 'user' | 'assistant'
  content: string
  ts: string
}

export interface AgentSession {
  sessionId: string
  agentId: string
  createdAt: string
  messages: AgentMessage[]
  status: 'idle' | 'sending' | 'error'
  streamingBuffer: string   // current in-progress AI response text
  lastError?: string
}

export type MultiAgentEvent =
  | { type: 'delta'; sessionId: string; text: string }
  | { type: 'done'; sessionId: string }
  | { type: 'error'; sessionId: string; error: string }
  | { type: 'session_created'; sessionId: string; agentId: string }
  | { type: 'session_updated'; sessionId: string }

// ── Internal event emitter ────────────────────────────────────────────────────

export const multiAgentEmitter = new Emittery<{
  delta: { sessionId: string; text: string }
  done: { sessionId: string }
  error: { sessionId: string; error: string }
  session_created: { sessionId: string; agentId: string }
  session_updated: { sessionId: string }
}>()

// ── Session registry ──────────────────────────────────────────────────────────

const sessions = new Map<string, AgentSession>()

/** Global streaming listener cleanup — subscribed once at module load. */
let streamListenerUnsubscribe: (() => void) | null = null

// ── Streaming listener setup ──────────────────────────────────────────────────

function ensureStreamListener(): void {
  if (streamListenerUnsubscribe) return

  streamListenerUnsubscribe = window.api.openclaw.bridge.onYieldDelta(
    ({ sessionId, delta, done }) => {
      const session = sessions.get(sessionId)
      if (!session) {
        logger.warn(`[MultiAgent] Received delta for unknown session: ${sessionId.slice(0, 8)}`)
        return
      }

      if (!done) {
        // Accumulate delta into the streaming buffer
        session.streamingBuffer += delta
        void multiAgentEmitter.emit('delta', { sessionId, text: delta })
      } else {
        // Stream complete: finalize message
        const finalContent = session.streamingBuffer.trim()
        if (finalContent) {
          session.messages.push({
            role: 'assistant',
            content: finalContent,
            ts: new Date().toISOString()
          })
        }
        session.streamingBuffer = ''
        session.status = 'idle'
        void multiAgentEmitter.emit('done', { sessionId })
        void multiAgentEmitter.emit('session_updated', { sessionId })
        logger.info(`[MultiAgent] Session ${sessionId.slice(0, 8)}: stream done (${finalContent.length} chars)`)
      }
    }
  )

  logger.info('[MultiAgent] Stream listener registered')
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Spawn a new agent session.
 * Registers it in the local session registry.
 *
 * @param agentId    The OpenClaw agent ID to talk to (e.g. 'meta', 'prism-assistant')
 * @param prompt     Optional initial system/user prompt to seed the session
 * @returns          The new sessionId
 */
export async function spawnSession(agentId: string, prompt?: string): Promise<string> {
  ensureStreamListener()

  logger.info(`[MultiAgent] Spawning session for agent: ${agentId}`)

  const result = await window.api.openclaw.bridge.sessionsSpawn(agentId, prompt)
  const { session_id: sessionId } = result

  const session: AgentSession = {
    sessionId,
    agentId,
    createdAt: new Date().toISOString(),
    messages: prompt
      ? [{ role: 'user', content: prompt, ts: new Date().toISOString() }]
      : [],
    status: 'idle',
    streamingBuffer: ''
  }

  sessions.set(sessionId, session)
  void multiAgentEmitter.emit('session_created', { sessionId, agentId })
  logger.info(`[MultiAgent] Session created: ${sessionId.slice(0, 8)} (agent: ${agentId})`)

  return sessionId
}

/**
 * Send a message to an existing session and receive a streaming response.
 * The streaming chunks are delivered via multiAgentEmitter 'delta' events.
 * Resolves when the stream is complete.
 *
 * @throws if the bridge is not connected or the session does not exist
 */
export async function sendMessage(sessionId: string, message: string): Promise<void> {
  const session = sessions.get(sessionId)
  if (!session) throw new Error(`Session not found: ${sessionId}`)
  if (session.status === 'sending') throw new Error(`Session ${sessionId.slice(0, 8)} is already sending`)

  ensureStreamListener()

  // Record user message
  session.messages.push({
    role: 'user',
    content: message,
    ts: new Date().toISOString()
  })
  session.status = 'sending'
  session.streamingBuffer = ''
  session.lastError = undefined
  void multiAgentEmitter.emit('session_updated', { sessionId })

  logger.info(`[MultiAgent] Sending to session ${sessionId.slice(0, 8)}: "${message.slice(0, 60)}"`)

  try {
    // This IPC call resolves when the full stream is done.
    // Intermediate deltas arrive via the onYieldDelta listener above.
    await window.api.openclaw.bridge.sessionsYield(sessionId, message)
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err)
    session.status = 'error'
    session.lastError = errorMsg
    session.streamingBuffer = ''
    void multiAgentEmitter.emit('error', { sessionId, error: errorMsg })
    void multiAgentEmitter.emit('session_updated', { sessionId })
    logger.warn(`[MultiAgent] Session ${sessionId.slice(0, 8)} error: ${errorMsg}`)
    throw err
  }
}

/**
 * Load message history for a session from OpenClaw (overwrites local cache).
 */
export async function loadHistory(sessionId: string): Promise<AgentMessage[]> {
  const result = await window.api.openclaw.bridge.sessionsHistory(sessionId)
  const messages: AgentMessage[] = result.messages.map((m) => ({
    role: m.role as 'user' | 'assistant',
    content: m.content,
    ts: m.ts
  }))

  const session = sessions.get(sessionId)
  if (session) {
    session.messages = messages
    void multiAgentEmitter.emit('session_updated', { sessionId })
  }

  return messages
}

/**
 * Get all locally tracked sessions (most recent first).
 */
export function listSessions(): AgentSession[] {
  return [...sessions.values()].sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
  )
}

/**
 * Get a specific session by ID.
 */
export function getSession(sessionId: string): AgentSession | undefined {
  return sessions.get(sessionId)
}

/**
 * Remove a session from the local registry.
 * (Does not close the session on the OpenClaw side — sessions are server-managed.)
 */
export function forgetSession(sessionId: string): void {
  sessions.delete(sessionId)
  logger.info(`[MultiAgent] Forgot session: ${sessionId.slice(0, 8)}`)
}

/**
 * Clear all local sessions.
 */
export function clearAllSessions(): void {
  sessions.clear()
  logger.info('[MultiAgent] All sessions cleared')
}
