import { randomUUID } from 'node:crypto'

import { loggerService } from '@logger'
// [PRISM] 2026-05-14 — generic 类型通过 ChatCompletionService 路由，不经 Claude Code SDK
import OpenAI from '@cherrystudio/openai'
import { chatCompletionService } from '@main/apiServer/services/chat-completion'
import { getAvailableProviders } from '@main/apiServer/utils'
import type {
  AgentPersistedMessage,
  AgentSessionMessageEntity,
  CreateSessionMessageRequest,
  GetAgentSessionResponse,
  ListOptions
} from '@types'
import type { TextStreamPart } from 'ai'
import { and, desc, eq, not } from 'drizzle-orm'

import { BaseService } from '../BaseService'
import { sessionMessagesTable } from '../database/schema'
import { agentMessageRepository } from '../database/sessionMessageRepository'
import type { AgentStreamEvent } from '../interfaces/AgentStreamInterface'
import ClaudeCodeService from './claudecode'

const claudeCodeService = new ClaudeCodeService()

const logger = loggerService.withContext('SessionMessageService')

type SessionStreamResult = {
  stream: ReadableStream<TextStreamPart<Record<string, any>>>
  completion: Promise<{
    userMessage?: AgentSessionMessageEntity
    assistantMessage?: AgentSessionMessageEntity
  }>
}

export type CreateMessageOptions = {
  /** When true, persist user+assistant messages to DB on stream complete. Use for headless callers (channels, scheduler) where no UI handles persistence. */
  persist?: boolean
  /** Optional display-safe user content for persistence. When set, this is stored instead of req.content (which may contain security wrappers not meant for display). */
  displayContent?: string
  /** Images to persist in the user message for UI display (not sent to AI model). */
  images?: Array<{ data: string; media_type: string }>
}

// Ensure errors emitted through SSE are serializable
function serializeError(error: unknown): { message: string; name?: string; stack?: string } {
  if (error instanceof Error) {
    return {
      message: error.message,
      name: error.name,
      stack: error.stack
    }
  }

  if (typeof error === 'string') {
    return { message: error }
  }

  return {
    message: 'Unknown error'
  }
}

class TextStreamAccumulator {
  private textBuffer = ''
  private totalText = ''
  private readonly toolCalls = new Map<string, { toolName?: string; input?: unknown }>()
  private readonly toolResults = new Map<string, unknown>()

  add(part: TextStreamPart<Record<string, any>>): void {
    switch (part.type) {
      case 'text-start':
        this.textBuffer = ''
        break
      case 'text-delta':
        if (part.text) {
          this.textBuffer = part.text
        }
        break
      case 'text-end': {
        const blockText = (part.providerMetadata?.text?.value as string | undefined) ?? this.textBuffer
        if (blockText) {
          this.totalText += blockText
        }
        this.textBuffer = ''
        break
      }
      case 'tool-call':
        if (part.toolCallId) {
          const legacyPart = part as typeof part & {
            args?: unknown
            providerMetadata?: { raw?: { input?: unknown } }
          }
          this.toolCalls.set(part.toolCallId, {
            toolName: part.toolName,
            input: part.input ?? legacyPart.args ?? legacyPart.providerMetadata?.raw?.input
          })
        }
        break
      case 'tool-result':
        if (part.toolCallId) {
          const legacyPart = part as typeof part & {
            result?: unknown
            providerMetadata?: { raw?: unknown }
          }
          this.toolResults.set(part.toolCallId, part.output ?? legacyPart.result ?? legacyPart.providerMetadata?.raw)
        }
        break
      default:
        break
    }
  }

  getText(): string {
    return (this.totalText + this.textBuffer).replace(/\n+$/, '')
  }
}

export class SessionMessageService extends BaseService {
  private static instance: SessionMessageService | null = null

  static getInstance(): SessionMessageService {
    if (!SessionMessageService.instance) {
      SessionMessageService.instance = new SessionMessageService()
    }
    return SessionMessageService.instance
  }

