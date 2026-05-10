// [PRISM] 2026-05-10 — Sprint 1: OpenClaw 零配置自动检测服务 (v4)
// ─────────────────────────────────────────────────────────────────────────────
// 根本性修复（v4）：
//   v1-v3 的问题：把 OpenClaw 作为 HTTP REST proxy 注册（apiBase=:18789/v1）
//     → POST /v1/chat/completions 永远返回 404，因为 OpenClaw 是 WebSocket 网关，
//       不暴露任何 REST chat API
//   v4 修复方案：从 ~/.openclaw/openclaw.json 读取各 provider 的 baseUrl/apiKey
//     → 每个 provider 注册为独立的 DetectedEndpoint（直连 Google/DeepSeek/Anthropic/LM-Studio）
//     → 对无 inline apiKey 的 provider（google/deepseek）尝试从 macOS Keychain 读取
// ─────────────────────────────────────────────────────────────────────────────

import { execSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { loggerService } from '@logger'

const logger = loggerService.withContext('PrismAutoSetupService')

/** OpenClaw 本地配置文件路径 */
const OPENCLAW_CONFIG_PATH = path.join(os.homedir(), '.openclaw', 'openclaw.json')

/** 探测 OpenClaw 的端口（优先 18789 — RAO 本地运行实例） */
const OPENCLAW_PORTS = [18789, 18790]

/** 其他 OpenAI 兼容服务（保持 /v1/models 探测） */
const OPENAI_COMPAT_TARGETS: Array<{ port: number; name: string; providerId: string }> = [
  { port: 11434, name: 'Ollama', providerId: 'prism-ollama-11434' }
]

/** openclaw.json 单个 provider 结构 */
interface OpenClawProvider {
  baseUrl?: string
  api?: string
  apiKey?: string
  models?: Array<{ id: string; name?: string }>
}

/** openclaw.json 配置文件（仅用到的字段） */
interface OpenClawConfigFile {
  gateway?: {
    port?: number
    auth?: { mode?: string; token?: string }
  }
  models?: {
    providers?: Record<string, OpenClawProvider>
  }
  auth?: {
    profiles?: Record<string, { provider?: string; mode?: string }>
  }
}

export interface DetectedEndpoint {
  port: number
  name: string
  providerId: string
  apiBase: string
  models: Array<{ id: string; name: string }>
  /** Provider API key（直连每家厂商的 key，非 OpenClaw gateway token） */
  apiKey?: string
  /**
   * Cherry Studio provider type。
   * 'openai'    = OpenAI-compatible REST（DeepSeek / LM-Studio / Google OpenAI-compat）
   * 'anthropic' = Anthropic Messages API
   * @default 'openai'
   */
  providerType?: 'openai' | 'anthropic'
}

// ─────────────────────────────────────────────────────────────────────────────
// macOS Keychain helper
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 尝试从 macOS Keychain 读取 provider API key。
 * OpenClaw 的 profile ID 格式为 "{provider}:default"，因此尝试多种可能的 service/account 组合。
 */
function tryKeychainKey(providerKey: string): string | null {
  if (process.platform !== 'darwin') return null

  const candidates = [
    // OpenClaw 最可能的格式：service="openclaw", account="{provider}:default"
    ['openclaw', `${providerKey}:default`],
    // service="openclaw-{provider}"（无 account 过滤）
    [`openclaw-${providerKey}`, ''],
    // service="{provider}", account="openclaw"
    [providerKey, 'openclaw'],
    // 通用 API key service 名
    [`${providerKey}-api-key`, ''],
    [`${providerKey}-api`, '']
  ]

  for (const [service, account] of candidates) {
    try {
      const accountPart = account ? `-a "${account}"` : ''
      const cmd = `security find-generic-password -s "${service}" ${accountPart} -w 2>/dev/null`
      const result = execSync(cmd, {
        timeout: 3000,
        stdio: ['pipe', 'pipe', 'pipe']
      })
        .toString()
        .trim()
      if (result && result.length > 5) {
        logger.info(
          `[PRISM] ✓ Keychain key found for ${providerKey} (service="${service}"${account ? ` account="${account}"` : ''})`
        )
        return result
      }
    } catch {
      // 未找到，继续尝试下一个
    }
  }

  logger.debug(`[PRISM] No Keychain key found for ${providerKey}`)
  return null
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** 将 openclaw api 字段 + providerKey 映射为 Cherry Studio ProviderType */
function mapProviderType(api: string | undefined, providerKey: string): 'openai' | 'anthropic' {
  if (api === 'anthropic-messages' || providerKey === 'anthropic') return 'anthropic'
  return 'openai'
}

/** provider key → 友好显示名 */
function providerDisplayName(providerKey: string): string {
  const map: Record<string, string> = {
    google: 'Google Gemini',
    deepseek: 'DeepSeek',
    'lm-studio': 'LM Studio（本地）',
    anthropic: 'Anthropic Claude',
    openai: 'OpenAI',
    moonshot: 'Moonshot Kimi',
    ollama: 'Ollama（本地）'
  }
  return map[providerKey] ?? providerKey
}

/**
 * 规范化 baseUrl 为 Cherry Studio 期望的 apiHost。
 * - 如果 URL 已包含非根路径（如 /v1beta/openai/），保持原样。
 * - 纯 host（如 https://api.deepseek.com）→ 追加 /v1（Anthropic 除外）。
 */
function normalizeApiBase(baseUrl: string, api?: string): string {
  const clean = baseUrl.replace(/\/+$/, '')
  try {
    const url = new URL(clean)
    if (url.pathname && url.pathname !== '/') {
      return clean // 已有路径，保持原样
    }
  } catch {
    return clean
  }
  if (api === 'anthropic-messages') return clean
  return `${clean}/v1`
}

// ─────────────────────────────────────────────────────────────────────────────
// OpenClaw probe（v4）：每个 provider → 独立 DetectedEndpoint
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 探测 OpenClaw 实例（v4）
 *
 * 策略：
 * 1. GET /health → {"ok":true,"status":"live"} 确认存活
 * 2. 读取 ~/.openclaw/openclaw.json → models.providers
 * 3. 为每个 provider 构建独立 DetectedEndpoint，使用其真实 baseUrl 直连
 * 4. apiKey 来源：openclaw.json inline → macOS Keychain → 跳过该 provider
 *
 * 返回：每个有效 provider 对应一个 DetectedEndpoint
 * （port 字段记录 OpenClaw 端口，供 PrismAutoSetup.tsx 更新 openclaw store）
 */
async function probeOpenClaw(port: number): Promise<DetectedEndpoint[]> {
  // Step 1: 健康检查
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(2000)
    })
    if (!res.ok) return []
    const data = (await res.json()) as { ok?: boolean; status?: string }
    if (!data.ok || data.status !== 'live') {
      logger.debug(`[PRISM] Port ${port} /health unexpected payload: ${JSON.stringify(data)}`)
      return []
    }
  } catch (err) {
    logger.debug(
      `[PRISM] Port ${port} health probe failed: ${err instanceof Error ? err.message : String(err)}`
    )
    return []
  }

  logger.info(`[PRISM] ✓ OpenClaw alive on port ${port}`)

  // Step 2: 读取 openclaw.json
  let config: OpenClawConfigFile | null = null
  try {
    if (fs.existsSync(OPENCLAW_CONFIG_PATH)) {
      const raw = fs.readFileSync(OPENCLAW_CONFIG_PATH, 'utf-8')
      config = JSON.parse(raw) as OpenClawConfigFile
      logger.info('[PRISM] ✓ Read openclaw.json')
    }
  } catch (err) {
    logger.warn(
      `[PRISM] Could not read openclaw.json: ${err instanceof Error ? err.message : String(err)}`
    )
    return []
  }

  if (!config) {
    logger.warn('[PRISM] openclaw.json not found or unreadable')
    return []
  }

  const providers = config.models?.providers ?? {}
  if (Object.keys(providers).length === 0) {
    logger.warn('[PRISM] openclaw.json has no providers defined')
    return []
  }

  // Step 3 & 4: 为每个 provider 构建 DetectedEndpoint
  const endpoints: DetectedEndpoint[] = []

  for (const [providerKey, providerConf] of Object.entries(providers)) {
    const baseUrl = providerConf.baseUrl
    if (!baseUrl) {
      logger.debug(`[PRISM] Provider ${providerKey}: no baseUrl, skipping`)
      continue
    }

    // 构建模型列表（使用 openclaw.json 中的真实模型 ID，不加 provider 前缀）
    if (!Array.isArray(providerConf.models) || providerConf.models.length === 0) {
      logger.debug(`[PRISM] Provider ${providerKey}: no models defined, skipping`)
      continue
    }
    const models = providerConf.models.map((m) => ({ id: m.id, name: m.name ?? m.id }))

    // 获取 apiKey：inline → Keychain → skip
    let apiKey = providerConf.apiKey?.trim() ?? undefined
    if (!apiKey) {
      const keychainKey = tryKeychainKey(providerKey)
      if (keychainKey) {
        apiKey = keychainKey
      } else {
        logger.warn(
          `[PRISM] Provider ${providerKey}: no apiKey found (inline or Keychain) — skipping registration`
        )
        continue
      }
    }

    const apiBase = normalizeApiBase(baseUrl, providerConf.api)
    const providerType = mapProviderType(providerConf.api, providerKey)
    const displayName = providerDisplayName(providerKey)

    endpoints.push({
      port,
      name: displayName,
      providerId: `prism-openclaw-${providerKey}`,
      apiBase,
      models,
      apiKey,
      providerType
    })

    logger.info(
      `[PRISM] ✓ Provider ${providerKey}: ${models.length} model(s), type=${providerType}, apiBase=${apiBase}`
    )
  }

  logger.info(`[PRISM] OpenClaw port ${port}: ${endpoints.length} provider(s) ready`)
  return endpoints
}

