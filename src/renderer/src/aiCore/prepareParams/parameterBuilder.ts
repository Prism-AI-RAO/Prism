/**
 * 参数构建模块
 * 构建AI SDK的流式和非流式参数
 */

import { combineHeaders } from '@ai-sdk/provider-utils'
import type { WebSearchPluginConfig } from '@cherrystudio/ai-core/built-in/plugins'
import { extensionRegistry } from '@cherrystudio/ai-core/provider'
import { loggerService } from '@logger'
import type { AppProviderId } from '@renderer/aiCore/types'
import { MAX_TOOL_CALLS, MIN_TOOL_CALLS } from '@renderer/config/constant'
import {
  isAnthropicModel,
  isFixedReasoningModel,
  isGeminiModel,
  isGenerateImageModel,
  isGrokModel,
  isOpenAIModel,
  isOpenRouterBuiltInWebSearchModel,
  isPureGenerateImageModel,
  isSupportedReasoningEffortModel,
  isSupportedThinkingTokenModel,
  isWebSearchModel
} from '@renderer/config/models'
import { getHubModeSystemPrompt } from '@renderer/config/prompts-code-mode'
import { DEFAULT_ASSISTANT_SETTINGS, getDefaultModel } from '@renderer/services/AssistantService'
import store from '@renderer/store'
import type { CherryWebSearchConfig } from '@renderer/store/websearch'
import type { Model } from '@renderer/types'
import { type Assistant, getEffectiveMcpMode, type MCPTool, type Provider, SystemProviderIds } from '@renderer/types'
import type { StreamTextParams } from '@renderer/types/aiCoreTypes'
import { IdleTimeoutController, type IdleTimeoutHandle } from '@renderer/utils/IdleTimeoutController'
import { replacePromptVariables } from '@renderer/utils/prompt'
import { isAIGatewayProvider, isAwsBedrockProvider, isSupportUrlContextProvider } from '@renderer/utils/provider'
import { DEFAULT_TIMEOUT } from '@shared/config/constant'
import type { ModelMessage } from 'ai'
import { stepCountIs } from 'ai'

import { getAiSdkProviderId } from '../provider/factory'
import type { ProviderCapabilities } from '../types'
import { setupToolsConfig } from '../utils/mcp'
import { buildProviderOptions } from '../utils/options'
import { buildProviderBuiltinWebSearchConfig } from '../utils/websearch'
import { addAnthropicHeaders } from './header'
import { filterStandardParams, getMaxTokens, getTemperature, getTopP } from './modelParameters'

const logger = loggerService.withContext('parameterBuilder')

// ── [PRISM] 2026-05-14 — Sprint 10-D: Hermes 记忆注入中间件 ──────────────────
// 在每次 AI 响应前，从 Hermes 拉取用户记忆上下文，注入 System Prompt 前缀。
// 覆盖范围：所有 Agent（Prism Main、Cherry Claw、OpenClaw Agent 等）
// 性能保护：5s 超时 + 静默失败，不阻塞正常对话

const HERMES_MEMORY_API = 'http://localhost:8642/v1/chat/completions'
const HERMES_MEMORY_AUTH = 'prism-local-dev'
/** 记忆注入的最大字符数（避免撑爆 context window）*/
const HERMES_INJECT_MAX_CHARS = 800
/** 两次记忆查询之间的最短间隔（避免同一会话高频调用）*/
const HERMES_INJECT_DEBOUNCE_MS = 30_000

let _lastHermesInjectAt = 0
let _cachedHermesContext: string | null = null

