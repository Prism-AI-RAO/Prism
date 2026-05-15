// [PRISM2] 2026-05-15 — PrismNative Agentic Loop
// 核心执行引擎：multi-turn + tool_call 解析 + MCP 执行（P1）+ Hermes 记忆（修复超时）

import { loggerService } from '@logger'

import type { ParsedModel, ToolCallAccumulator } from './types'

const logger = loggerService.withContext('PrismNativeAgenticLoop')

const PRISM_API_PORT = 23333
const MAX_ITERATIONS = 20

// ── 工具函数 ────────────────────────────────────────────────────────

/** 解析 "providerId:modelId" 格式 */
export function parseModel(sessionModel: string | null | undefined): ParsedModel {
  if (!sessionModel) return { providerId: 'deepseek', modelId: 'deepseek-v4-flash' }
  const colonIdx = sessionModel.indexOf(':')
  if (colonIdx < 0) return { providerId: 'deepseek', modelId: sessionModel }
  return {
    providerId: sessionModel.slice(0, colonIdx),
    modelId: sessionModel.slice(colonIdx + 1)
  }
}

/** 从消息 blocks 中提取纯文本（取 main_text 类型块拼接） */
export function extractTextFromBlocks(blocks: Array<{ type: string; content?: string }>): string {
  return blocks
    .filter((b) => b.type === 'main_text')
    .map((b) => b.content ?? '')
    .join('\n')
    .trim()
}

// ── 主循环 ───────────────────────────────────────────────────────────

export interface AgenticLoopResult {
  fullText: string
}

/**
 * prism-native 核心 agentic loop。
 *
 * P0：单轮流式 chatCompletion（工具调用支架已就位，P1 填充）
 * P1：tool_calls → MCP 执行 → 结果回注 → 继续循环
 */
export async function runAgenticLoop(params: {
  messages: Array<{ role: string; content: any }>
  providerId: string
  modelId: string
  abortController: AbortController
  maxIterations?: number
  onTextDelta: (delta: string) => void
  onToolUse?: (id: string, name: string, args: unknown) => void
  onToolResult?: (id: string, name: string, result: unknown) => void
}): Promise<AgenticLoopResult> {
  const {
    messages,
    providerId,
    modelId,
    abortController,
    maxIterations = MAX_ITERATIONS,
    onTextDelta
  } = params

  const url = `http://127.0.0.1:${PRISM_API_PORT}/${providerId}/v1/chat/completions`
  let fullText = ''

  for (let iteration = 0; iteration < maxIterations; iteration++) {
    if (abortController.signal.aborted) break

    logger.debug(`[PRISM2] Agentic loop iteration ${iteration + 1}`, {
      model: `${providerId}:${modelId}`,
      messageCount: messages.length
    })

    // ── 调用 Prism API Server ────────────────────────────────────────
    let response: Response
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: modelId,
          messages,
          stream: true
          // [PRISM2 P1] tools: mcpTools  // MCP 工具调用（Phase 2 P1）
        }),
        signal: abortController.signal
      })
    } catch (err) {
      if (abortController.signal.aborted) break
      throw err
    }

    if (!response.ok) {
      const errText = await response.text().catch(() => '(unreadable)')
      throw new Error(`Prism API Server ${response.status}: ${errText}`)
    }

    // ── 解析 SSE 流 ──────────────────────────────────────────────────
    const reader = response.body!.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let finishReason = 'stop'
    const toolCallMap = new Map<number, ToolCallAccumulator>()

    outer: while (true) {
      if (abortController.signal.aborted) {
        reader.cancel()
        break
      }
      const { done, value } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue
        const data = line.slice(6).trim()
        if (data === '[DONE]') break outer
        if (!data) continue

        let parsed: any
        try {
          parsed = JSON.parse(data)
        } catch {
          continue
        }

        const choice = parsed.choices?.[0]
        if (!choice) continue

        // text delta
        const textDelta = choice.delta?.content
        if (textDelta) {
          fullText += textDelta
          onTextDelta(textDelta)
        }

        // tool_calls 累积（P1 支架）
        if (choice.delta?.tool_calls) {
          for (const tc of choice.delta.tool_calls as any[]) {
            const idx: number = tc.index ?? 0
            if (!toolCallMap.has(idx)) {
              toolCallMap.set(idx, { index: idx, id: tc.id ?? '', name: '', arguments: '' })
            }
            const acc = toolCallMap.get(idx)!
            if (tc.id) acc.id = tc.id
            if (tc.function?.name) acc.name = tc.function.name
            if (tc.function?.arguments) acc.arguments += tc.function.arguments
          }
        }

        if (choice.finish_reason) {
          finishReason = choice.finish_reason
        }
      }
    }

    // ── P0：无工具调用，或 stop → 结束循环 ──────────────────────────
    if (finishReason === 'stop' || toolCallMap.size === 0) {
      break
    }

    // ── [PRISM2 P1] 工具调用处理（Phase 2 P1 实现）────────────────────
    // TODO: 执行 MCP 工具，回注结果，继续下一轮循环
    logger.warn('[PRISM2] Tool calls detected but P1 tool execution not yet implemented', {
      toolCount: toolCallMap.size
    })
    break
  }

  return { fullText }
}