  async sessionMessageExists(id: number): Promise<boolean> {
    const database = await this.getDatabase()
    const result = await database
      .select({ id: sessionMessagesTable.id })
      .from(sessionMessagesTable)
      .where(eq(sessionMessagesTable.id, id))
      .limit(1)

    return result.length > 0
  }

  async listSessionMessages(
    sessionId: string,
    options: ListOptions = {}
  ): Promise<{ messages: AgentSessionMessageEntity[] }> {
    // Get messages with pagination
    const database = await this.getDatabase()
    const baseQuery = database
      .select()
      .from(sessionMessagesTable)
      .where(eq(sessionMessagesTable.session_id, sessionId))
      .orderBy(sessionMessagesTable.created_at)

    const result =
      options.limit !== undefined
        ? options.offset !== undefined
          ? await baseQuery.limit(options.limit).offset(options.offset)
          : await baseQuery.limit(options.limit)
        : await baseQuery

    const messages = result.map((row) => this.deserializeSessionMessage(row))

    return { messages }
  }

  async deleteSessionMessage(sessionId: string, messageId: number): Promise<boolean> {
    const database = await this.getDatabase()
    const result = await database
      .delete(sessionMessagesTable)
      .where(and(eq(sessionMessagesTable.id, messageId), eq(sessionMessagesTable.session_id, sessionId)))

    return result.rowsAffected > 0
  }

  async createSessionMessage(
    session: GetAgentSessionResponse,
    messageData: CreateSessionMessageRequest,
    abortController: AbortController,
    options?: CreateMessageOptions
  ): Promise<SessionStreamResult> {
    return await this.startSessionMessageStream(session, messageData, abortController, options)
  }

