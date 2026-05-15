import type Anthropic from '@anthropic-ai/sdk'
import type { MessageCreateParams, MessageStreamEvent } from '@anthropic-ai/sdk/resources'
import { loggerService } from '@logger'
import anthropicService from '@main/services/AnthropicService'
import { buildClaudeCodeSystemMessage, getSdkClient } from '@shared/anthropic'
import type { Provider } from '@types'
import type { Response } from 'express'

const logger = loggerService.withContext('MessagesService')
const EXCLUDED_FORWARD_HEADERS: ReadonlySet<string> = new Set([
  'host',
  'x-api-key',
  'authorization',
  'sentry-trace',
  'baggage',
  'content-length',
  'connection'
])

export interface ValidationResult {
  isValid: boolean
  errors: string[]
}

export interface ErrorResponse {
  type: 'error'
  error: {
    type: string
    message: string
    requestId?: string
  }
}

export interface StreamConfig {
  response: Response
  onChunk?: (chunk: MessageStreamEvent) => void
  onError?: (error: any) => void
  onComplete?: () => void
}

export interface ProcessMessageOptions {
  provider: Provider
  request: MessageCreateParams
  extraHeaders?: Record<string, string | string[]>
  modelId?: string
}

export interface ProcessMessageResult {
  client: Anthropic
  anthropicRequest: MessageCreateParams
}


// [PRISM] 2026-05-15 — OpenAI 兼容 Provider 类型列表
// 这些 Provider 不支持 Anthropic Messages API，需要通过 chat/completions 翻译层
const OPENAI_COMPATIBLE_TYPES = ['openai', 'ollama', 'lmstudio', 'new-api']

/**
 * [PRISM] 2026-05-15 — Anthropic Messages → OpenAI Chat Completions 翻译层
 * 用于 LM Studio / Ollama / OpenAI 等不支持 Anthropic Messages API 的 Provider
 */
async function callOpenAICompatible(
  provider: Provider,
  request: MessageCreateParams,
  modelId?: string
): Promise<{ choices: Array<{ message: { role: string; content: string } }> }> {
  const apiKey = provider.apiKey || 'prism-local-key'
  const baseUrl = provider.apiHost.replace(/\/+$/, '').replace(/\/v\d+$/, '')
  const url = `${baseUrl}/v1/chat/completions`
  const model = modelId || request.model

  // Convert Anthropic messages to OpenAI format
  const messages: Array<{ role: string; content: string }> = []
  if (request.system) {
    const sys = typeof request.system === 'string' ? request.system : JSON.stringify(request.system)
    messages.push({ role: 'system', content: sys })
  }
  for (const msg of request.messages) {
    const content = typeof msg.content === 'string'
      ? msg.content
      : msg.content.map((c: any) => c.text || '').join('')
    messages.push({ role: msg.role, content })
  }

  const body = JSON.stringify({ model, messages, stream: false })
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body
  })

  if (!resp.ok) {
    const errText = await resp.text().catch(() => 'unknown')
    throw new Error(`OpenAI API error ${resp.status}: ${errText.slice(0, 300)}`)
  }
  return resp.json()
}

async function* streamOpenAICompatible(
  provider: Provider,
  request: MessageCreateParams,
  modelId?: string
): AsyncIterable<string> {
  const apiKey = provider.apiKey || 'prism-local-key'
  const baseUrl = provider.apiHost.replace(/\/+$/, '').replace(/\/v\d+$/, '')
  const url = `${baseUrl}/v1/chat/completions`
  const model = modelId || request.model

  const messages: Array<{ role: string; content: string }> = []
  if (request.system) {
    const sys = typeof request.system === 'string' ? request.system : JSON.stringify(request.system)
    messages.push({ role: 'system', content: sys })
  }
  for (const msg of request.messages) {
    const content = typeof msg.content === 'string'
      ? msg.content
      : msg.content.map((c: any) => c.text || '').join('')
    messages.push({ role: msg.role, content })
  }

  const body = JSON.stringify({ model, messages, stream: true })
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
      'Accept': 'text/event-stream'
    },
    body
  })

  if (!resp.ok) {
    const errText = await resp.text().catch(() => 'unknown')
    throw new Error(`OpenAI stream error ${resp.status}: ${errText.slice(0, 300)}`)
  }

  if (!resp.body) throw new Error('No response body')

  const reader = resp.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      const lines = buf.split('\n')
      buf = lines.pop() ?? ''
      for (const line of lines) {
        const t = line.trim()
        if (!t || !t.startsWith('data: ')) continue
        const data = t.slice(6)
        if (data === '[DONE]') return
        try {
          const chunk = JSON.parse(data)
          const delta = chunk?.choices?.[0]?.delta?.content
          if (delta) yield delta
        } catch { /* skip */ }
      }
    }
  } finally {
    try { reader.releaseLock() } catch { /* ignore */ }
  }
}

