// [PRISM] 2026-05-11 — Sprint 4: Dreaming — 对话后后台记忆整合
// [PRISM] 2026-05-14 — Sprint 10-B: 升级 — 提炼的记忆同步写入 Hermes（双写闭环）
// ─────────────────────────────────────────────────────────────────────────────
// 每次 AI 响应完成后（MESSAGE_COMPLETE），对话 "进入梦境"：
//   1. 收集本 Topic 最近的消息（最多 20 条）
//   2. 请求一次轻量级 AI 推理，提取用户关键信息
//   3. 将总结追加至 ~/.prism/memory/MEMORY.md（持久化跨 Session 上下文）
//
// 设计原则：
//   - 只在 prismDreamingEnabled = true 时触发
//   - 每个 Topic 去抖动 8s（等流式输出完全结束再处理）
//   - 每个 Topic 最短间隔 5 分钟（避免短时间内多轮对话连续触发）
//   - 非阻塞：AI 调用失败不影响正常对话
//   - 无 UI 副作用：完全后台静默运行
// ─────────────────────────────────────────────────────────────────────────────

import { loggerService } from '@logger'
import store from '@renderer/store'
import { selectPrismDreamingEnabled } from '@renderer/store/memory'
import { selectMessagesForTopic } from '@renderer/store/newMessage'
import type { Message } from '@renderer/types/newMessage'
import { getMainTextContent } from '@renderer/utils/messageUtils/find'

import { fetchGenerate } from './ApiService'
import { EVENT_NAMES, EventEmitter } from './EventService'

const logger = loggerService.withContext('PrismDreamingService')

// ── Constants ─────────────────────────────────────────────────────────────────

/** Debounce delay: wait until the conversation settles before dreaming */
const DEBOUNCE_MS = 8_000

/** Minimum interval between dreams for the same topic (5 minutes) */
const MIN_DREAM_INTERVAL_MS = 5 * 60 * 1000

/** Maximum messages to include in the dreaming prompt */
const MAX_MESSAGES = 20

// ── Dreaming system prompt ────────────────────────────────────────────────────

// ── Hermes 双写函数 ───────────────────────────────────────────────────────────

const HERMES_API = 'http://localhost:8642/v1/chat/completions'
const HERMES_AUTH = 'prism-local-dev'

/**
 * [PRISM] 2026-05-14 — Sprint 10-B
 * 将提炼好的记忆推送给 Hermes，让它合并到自己的 MEMORY.md 并触发自进化。
 * 非阻塞：失败不影响本地写入。
 */