async function fetchHermesContextForInjection(): Promise<string | null> {
  // 去抖动：30s 内复用缓存
  const now = Date.now()
  if (_cachedHermesContext !== null && now - _lastHermesInjectAt < HERMES_INJECT_DEBOUNCE_MS) {
    return _cachedHermesContext
  }

  try {
    const res = await fetch(HERMES_MEMORY_API, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${HERMES_MEMORY_AUTH}`
      },
      body: JSON.stringify({
        model: 'hermes-agent',
        messages: [
          {
            role: 'system',
            content:
              'You are Hermes memory assistant. Output ONLY a concise bullet-point summary of the most important ' +
              'long-term facts about the user (max 5 bullets, plain text, no markdown headers). ' +
              'If nothing is stored yet, output exactly: [No memory yet]'
          },
          { role: 'user', content: 'Summarize user memory context for injection into a system prompt.' }
        ],
        max_tokens: 200,
        stream: false
      }),
      signal: AbortSignal.timeout(5_000)
    })

    if (!res.ok) {
      _cachedHermesContext = null
      return null
    }

    const data = await res.json()
    const content: string = data?.choices?.[0]?.message?.content ?? ''
    const trimmed = content.trim()

    if (!trimmed || trimmed === '[No memory yet]') {
      _cachedHermesContext = null
      _lastHermesInjectAt = now
      return null
    }

    const truncated = trimmed.length > HERMES_INJECT_MAX_CHARS
      ? trimmed.slice(0, HERMES_INJECT_MAX_CHARS) + '…'
      : trimmed

    _cachedHermesContext = truncated
    _lastHermesInjectAt = now
    return truncated
  } catch {
    // Hermes 离线或超时 — 静默跳过，不影响响应
    return null
  }
}
// ── End Sprint 10-D helpers ───────────────────────────────────────────────────

/**
 * Validates and clamps maxToolCalls to valid range
 * Falls back to DEFAULT_ASSISTANT_SETTINGS.maxToolCalls if invalid
 * @param value - The maxToolCalls value from settings
 * @returns Validated maxToolCalls value
 */
function validateMaxToolCalls(value: number | undefined): number {
  if (value === undefined || value < MIN_TOOL_CALLS || value > MAX_TOOL_CALLS) {
    return DEFAULT_ASSISTANT_SETTINGS.maxToolCalls
  }
  return value
}

export function getEffectiveMaxToolCalls(settings?: { maxToolCalls?: number; enableMaxToolCalls?: boolean }): number {
  const enableMaxToolCalls = settings?.enableMaxToolCalls ?? DEFAULT_ASSISTANT_SETTINGS.enableMaxToolCalls

  if (!enableMaxToolCalls) {
    return DEFAULT_ASSISTANT_SETTINGS.maxToolCalls
  }

  return validateMaxToolCalls(settings?.maxToolCalls)
}

function mapVertexAIGatewayModelToProviderId(model: Model): AppProviderId | undefined {
  if (isAnthropicModel(model)) {
    return 'anthropic'
  }
  if (isGeminiModel(model)) {
    return 'google'
  }
  if (isGrokModel(model)) {
    return 'xai'
  }
  if (isOpenAIModel(model)) {
    return 'openai'
  }
  logger.warn(`Unknown model type for AI Gateway: ${model.id}. Web search will not be enabled.`)
  return undefined
}

/**
 * 构建 AI SDK 流式参数
 * 这是主要的参数构建函数，整合所有转换逻辑
 */
export async function buildStreamTextParams(
  sdkMessages: StreamTextParams['messages'] = [],
  assistant: Assistant,
  provider: Provider,
  options: {
    mcpTools?: MCPTool[]
    allowedTools?: string[]
    webSearchProviderId?: string
    webSearchConfig?: CherryWebSearchConfig
    requestOptions?: {
      signal?: AbortSignal
      timeout?: number
      headers?: Record<string, string | undefined>
    }
  }
): Promise<{
  params: StreamTextParams
  modelId: string
  capabilities: ProviderCapabilities
  webSearchPluginConfig?: WebSearchPluginConfig
  idleTimeout: IdleTimeoutHandle
}> {
  const { mcpTools, requestOptions = {} } = options
  // No caller currently provides a custom timeout; defaultTimeout (10 min) is the fallback.
  const { signal: externalSignal, timeout = DEFAULT_TIMEOUT, headers: inputHeaders = {} } = requestOptions

  // Use an idle timeout that resets every time a stream chunk is received,
  // instead of a fixed total timeout that starts from the initial request.
  const idleTimeout = new IdleTimeoutController(timeout)
  const signals = [idleTimeout.signal]
  if (externalSignal) {
    signals.push(externalSignal)
  }
  const finalSignal = AbortSignal.any(signals)

  const model = assistant.model || getDefaultModel()
  const aiSdkProviderId = getAiSdkProviderId(provider)

  // 这三个变量透传出来，交给下面启用插件/中间件
  // 也可以在外部构建好再传入buildStreamTextParams
  // FIXME: qwen3即使关闭思考仍然会导致enableReasoning的结果为true
  const enableReasoning =
    ((isSupportedThinkingTokenModel(model) || isSupportedReasoningEffortModel(model)) &&
      assistant.settings?.reasoning_effort !== undefined) ||
    isFixedReasoningModel(model)

  // 判断是否使用内置搜索
  // 条件：没有外部搜索提供商 && (用户开启了内置搜索 || 模型强制使用内置搜索)
  const hasExternalSearch = !!options.webSearchProviderId
  const enableWebSearch =
    !hasExternalSearch &&
    ((assistant.enableWebSearch && isWebSearchModel(model)) ||
      isOpenRouterBuiltInWebSearchModel(model) ||
      model.id.includes('sonar'))

  // Validate provider and model support to prevent stale state from triggering urlContext
  const enableUrlContext = !!(
    assistant.enableUrlContext &&
    isSupportUrlContextProvider(provider) &&
    !isPureGenerateImageModel(model) &&
    (isGeminiModel(model) || isAnthropicModel(model))
  )

  const enableGenerateImage = !!(isGenerateImageModel(model) && assistant.enableGenerateImage)

  const tools = setupToolsConfig(mcpTools, options.allowedTools)

  // 构建真正的 providerOptions
  const webSearchConfig: CherryWebSearchConfig = {
    maxResults: store.getState().websearch.maxResults,
    excludeDomains: store.getState().websearch.excludeDomains,
    searchWithTime: store.getState().websearch.searchWithTime
  }

  const { providerOptions, standardParams } = buildProviderOptions(assistant, model, provider, {
    enableReasoning,
    enableWebSearch,
    enableGenerateImage
  })

  // Web search + URL context 的工具注入由 plugin 系统处理：
  // - webSearchPlugin: 根据 provider 的 toolFactories.webSearch 自动注入
  // - urlContextPlugin: 根据 provider 的 toolFactories.urlContext 自动注入
  // parameterBuilder 只构建 config，传给 plugin
  let webSearchPluginConfig: WebSearchPluginConfig | undefined = undefined
  if (enableWebSearch) {
    if (extensionRegistry.has(aiSdkProviderId)) {
      webSearchPluginConfig = buildProviderBuiltinWebSearchConfig(aiSdkProviderId, webSearchConfig, model)
    } else if (isAIGatewayProvider(provider) || SystemProviderIds.gateway === provider.id) {
      const gatewayProviderId = mapVertexAIGatewayModelToProviderId(model)
      if (gatewayProviderId) {
        webSearchPluginConfig = buildProviderBuiltinWebSearchConfig(gatewayProviderId, webSearchConfig, model)
      }
    }
  }

  let headers = inputHeaders

  if (isAnthropicModel(model) && !isAwsBedrockProvider(provider)) {
    const betaHeaders = addAnthropicHeaders(assistant, model)
    // Only add the anthropic-beta header if there are actual beta headers to include
    if (betaHeaders.length > 0) {
      const newBetaHeaders = { 'anthropic-beta': betaHeaders.join(',') }
      headers = combineHeaders(headers, newBetaHeaders)
    }
  }

  // 构建基础参数
  // Note: standardParams (topK, frequencyPenalty, presencePenalty, stopSequences, seed)
  // are extracted from custom parameters and passed directly to streamText()
  // instead of being placed in providerOptions

  // AI SDK defaults to stepCountIs(1), which would stop after the first tool call.
  // Always pass an explicit cap so native tool use can continue across steps.
  const maxToolCalls = getEffectiveMaxToolCalls(assistant.settings)

  const params: StreamTextParams = {
    messages: sdkMessages,
    maxOutputTokens: getMaxTokens(assistant, model),
    temperature: getTemperature(assistant, model),
    topP: getTopP(assistant, model),
    // Include AI SDK standard params extracted from custom parameters
    // (filtered to drop ones the model rejects, e.g. topK on Claude Opus 4.7)
    ...filterStandardParams(standardParams, model),
    abortSignal: finalSignal,
    headers,
    providerOptions,
    maxRetries: 0
  }

  params.stopWhen = stepCountIs(maxToolCalls)

  if (tools) {
    params.tools = tools
  }

  let systemPrompt = assistant.prompt ? await replacePromptVariables(assistant.prompt, model.name) : ''

  if (getEffectiveMcpMode(assistant) === 'auto') {
    const autoModePrompt = getHubModeSystemPrompt()
    if (autoModePrompt) {
      systemPrompt = systemPrompt ? `${systemPrompt}\n\n${autoModePrompt}` : autoModePrompt
    }
  }

  // [PRISM] 2026-05-14 — Sprint 10-D: 注入 Hermes 用户记忆上下文到 System Prompt
  // 30s 缓存 + 5s 超时，确保不阻塞正常对话流程
  try {
    const hermesCtx = await fetchHermesContextForInjection()
    if (hermesCtx) {
      const hermesPrefix = `[User Memory from Hermes]\n${hermesCtx}\n[End User Memory]\n\n`
      systemPrompt = systemPrompt ? `${hermesPrefix}${systemPrompt}` : hermesPrefix.trimEnd()
      logger.debug(`[Sprint10D] Injected ${hermesCtx.length}c Hermes context into system prompt`)
    }
  } catch {
    // 非阻塞：记忆注入失败不影响正常对话
  }

  if (systemPrompt) {
    params.system = systemPrompt
  }

  logger.debug('params', params)

  return {
    params,
    modelId: model.id,
    capabilities: { enableReasoning, enableWebSearch, enableGenerateImage, enableUrlContext },
    webSearchPluginConfig,
    idleTimeout
  }
}

/**
 * 构建非流式的 generateText 参数
 */
export async function buildGenerateTextParams(
  messages: ModelMessage[],
  assistant: Assistant,
  provider: Provider,
  options: {
    mcpTools?: MCPTool[]
    allowedTools?: string[]
    enableTools?: boolean
  } = {}
): Promise<any> {
  // 复用流式参数的构建逻辑
  return await buildStreamTextParams(messages, assistant, provider, options)
}