export class MessagesService {
  validateRequest(request: MessageCreateParams): ValidationResult {
    // TODO: Implement comprehensive request validation
    const errors: string[] = []

    if (!request.model || typeof request.model !== 'string') {
      errors.push('Model is required')
    }

    if (typeof request.max_tokens !== 'number' || !Number.isFinite(request.max_tokens) || request.max_tokens < 1) {
      errors.push('max_tokens is required and must be a positive number')
    }

    if (!request.messages || !Array.isArray(request.messages) || request.messages.length === 0) {
      errors.push('messages is required and must be a non-empty array')
    } else {
      request.messages.forEach((message, index) => {
        if (!message || typeof message !== 'object') {
          errors.push(`messages[${index}] must be an object`)
          return
        }

        if (!('role' in message) || typeof message.role !== 'string' || message.role.trim().length === 0) {
          errors.push(`messages[${index}].role is required`)
        }

        const content: unknown = message.content
        if (content === undefined || content === null) {
          errors.push(`messages[${index}].content is required`)
          return
        }

        if (typeof content === 'string' && content.trim().length === 0) {
          errors.push(`messages[${index}].content cannot be empty`)
        } else if (Array.isArray(content) && content.length === 0) {
          errors.push(`messages[${index}].content must include at least one item when using an array`)
        }
      })
    }

    return {
      isValid: errors.length === 0,
      errors
    }
  }

  async getClient(provider: Provider, extraHeaders?: Record<string, string | string[]>): Promise<Anthropic> {
    // Create Anthropic client for the provider
    if (provider.authType === 'oauth') {
      const oauthToken = await anthropicService.getValidAccessToken()
      return getSdkClient(provider, oauthToken, extraHeaders)
    }
    return getSdkClient(provider, null, extraHeaders)
  }

  prepareHeaders(headers: Record<string, string | string[] | undefined>): Record<string, string | string[]> {
    const extraHeaders: Record<string, string | string[]> = {}

    for (const [key, value] of Object.entries(headers)) {
      if (value === undefined) {
        continue
      }

      const normalizedKey = key.toLowerCase()
      if (EXCLUDED_FORWARD_HEADERS.has(normalizedKey)) {
        continue
      }

      extraHeaders[normalizedKey] = value
    }

    return extraHeaders
  }

  createAnthropicRequest(request: MessageCreateParams, provider: Provider, modelId?: string): MessageCreateParams {
    const anthropicRequest: MessageCreateParams = {
      ...request,
      stream: !!request.stream
    }

    // Override model if provided
    if (modelId) {
      anthropicRequest.model = modelId
    }

    // Add Claude Code system message for OAuth providers
    if (provider.type === 'anthropic' && provider.authType === 'oauth') {
      anthropicRequest.system = buildClaudeCodeSystemMessage(request.system)
    }

    return anthropicRequest
  }

  async handleStreaming(
    client: Anthropic,
    request: MessageCreateParams,
    config: StreamConfig,
    provider: Provider
  ): Promise<void> {
    const { response, onChunk, onError, onComplete } = config

    // Set streaming headers
    response.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
    response.setHeader('Cache-Control', 'no-cache, no-transform')
    response.setHeader('Connection', 'keep-alive')
    response.setHeader('X-Accel-Buffering', 'no')
    response.flushHeaders()

    // [PRISM] 2026-05-15 — OpenAI 兼容 Provider 翻译层（LM Studio / Ollama / OpenAI）
    if (OPENAI_COMPATIBLE_TYPES.includes(provider.type)) {
      const msgId = `msg_prism_${Date.now()}`
      const writeSseOAI = (payload: unknown) => {
        if (response.writableEnded || response.destroyed) return
        response.write(`data: ${typeof payload === 'string' ? payload : JSON.stringify(payload)}\n\n`)
      }
      try {
        writeSseOAI({ type: 'message_start', message: { id: msgId, type: 'message', role: 'assistant', content: [], model: request.model, stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } } })
        writeSseOAI({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
        writeSseOAI({ type: 'ping' })
        let outputTokens = 0
        for await (const delta of streamOpenAICompatible(provider, request)) {
          writeSseOAI({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: delta } })
          outputTokens++
        }
        writeSseOAI({ type: 'content_block_stop', index: 0 })
        writeSseOAI({ type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: outputTokens } })
        writeSseOAI({ type: 'message_stop' })
        writeSseOAI('[DONE]')
        if (onComplete) onComplete()
      } catch (err: any) {
        writeSseOAI({ type: 'error', error: { type: 'api_error', message: err.message } })
        if (onError) onError(err)
      } finally {
        if (!response.writableEnded) response.end()
      }
      return
    }