  private async startSessionMessageStream(
    session: GetAgentSessionResponse,
    req: CreateSessionMessageRequest,
    abortController: AbortController,
    options?: CreateMessageOptions
  ): Promise<SessionStreamResult> {
    const agentSessionId = await this.getLastAgentSessionId(session.id)
    logger.debug('Session Message stream message data:', { message: req, session_id: agentSessionId })

    // [PRISM] 2026-05-14 — generic 类型走 ChatCompletionService，不使用 Claude Code SDK
    // 原因：generic Agent 使用任意 Provider（非 Anthropic），通过 Prism API Server 路由
    if (session.agent_type === 'generic') {
      return await this.startGenericAgentStream(session, req, abortController, agentSessionId, options)
    }

    const claudeStream = await claudeCodeService.invoke(
      req.content,
      session,
      abortController,
      agentSessionId,
      {
        effort: req.effort,
        thinking: req.thinking
      },
      undefined
    )
    const accumulator = new TextStreamAccumulator()

    let resolveCompletion!: (value: {
      userMessage?: AgentSessionMessageEntity
      assistantMessage?: AgentSessionMessageEntity
    }) => void
    let rejectCompletion!: (reason?: unknown) => void

    const completion = new Promise<{
      userMessage?: AgentSessionMessageEntity
      assistantMessage?: AgentSessionMessageEntity
    }>((resolve, reject) => {
      resolveCompletion = resolve
      rejectCompletion = reject
    })

    let finished = false

    const cleanup = () => {
      if (finished) return
      finished = true
      claudeStream.removeAllListeners()
    }

    const stream = new ReadableStream<TextStreamPart<Record<string, any>>>({
      start: (controller) => {
        claudeStream.on('data', async (event: AgentStreamEvent) => {
          if (finished) return
          try {
            switch (event.type) {
              case 'chunk': {
                const chunk = event.chunk as TextStreamPart<Record<string, any>> | undefined
                if (!chunk) {
                  logger.warn('Received agent chunk event without chunk payload')
                  return
                }

                accumulator.add(chunk)
                controller.enqueue(chunk)
                break
              }

              case 'error': {
                const stderrMessage = (event as any)?.data?.stderr as string | undefined
                const underlyingError = event.error ?? (stderrMessage ? new Error(stderrMessage) : undefined)
                cleanup()
                const streamError = underlyingError ?? new Error('Stream error')
                controller.error(streamError)
                rejectCompletion(serializeError(streamError))
                break
              }

              case 'complete': {
                cleanup()
                controller.close()
                if (options?.persist) {
                  // Read SDK session_id from the stream object (set by ClaudeCodeService on init)
                  const resolvedSessionId = claudeStream.sdkSessionId || agentSessionId
                  logger.debug('Persisting headless exchange with agent session ID', {
                    sdkSessionId: claudeStream.sdkSessionId,
                    fallback: agentSessionId,
                    resolved: resolvedSessionId
                  })
                  this.persistHeadlessExchange(
                    session,
                    options?.displayContent ?? req.content,
                    accumulator.getText(),
                    resolvedSessionId,
                    options?.images
                  )
                    .then(resolveCompletion)
                    .catch((err) => {
                      logger.error('Failed to persist headless exchange', err as Error)
                      resolveCompletion({})
                    })
                } else {
                  resolveCompletion({})
                }
                break
              }

              case 'cancelled': {
                cleanup()
                controller.close()
                if (options?.persist) {
                  const resolvedSessionId = claudeStream.sdkSessionId || agentSessionId
                  const partialText = accumulator.getText()
                  if (partialText) {
                    this.persistHeadlessExchange(
                      session,
                      options?.displayContent ?? req.content,
                      partialText,
                      resolvedSessionId,
                      options?.images
                    )
                      .then(resolveCompletion)
                      .catch((err) => {
                        logger.error('Failed to persist cancelled exchange', err as Error)
                        resolveCompletion({})
                      })
                  } else {
                    resolveCompletion({})
                  }
                } else {
                  resolveCompletion({})
                }
                break
              }

              default:
                logger.warn('Unknown event type from Claude Code service:', {
                  type: event.type
                })
                break
            }
          } catch (error) {
            cleanup()
            controller.error(error)
            rejectCompletion(serializeError(error))
          }
        })
      },
      cancel: (reason) => {
        cleanup()
        abortController.abort(typeof reason === 'string' ? reason : 'stream cancelled')
        resolveCompletion({})
      }
    })

    return { stream, completion }
  }

  /**
   * Persist user + assistant messages for headless callers (channels, scheduler)
   * that have no UI to handle persistence via IPC.
   */
  private async persistHeadlessExchange(
    session: GetAgentSessionResponse,
    userContent: string,
    assistantContent: string,
    agentSessionId: string,
    images?: Array<{ data: string; media_type: string }>
  ): Promise<{ userMessage?: AgentSessionMessageEntity; assistantMessage?: AgentSessionMessageEntity }> {
    const now = new Date().toISOString()
    const userMsgId = randomUUID()
    const assistantMsgId = randomUUID()
    const userBlockId = randomUUID()
    const assistantBlockId = randomUUID()
    const topicId = `agent-session:${session.id}`

    // Build image blocks for user message
    const imageBlocks: Array<{
      id: string
      messageId: string
      type: string
      createdAt: string
      status: string
      url: string
    }> = []
    if (images && images.length > 0) {
      for (const img of images) {
        imageBlocks.push({
          id: randomUUID(),
          messageId: userMsgId,
          type: 'image',
          createdAt: now,
          status: 'success',
          url: `data:${img.media_type};base64,${img.data}`
        })
      }
    }

    const userPayload = {
      message: {
        id: userMsgId,
        role: 'user' as const,
        assistantId: session.agent_id,
        topicId,
        createdAt: now,
        status: 'success',
        blocks: [userBlockId, ...imageBlocks.map((b) => b.id)]
      },
      blocks: [
        {
          id: userBlockId,
          messageId: userMsgId,
          type: 'main_text',
          createdAt: now,
          status: 'success',
          content: userContent
        },
        ...imageBlocks
      ]
    } as AgentPersistedMessage

    const assistantPayload = {
      message: {
        id: assistantMsgId,
        role: 'assistant' as const,
        assistantId: session.agent_id,
        topicId,
        createdAt: now,
        status: 'success',
        blocks: [assistantBlockId],
        modelId: session.model
      },
      blocks: [
        {
          id: assistantBlockId,
          messageId: assistantMsgId,
          type: 'main_text',
          createdAt: now,
          status: 'success',
          content: assistantContent
        }
      ]
    } as AgentPersistedMessage

    const result = await agentMessageRepository.persistExchange({
      sessionId: session.id,
      agentSessionId,
      user: { payload: userPayload, createdAt: now },
      assistant: { payload: assistantPayload, createdAt: now }
    })

    logger.info('Persisted headless exchange', {
      sessionId: session.id,
      userMessageId: userMsgId,
      assistantMessageId: assistantMsgId
    })

    return result
  }