// ─────────────────────────────────────────────────────────────────────────────
// Standard OpenAI-compatible probe（Ollama 等）
// ─────────────────────────────────────────────────────────────────────────────

async function probeOpenAICompatible(
  port: number,
  name: string,
  providerId: string
): Promise<DetectedEndpoint | null> {
  const apiBase = `http://127.0.0.1:${port}/v1`
  try {
    const res = await fetch(`${apiBase}/models`, {
      signal: AbortSignal.timeout(2000),
      headers: { 'Content-Type': 'application/json' }
    })
    if (!res.ok) {
      logger.debug(`Port ${port} responded with HTTP ${res.status}, skipping`)
      return null
    }
    const data = (await res.json()) as {
      data?: Array<{ id: string; object?: string; name?: string }>
    }
    const rawModels = data.data ?? []
    if (rawModels.length === 0) {
      logger.debug(`Port ${port} returned empty model list, skipping`)
      return null
    }
    const models = rawModels.map((m) => ({ id: m.id, name: m.name ?? m.id }))
    logger.info(`✅ Detected ${name} on port ${port}: ${models.length} model(s)`)
    return { port, name, providerId, apiBase, models, providerType: 'openai' }
  } catch (err) {
    logger.debug(`Port ${port} not reachable: ${err instanceof Error ? err.message : String(err)}`)
    return null
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Public entry point
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 自动检测本地 AI 服务（v4）
 * 并发探测 OpenClaw（逐 provider 直连）+ Ollama 等（/v1/models 策略）
 */
export async function detectLocalAIServices(): Promise<DetectedEndpoint[]> {
  logger.info('[PRISM] Starting local AI service auto-detection (v4)...')

  const [openclawResults, openaiResults] = await Promise.all([
    Promise.all(OPENCLAW_PORTS.map((p) => probeOpenClaw(p))),
    Promise.all(OPENAI_COMPAT_TARGETS.map((t) => probeOpenAICompatible(t.port, t.name, t.providerId)))
  ])

  const detected: DetectedEndpoint[] = [
    ...openclawResults.flat(),
    ...openaiResults.filter((r): r is DetectedEndpoint => r !== null)
  ]

  if (detected.length === 0) {
    logger.info('[PRISM] No local AI services detected')
  } else {
    logger.info(`[PRISM] Auto-detection complete: ${detected.length} endpoint(s) found`, {
      services: detected.map((d) => `${d.name} [${d.providerType ?? 'openai'}] × ${d.models.length} models`)
    })
  }
  return detected
}
