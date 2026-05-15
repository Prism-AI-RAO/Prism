// [PRISM2] 2026-05-15 — PrismNativeService 主入口
// prism-native agentType：Prism 2 自主 Agent 执行引擎
// 遵循 generic agent 的 ReadableStream 模式，与 SessionMessageService 无缝集成

import { randomUUID } from 'node:crypto'

import { loggerService } from '@logger'
import type { GetAgentSessionResponse } from '@types'
import type { TextStreamPart } from 'ai'

import { agentMessageRepository } from '../../repositories'
import { extractTextFromBlocks, parseModel, runAgenticLoop } from './agentic-loop'

const logger = loggerService.withContext('PrismNativeService')

// ── Hermes 记忆注入（修复超时 bug）──────────────────────────────────
const HERMES_TIMEOUT_MS = 5000

/**
 * 带超时保护的 Hermes 上下文获取。
 * 超时 → 返回 null，agent 照常工作（无记忆增强），不 hang。
 */
async function getHermesContextSafe(_sessionId: string): Promise<string | null> {
  // [PRISM2 P1] 实现 Hermes hermes_context_get 调用（5s AbortController 超时）
  // 当前 P0：直接返回 null，避免超时 hang
  return await Promise.race([
    Promise.resolve(null), // placeholder — P1 替换为真实 Hermes 调用
    new Promise<null>((resolve) => setTimeout(() => resolve(null), HERMES_TIMEOUT_MS))
  ])
}

// ── 主函数：与 startGenericAgentStream 相同的签名 ──────────────────

/**
 * prism-native agentType 的流式处理函数。
 * 返回 ReadableStream<TextStreamPart>，由 SessionMessageService 直接消费。
 *
 * 调用方式（SessionMessageService 内添加）：
 *   if (session.agent_type === 'prism-native') {
 *     return await startPrismNativeAgentStream(session, req, abortController, agentSessionId, options)
 *   }
 */
export async function startPrismNativeAgentStream(
  session: GetAgentSessionResponse,
  req: { content: string; [key: string]: any },
  abortController: AbortController,
  _agentSessionId: string | undefined,
  _options?: { persist?: boolean; displayContent?: string }
): Promise<ReadableStream<TextStreamPart<Record<string, any>>>> {
  const { providerId, modelId } = parseModel(session.model)
  const systemPrompt = (session.instructions as string | undefined) || 'You are a helpful assistant.'

  logger.info('[PRISM2] startPrismNativeAgentStream', {
    sessionId: session.id,
    model: `${providerId}:${modelId}`
  })

  // ── 构建初始消息数组 ────────────────────────────────────────────
  const history = await agentMessageRepository.getSessionHistory(session.id)

  const messages: Array<{ role: string; content: any }> = []

  // Hermes 记忆上下文注入（带超时保护）
  const hermesCtx = await getHermesContextSafe(session.id)
  const finalSystemPrompt = hermesCtx
    ? `${systemPrompt}\n\n---\n## Memory Context\n${hermesCtx}`
    : systemPrompt

  messages.push({ role: 'system', content: finalSystemPrompt })

  for (const msg of history) {
    const text = extractTextFromBlocks(msg.blocks as Array<{ type: string; content?: string }>)
    if (text) {
      messages.push({ role: msg.message.role === 'user' ? 'user' : 'assistant', content: text })
    }
  }
  messages.push({ role: 'user', content: req.content })

  // ── 构建 ReadableStream（非阻塞，与 generic 相同模式）──────────
  const textBlockId = randomUUID()
  let resolveStream!: () => void
  let rejectStream!: (err: unknown) => void
  const streamDone = new Promise<void>((res, rej) => {
    resolveStream = res
    rejectStream = rej
  })
  void streamDone // suppress unhandled rejection lint

  const readable = new ReadableStream<TextStreamPart<Record<string, any>>>({
    start: async (controller) => {
      try {
        // text-start
        controller.enqueue({ type: 'text-start', id: textBlockId } as any)

        // 执行 agentic loop
        await runAgenticLoop({
          messages,
          providerId,
          modelId,
          abortController,
          onTextDelta: (delta) => {
            controller.enqueue({ type: 'text-delta', text: delta } as any)
          }
        })

        // text-end + finish
        controller.enqueue({ type: 'text-end', id: textBlockId } as any)
        controller.enqueue({
          type: 'finish',
          finishReason: 'stop',
          usage: { promptTokens: 0, completionTokens: 0 }
        } as any)

        controller.close()
        resolveStream()
      } catch (err) {
        if (!abortController.signal.aborted) {
          logger.error('[PRISM2] PrismNativeService stream error', { error: err })
        }
        controller.error(err)
        rejectStream(err)
      }
    }
  })

  return readable
}