  // ─── [PRISM] generic Agent 聊天路径 ─────────────────────────────────────────

  /**
   * 解析 generic agent 使用的模型 ID。
   * 若 session.model 已是 "providerId:modelId" 格式则直接使用；
   * 否则自动回落到第一个已配置 Provider 的第一个模型。
   */
  private async resolveGenericModel(sessionModel: string | null | undefined): Promise<string> {
    if (sessionModel && sessionModel.includes(':')) {
      return sessionModel
    }
    const providers = await getAvailableProviders()
    if (providers.length === 0) {
      throw new Error('No AI providers configured. Go to Settings → Models to add a provider.')
    }
    const provider = providers[0]
    const model = provider.models?.[0]
    if (!model) {
      throw new Error(`Provider "${provider.name}" has no models. Add models in Settings → Models.`)
    }
    const resolved = `${provider.id}:${model.id}`
    logger.info('[PRISM] generic agent model fallback resolved', { original: sessionModel, resolved })
    return resolved
  }

  /**
   * 从消息 blocks 中提取纯文本（取 main_text 类型块拼接）。
   */
  private extractTextFromBlocks(blocks: Array<{ type: string; content?: string }>): string {
    return blocks
      .filter((b) => b.type === 'main_text')
      .map((b) => b.content ?? '')
      .join('\n')
      .trim()
  }