    const flushableResponse = response as Response & { flush?: () => void }
    const flushStream = () => {
      if (typeof flushableResponse.flush !== 'function') {
        return
      }
      try {
        flushableResponse.flush()
      } catch (flushError: unknown) {
        logger.warn('Failed to flush streaming response', { error: flushError })
      }
    }

    const writeSse = (eventType: string | undefined, payload: unknown) => {
      if (response.writableEnded || response.destroyed) {
        return
      }

      if (eventType) {
        response.write(`event: ${eventType}\n`)
      }

      const data = typeof payload === 'string' ? payload : JSON.stringify(payload)
      response.write(`data: ${data}\n\n`)
      flushStream()
    }

    try {
      const stream = client.messages.stream(request)
      for await (const chunk of stream) {
        if (response.writableEnded || response.destroyed) {
          logger.warn('Streaming response ended before stream completion', {
            provider: provider.id,
            model: request.model
          })
          break
        }

        writeSse(chunk.type, chunk)

        if (onChunk) {
          onChunk(chunk)
        }
      }
      writeSse(undefined, '[DONE]')

      if (onComplete) {
        onComplete()
      }
    } catch (streamError: any) {
      logger.error('Stream error', {
        error: streamError,
        provider: provider.id,
        model: request.model,
        apiHost: provider.apiHost,
        anthropicApiHost: provider.anthropicApiHost
      })
      writeSse(undefined, {
        type: 'error',
        error: {
          type: 'api_error',
          message: 'Stream processing error'
        }
      })

      if (onError) {
        onError(streamError)
      }
    } finally {
      if (!response.writableEnded) {
        response.end()
      }
    }
  }

  transformError(error: any): { statusCode: number; errorResponse: ErrorResponse } {
    let statusCode = 500
    let errorType = 'api_error'
    let errorMessage = 'Internal server error'

    const anthropicStatus = typeof error?.status === 'number' ? error.status : undefined
    const anthropicError = error?.error

    if (anthropicStatus) {
      statusCode = anthropicStatus
    }

    if (anthropicError?.type) {
      errorType = anthropicError.type
    }

    if (anthropicError?.message) {
      errorMessage = anthropicError.message
    } else if (error instanceof Error && error.message) {
      errorMessage = error.message
    }

    // Infer error type from message if not from Anthropic API
    if (!anthropicStatus && error instanceof Error) {
      const errorMessageText = error.message ?? ''

      if (errorMessageText.includes('API key') || errorMessageText.includes('authentication')) {
        statusCode = 401
        errorType = 'authentication_error'
      } else if (errorMessageText.includes('rate limit') || errorMessageText.includes('quota')) {
        statusCode = 429
        errorType = 'rate_limit_error'
      } else if (errorMessageText.includes('timeout') || errorMessageText.includes('connection')) {
        statusCode = 502
        errorType = 'api_error'
      } else if (errorMessageText.includes('validation') || errorMessageText.includes('invalid')) {
        statusCode = 400
        errorType = 'invalid_request_error'
      }
    }

    const safeErrorMessage =
      typeof errorMessage === 'string' && errorMessage.length > 0 ? errorMessage : 'Internal server error'

    return {
      statusCode,
      errorResponse: {
        type: 'error',
        error: {
          type: errorType,
          message: safeErrorMessage,
          requestId: error?.request_id
        }
      }
    }
  }

  async processMessage(options: ProcessMessageOptions): Promise<ProcessMessageResult> {
    const { provider, request, extraHeaders, modelId } = options

    const client = await this.getClient(provider, extraHeaders)
    const anthropicRequest = this.createAnthropicRequest(request, provider, modelId)

    const messageCount = Array.isArray(request.messages) ? request.messages.length : 0

    logger.info('Processing anthropic messages request', {
      provider: provider.id,
      apiHost: provider.apiHost,
      anthropicApiHost: provider.anthropicApiHost,
      model: anthropicRequest.model,
      stream: !!anthropicRequest.stream,
      // systemPrompt: JSON.stringify(!!request.system),
      // messages: JSON.stringify(request.messages),
      messageCount,
      toolCount: Array.isArray(request.tools) ? request.tools.length : 0
    })

    // Return client and request for route layer to handle streaming/non-streaming
    return {
      client,
      anthropicRequest
    }
  }
}

// Export singleton instance
export const messagesService = new MessagesService()
