// [PRISM] 2026-05-15 — 完全重建：丢弃 @cherrystudio/openai，改用原生 fetch + SSE
// 原因：@cherrystudio/openai 对 Anthropic provider 有特殊处理，切换到原生 Messages API，
//       导致 streaming 方式不匹配（HTTP 500: "Streaming is strongly recommended"）
// 新方案：直接 fetch → text/event-stream → 解析 SSE，对所有 OpenAI 兼容端点统一有效
//         支持：OpenClaw / DeepSeek / Anthropic(OpenAI兼容) / LM Studio / Ollama / new-api

import type { Provider } from '@types'

import { loggerService } from '../../services/LoggerService'
import type { ModelValidationError } from '../utils'
import { validateModelId } from '../utils'

const logger = loggerService.withContext('ChatCompletionService')

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ChatCompletionChunk {
  id: string
  object: string
  created: number
  model: string
  choices: Array<{
    index: number
    delta: {
      role?: string
      content?: string | null
    }
    finish_reason: string | null
  }>
}

export interface ValidationResult {
  isValid: boolean
  errors: string[]
}

export class ChatCompletionValidationError extends Error {
  constructor(public readonly errors: string[]) {
    super(`Request validation failed: ${errors.join('; ')}`)
    this.name = 'ChatCompletionValidationError'
  }
}

export class ChatCompletionModelError extends Error {
  constructor(public readonly error: ModelValidationError) {
    super(`Model validation failed: ${error.message}`)
    this.name = 'ChatCompletionModelError'
  }
}

// ─── URL Helper ──────────────────────────────────────────────────────────────

/**
 * 从 provider.apiHost 构建 chat/completions 端点 URL
 * 处理各种格式：
 *   https://api.anthropic.com          → https://api.anthropic.com/v1/chat/completions
 *   https://api.anthropic.com/v1       → https://api.anthropic.com/v1/chat/completions
 *   https://api.anthropic.com/v1/messages → https://api.anthropic.com/v1/chat/completions
 *   http://127.0.0.1:18789/v1         → http://127.0.0.1:18789/v1/chat/completions
 *   http://localhost:1234/v1           → http://localhost:1234/v1/chat/completions
 */
function buildChatCompletionUrl(apiHost: string): string {
  // Remove trailing slashes
  let base = apiHost.replace(/\/+$/, '')

  // Strip known native-API suffixes that aren't the OpenAI-compatible base
  base = base.replace(/\/messages$/, '')   // Anthropic native: /v1/messages
  base = base.replace(/\/completions$/, '') // already has path

  // Ensure /v1 is present
  if (!base.match(/\/v\d+$/)) {
    base = base + '/v1'
  }

  return base + '/chat/completions'
}

// ─── SSE Parser ──────────────────────────────────────────────────────────────

async function* parseSSEStream(
  body: ReadableStream<Uint8Array>
): AsyncIterable<ChatCompletionChunk> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''

      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed || !trimmed.startsWith('data: ')) continue

        const data = trimmed.slice(6)
        if (data === '[DONE]') return

        try {
          const chunk = JSON.parse(data) as ChatCompletionChunk
          yield chunk
        } catch {
          // Skip malformed JSON lines (keep-alive, comments, etc.)
        }
      }
    }
  } finally {
    try { reader.releaseLock() } catch { /* ignore */ }
  }
}

// ─── Service ─────────────────────────────────────────────────────────────────

export class ChatCompletionService {

  private readonly supportedTypes = ['openai', 'anthropic', 'ollama', 'new-api', 'lmstudio']

  async resolveProviderContext(
    model: string
  ): Promise<
    | { ok: false; error: ModelValidationError }
    | { ok: true; provider: Provider; modelId: string; url: string; apiKey: string }
  > {
    const modelValidation = await validateModelId(model)
    if (!modelValidation.valid) {
      return { ok: false, error: modelValidation.error! }
    }

    const provider = modelValidation.provider!

    if (!this.supportedTypes.includes(provider.type)) {
      return {
        ok: false,
        error: {
          type: 'unsupported_provider_type',
          message: `Provider '${provider.id}' (type '${provider.type}') is not supported. Supported: ${this.supportedTypes.join(', ')}`,
          code: 'unsupported_provider_type'
        }
      }
    }

    const modelId = modelValidation.modelId!
    // Use first key if comma-separated; use dummy for keyless local providers
    const apiKey = provider.apiKey ? provider.apiKey.split(',')[0].trim() : 'prism-local-key'
    const url = buildChatCompletionUrl(provider.apiHost)

    logger.debug('[PRISM] resolveProviderContext', {
      provider: provider.id,
      type: provider.type,
      modelId,
      url
    })

    return { ok: true, provider, modelId, url, apiKey }
  }

  async processStreamingCompletion(request: {
    model: string
    messages: Array<{ role: string; content: string }>
    stream?: boolean
    [key: string]: unknown
  }): Promise<{
    provider: Provider
    modelId: string
    stream: AsyncIterable<ChatCompletionChunk>
  }> {
    const requestMessages = request.messages
    if (!requestMessages || !Array.isArray(requestMessages) || requestMessages.length === 0) {
      throw new ChatCompletionValidationError(['Messages array is required and cannot be empty'])
    }

    const context = await this.resolveProviderContext(request.model)
    if (!context.ok) {
      throw new ChatCompletionModelError(context.error)
    }

    const { provider, modelId, url, apiKey } = context

    logger.info('[PRISM] Streaming completion via native fetch', {
      provider: provider.id,
      type: provider.type,
      modelId,
      url,
      messageCount: requestMessages.length
    })

    // Build request body — only include what's needed, no SDK magic
    const body = JSON.stringify({
      model: modelId,
      messages: requestMessages,
      stream: true
    })

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'Accept': 'text/event-stream'
      },
      body
    })

    if (!response.ok) {
      const errorText = await response.text().catch(() => 'unknown error')
      logger.error('[PRISM] API request failed', {
        status: response.status,
        url,
        provider: provider.id,
        error: errorText.slice(0, 500)
      })
      throw new Error(`API Error: ${response.status} ${errorText}`)
    }

    if (!response.body) {
      throw new Error('No response body from API')
    }

    logger.info('[PRISM] Stream started', { provider: provider.id, modelId, url })

    return {
      provider,
      modelId,
      stream: parseSSEStream(response.body)
    }
  }

  // Non-streaming variant (kept for compatibility, rarely used in agents)
  async processCompletion(request: {
    model: string
    messages: Array<{ role: string; content: string }>
    [key: string]: unknown
  }): Promise<{
    provider: Provider
    modelId: string
    response: { choices: Array<{ message: { content: string } }> }
  }> {
    const context = await this.resolveProviderContext(request.model)
    if (!context.ok) {
      throw new ChatCompletionModelError(context.error)
    }

    const { provider, modelId, url, apiKey } = context

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({ model: modelId, messages: request.messages, stream: false })
    })

    if (!response.ok) {
      const errorText = await response.text().catch(() => 'unknown error')
      throw new Error(`API Error: ${response.status} ${errorText}`)
    }

    const data = await response.json()
    return { provider, modelId, response: data }
  }
}

export const chatCompletionService = new ChatCompletionService()