  /**
   * generic 类型 Agent 的流式消息处理。
   * 使用 ChatCompletionService（OpenAI 兼容接口）替代 Claude Code SDK，
   * 支持任意已配置的 Provider（LM Studio、DeepSeek、Ollama 等）。
   */
  private async startGenericAgentStream(
    session: GetAgentSessionResponse,
    req: CreateSessionMessageRequest,
    abortController: AbortController,
    agentSessionId: string,
    options?: CreateMessageOptions
  ): Promise<SessionStreamResult> {
    // 1. Resolve model
    const model = await this.resolveGenericModel(session.model)
    logger.info('[PRISM] generic agent stream', { sessionId: session.id, model })

    // 2. Build OpenAI-compatible messages array
    const systemPrompt = session.instructions || 'You are a helpful assistant.'
    const history = await agentMessageRepository.getSessionHistory(session.id)

    const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [{ role: 'system', content: systemPrompt }]
    for (const msg of history) {
      const text = this.extractTextFromBlocks(msg.blocks as Array<{ type: string; content?: string }>)
      if (text) {
        const role = msg.message.role === 'user' ? 'user' : 'assistant'
        messages.push({ role, content: text })
      }
    }
    messages.push({ role: 'user', content: req.content })

    // 3 & 4. 立即返回 ReadableStream（非阻塞），API 调用在 start 内部异步执行
    // 关键：不在此处 await processStreamingCompletion，否则 messages.ts 无法及时建立 SSE 连接，
    // renderer 收不到 SSE 头，导致 fetch 挂起
    let fullText = ''
    const textBlockId = randomUUID()

    let resolveCompletion!: (value: {
      userMessage?: AgentSessionMessageEntity
      assistantMessage?: AgentSessionMessageEntity
    }) => void
    let rejectCompletion!: (reason?: unknown) => void

    const completion = new Promise<{
      userMessage?: AgentSessionMessageEntity
      assistantMessage?: AgentSessionMessageEntity
    }>((resolve, reject) => {
      resolveCompletion = resolve
      rejectCompletion = reject
    })

    const persistResult = (text: string) => {
      if (!options?.persist || !text) {
        resolveCompletion({})
        return
      }
      this.persistHeadlessExchange(session, options.displayContent ?? req.content, text, agentSessionId, options.images)
        .then(resolveCompletion)
        .catch((err) => {
          logger.error('[PRISM] Failed to persist generic exchange', err as Error)
          resolveCompletion({})
        })
    }

    const stream = new ReadableStream<TextStreamPart<Record<string, any>>>({
      start: async (controller) => {
        controller.enqueue({ type: 'text-start', id: textBlockId } as TextStreamPart<Record<string, any>>)
        try {
          // API 调用在 start 内部，不阻塞 startGenericAgentStream 的返回
          const { stream: openaiStream } = await chatCompletionService.processStreamingCompletion({
            model,
            messages,
            stream: true as const
          })
          for await (const chunk of openaiStream) {
            if (abortController.signal.aborted) {
              controller.enqueue({ type: 'text-end', id: textBlockId } as TextStreamPart<Record<string, any>>)
              controller.close()
              persistResult(fullText)
              return
            }
            const delta = chunk.choices[0]?.delta?.content
            if (delta) {
              fullText += delta
              controller.enqueue({
                type: 'text-delta',
                id: textBlockId,
                text: delta
              } as TextStreamPart<Record<string, any>>)
            }
          }
          // Stream complete
          controller.enqueue({ type: 'text-end', id: textBlockId } as TextStreamPart<Record<string, any>>)
          controller.close()
          persistResult(fullText)
        } catch (error) {
          logger.error('[PRISM] generic agent stream error', error as Error)
          controller.error(error)
          rejectCompletion(serializeError(error))
        }
      },
      cancel: () => {
        abortController.abort('stream cancelled')
        resolveCompletion({})
      }
    })

    return { stream, completion }
  }

  // ─── End [PRISM] generic Agent 聊天路径 ──────────────────────────────────────

  private async getLastAgentSessionId(sessionId: string): Promise<string> {
    try {
      const database = await this.getDatabase()
      const result = await database
        .select({ agent_session_id: sessionMessagesTable.agent_session_id })
        .from(sessionMessagesTable)
        .where(and(eq(sessionMessagesTable.session_id, sessionId), not(eq(sessionMessagesTable.agent_session_id, ''))))
        .orderBy(desc(sessionMessagesTable.created_at))
        .limit(1)

      logger.silly('Last agent session ID result:', { agentSessionId: result[0]?.agent_session_id, sessionId })
      return result[0]?.agent_session_id || ''
    } catch (error) {
      logger.error('Failed to get last agent session ID', {
        sessionId,
        error
      })
      return ''
    }
  }

  private deserializeSessionMessage(data: any): AgentSessionMessageEntity {
    if (!data) return data

    const deserialized = { ...data }

    // Parse content JSON
    if (deserialized.content && typeof deserialized.content === 'string') {
      try {
        deserialized.content = JSON.parse(deserialized.content)
      } catch (error) {
        logger.warn(`Failed to parse content JSON:`, error as Error)
      }
    }

    // Parse metadata JSON
    if (deserialized.metadata && typeof deserialized.metadata === 'string') {
      try {
        deserialized.metadata = JSON.parse(deserialized.metadata)
      } catch (error) {
        logger.warn(`Failed to parse metadata JSON:`, error as Error)
      }
    }

    return deserialized
  }
}

export const sessionMessageService = SessionMessageService.getInstance()