async function syncMemoryToHermes(memoryEntry: string): Promise<void> {
  try {
    const res = await fetch(HERMES_API, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${HERMES_AUTH}`
      },
      body: JSON.stringify({
        model: 'hermes-agent',
        messages: [
          {
            role: 'system',
            content:
              'You are Hermes, a memory consolidation engine. ' +
              'You receive a new memory entry extracted from a conversation. ' +
              'Acknowledge receipt with one short sentence. Do not elaborate.'
          },
          {
            role: 'user',
            content: `New memory entry from Prism Dreaming:\n\n${memoryEntry}`
          }
        ],
        max_tokens: 32,
        stream: false
      }),
      signal: AbortSignal.timeout(10_000)
    })
    if (res.ok) {
      logger.info(`[Dreaming] ✅ Hermes sync successful for entry: "${memoryEntry.slice(0, 60)}…"`)
    } else {
      logger.warn(`[Dreaming] Hermes sync HTTP ${res.status} — local write still succeeded`)
    }
  } catch (e) {
    // Hermes 离线时静默跳过，本地写入已完成
    logger.debug(`[Dreaming] Hermes sync skipped (offline or timeout): ${e instanceof Error ? e.message : String(e)}`)
  }
}

// ── Dreaming system prompt ────────────────────────────────────────────────────

const DREAMING_SYSTEM_PROMPT = `You are Prism's memory engine. Your task is to extract durable, useful facts about the USER from a conversation excerpt and write them as a concise memory entry.

Rules:
- Write in third person (e.g., "User is building...", "User prefers...", "User mentioned...")
- Focus ONLY on facts about the USER: their goals, preferences, identity, projects, skills, beliefs, habits
- Ignore assistant-side content, greetings, filler, and off-topic exchanges
- Be factual, concise, and specific — 1 to 4 sentences maximum
- If the conversation reveals NOTHING new or meaningful about the user, respond with exactly: NO_MEMORY
- Do NOT explain yourself. Just write the memory entry (or NO_MEMORY).`

// ── Internal state ────────────────────────────────────────────────────────────

/** Pending debounce timers per topicId */
const pendingTimers = new Map<string, ReturnType<typeof setTimeout>>()

/** Timestamp of last dream per topicId */
const lastDreamAt = new Map<string, number>()

/** Whether the service is currently subscribed */
let active = false

/** Unsubscribe function returned by Emittery */
let unsubscribeFn: (() => void) | null = null

// ── Message formatting ────────────────────────────────────────────────────────

/**
 * Format messages as a simple dialog string for the AI prompt.
 * Takes the last MAX_MESSAGES messages, skipping system role.
 */
function formatDialog(messages: Message[]): string {
  const relevant = messages
    .filter((m) => m.role !== 'system')
    .slice(-MAX_MESSAGES)

  if (relevant.length === 0) return ''

  return relevant
    .map((m) => {
      const role = m.role === 'user' ? 'User' : 'Assistant'
      const text = getMainTextContent(m).trim()
      if (!text) return null
      // Truncate very long messages to avoid blowing the prompt
      const truncated = text.length > 800 ? text.slice(0, 800) + '…' : text
      return `${role}: ${truncated}`
    })
    .filter(Boolean)
    .join('\n\n')
}

// ── Core dreaming logic ───────────────────────────────────────────────────────

async function triggerDreaming(topicId: string): Promise<void> {
  // 1. Check enabled flag (read from Redux store at call time)
  const enabled = selectPrismDreamingEnabled(store.getState())
  if (!enabled) {
    logger.debug(`[Dreaming] Skipping topic ${topicId.slice(0, 8)}: dreaming disabled`)
    return
  }

  // 2. Rate-limit: skip if we dreamed about this topic recently
  const lastTime = lastDreamAt.get(topicId)
  if (lastTime && Date.now() - lastTime < MIN_DREAM_INTERVAL_MS) {
    logger.debug(`[Dreaming] Skipping topic ${topicId.slice(0, 8)}: too soon (last dream ${Math.round((Date.now() - lastTime) / 1000)}s ago)`)
    return
  }

  // 3. Read messages from Redux store
  const messages = selectMessagesForTopic(store.getState(), topicId)
  if (!messages || messages.length < 2) {
    logger.debug(`[Dreaming] Skipping topic ${topicId.slice(0, 8)}: too few messages (${messages?.length ?? 0})`)
    return
  }

  const dialog = formatDialog(messages)
  if (!dialog) {
    logger.debug(`[Dreaming] Skipping topic ${topicId.slice(0, 8)}: no extractable text`)
    return
  }

  logger.info(`[Dreaming] Starting dream for topic ${topicId.slice(0, 8)} (${messages.length} msgs)`)

  try {
    // 4. Ask AI to extract user facts
    const result = await fetchGenerate({
      prompt: DREAMING_SYSTEM_PROMPT,
      content: dialog
    })

    if (!result || result.trim() === '' || result.trim().toUpperCase() === 'NO_MEMORY') {
      logger.info(`[Dreaming] Topic ${topicId.slice(0, 8)}: no new memory extracted`)
      lastDreamAt.set(topicId, Date.now())
      return
    }

    // 5. Write to MEMORY.md via IPC (本地持久化)
    const trimmed = result.trim()
    await window.api.prism.memory.appendEntry(trimmed, ['dreaming'])

    lastDreamAt.set(topicId, Date.now())
    logger.info(`[Dreaming] ✅ Memory appended for topic ${topicId.slice(0, 8)}: "${trimmed.slice(0, 80)}…"`)

    // 6. [PRISM] 2026-05-14 — Sprint 10-B: 同步写入 Hermes（双写闭环，非阻塞）
    void syncMemoryToHermes(trimmed)
  } catch (error) {
    // Non-fatal — dreaming failure must never affect the conversation
    logger.warn(`[Dreaming] Failed for topic ${topicId.slice(0, 8)}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

// ── Event handler ─────────────────────────────────────────────────────────────

function handleMessageComplete(event: { id?: string; topicId?: string; status?: string }): void {
  // Only process successful completions
  if (event.status !== 'success') return

  const topicId = event.topicId
  if (!topicId) return

  // Cancel any pending timer for this topic (debounce)
  const existing = pendingTimers.get(topicId)
  if (existing) clearTimeout(existing)

  // Schedule the dreaming task
  const timer = setTimeout(() => {
    pendingTimers.delete(topicId)
    void triggerDreaming(topicId)
  }, DEBOUNCE_MS)

  pendingTimers.set(topicId, timer)
  logger.debug(`[Dreaming] Debounce set for topic ${topicId.slice(0, 8)} (${DEBOUNCE_MS}ms)`)
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Start the Dreaming service.
 * Safe to call multiple times — will not double-subscribe.
 */
export function startDreaming(): void {
  if (active) return

  unsubscribeFn = EventEmitter.on(EVENT_NAMES.MESSAGE_COMPLETE, (event) => {
    handleMessageComplete(event as { id?: string; topicId?: string; status?: string })
  })

  active = true
  logger.info('[Dreaming] Service started — listening for MESSAGE_COMPLETE events')
}

/**
 * Stop the Dreaming service and cancel all pending timers.
 * Safe to call when not started.
 */
export function stopDreaming(): void {
  if (!active) return

  // Cancel all pending debounce timers
  for (const [topicId, timer] of pendingTimers) {
    clearTimeout(timer)
    logger.debug(`[Dreaming] Cancelled pending timer for topic ${topicId.slice(0, 8)}`)
  }
  pendingTimers.clear()

  // Unsubscribe from the event emitter
  if (unsubscribeFn) {
    unsubscribeFn()
    unsubscribeFn = null
  }

  active = false
  logger.info('[Dreaming] Service stopped')
}

/**
 * Returns whether the Dreaming service is currently active.
 */
export function isDreamingActive(): boolean {
  return active
}
