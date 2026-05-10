// [PRISM] 2026-05-10 — Sprint 1: OpenClaw 零配置自动检测服务 (v3)
// 修复 v2 bug：providerConf.models 实际不存在（providers 只有 baseUrl/api 字段）
//   → v3 改为独立步骤：先用 bearer token 请求 /v1/models，再 fallback 到 provider keys
// [PRISM] 2026-05-10 — Sprint 1 Fix v3: robust model discovery for OpenClaw

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

interface OpenClawConfigFile {
  gateway?: {
    port?: number
    auth?: { mode?: string; token?: string }
  }
  models?: {
    providers?: Record<string, {
      baseUrl?: string
      api?: string
      // models 数组是可选的 — 实际 openclaw.json 中 providers 可能只有 baseUrl/api
      models?: Array<{ id: string; name?: string }>
    }>
  }
}

export interface DetectedEndpoint {
  port: number
  name: string
  providerId: string
  apiBase: string
  models: Array<{ id: string; name: string }>
  /** Gateway auth token (for protected endpoints like OpenClaw) */
  apiKey?: string
}

/**
 * 探测 OpenClaw 实例
 *
 * 策略（v3，各步骤独立 try/catch，互不干扰）：
 * 1. GET /health → {"ok":true,"status":"live"} 确认存活
 * 2. 读取 ~/.openclaw/openclaw.json → 获取 gateway.auth.token
 * 3. 带 Bearer token 请求 /v1/models（检查 content-type 避免 HTML 解析异常）
 * 4. 若 /v1/models 无结果，fallback：从 config providers keys 构建模型列表
 * 5. 无论 models 是否为空，返回 DetectedEndpoint（允许用户后续手动配置）
 */
async function probeOpenClaw(port: number): Promise<DetectedEndpoint | null> {
  // Step 1: 健康检查（轻量、无需鉴权）
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(2000)
    })
    if (!res.ok) return null
    const data = (await res.json()) as { ok?: boolean; status?: string }
    if (!data.ok || data.status !== 'live') {
      logger.debug(`[PRISM] Port ${port} /health unexpected payload: ${JSON.stringify(data)}`)
      return null
    }
  } catch (err) {
    logger.debug(`[PRISM] Port ${port} health probe failed: ${err instanceof Error ? err.message : String(err)}`)
    return null
  }

  // Step 2: 读取 token（独立 try/catch，失败不影响后续步骤）
  let apiKey = ''
  try {
    if (fs.existsSync(OPENCLAW_CONFIG_PATH)) {
      const raw = fs.readFileSync(OPENCLAW_CONFIG_PATH, 'utf-8')
      const config = JSON.parse(raw) as OpenClawConfigFile
      apiKey = config.gateway?.auth?.token ?? ''
      logger.info(`[PRISM] Read OpenClaw config: token=${apiKey ? '✓' : '×'}`)
    }
  } catch (err) {
    logger.warn(`[PRISM] Could not read OpenClaw config: ${err instanceof Error ? err.message : String(err)}`)
  }

  // Step 3: 带 token 请求 /v1/models（检查 content-type，避免 HTML 误解析）
  let models: Array<{ id: string; name: string }> = []
  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`
    const res = await fetch(`http://127.0.0.1:${port}/v1/models`, {
      signal: AbortSignal.timeout(3000),
      headers
    })
    if (res.ok) {
      const contentType = res.headers.get('content-type') ?? ''
      if (contentType.includes('application/json')) {
        const data = (await res.json()) as { data?: Array<{ id: string; name?: string }> }
        models = (data.data ?? []).map((m) => ({ id: m.id, name: m.name ?? m.id }))
        logger.info(`[PRISM] /v1/models → ${models.length} model(s)`)
      } else {
        logger.debug(`[PRISM] /v1/models non-JSON response (content-type: ${contentType}), skipping`)
      }
    }
  } catch (err) {
    logger.debug(`[PRISM] /v1/models fetch failed: ${err instanceof Error ? err.message : String(err)}`)
  }

  // Step 4: fallback — 从 openclaw.json providers keys 构建模型列表
  if (models.length === 0) {
    try {
      if (fs.existsSync(OPENCLAW_CONFIG_PATH)) {
        const raw = fs.readFileSync(OPENCLAW_CONFIG_PATH, 'utf-8')
        const config = JSON.parse(raw) as OpenClawConfigFile
        const providers = config.models?.providers ?? {}
        for (const [providerKey, providerConf] of Object.entries(providers)) {
          if (Array.isArray(providerConf.models) && providerConf.models.length > 0) {
            // 如果 provider 确实带了模型列表
            for (const m of providerConf.models) {
              models.push({ id: `${providerKey}/${m.id}`, name: m.name ?? m.id })
            }
          } else {
            // 用 providerKey 本身作为占位模型 ID
            models.push({ id: providerKey, name: providerKey })
          }
        }
        logger.info(`[PRISM] Fallback: ${models.length} model(s) from provider keys`)
      }
    } catch (err) {
      logger.debug(`[PRISM] Provider-key fallback failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  logger.info(`✅ [PRISM] Detected OpenClaw on port ${port}: ${models.length} model(s), token=${apiKey ? '✓' : '×'}`)
  return {
    port,
    name: `OpenClaw (本地 :${port})`,
    providerId: `prism-openclaw-${port}`,
    apiBase: `http://127.0.0.1:${port}/v1`,
    models,
    apiKey: apiKey || undefined
  }
}

/**
 * 探测标准 OpenAI 兼容服务（Ollama 等）
 * 调用 /v1/models 获取模型列表
 */
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
    return { port, name, providerId, apiBase, models }
  } catch (err) {
    logger.debug(`Port ${port} not reachable: ${err instanceof Error ? err.message : String(err)}`)
    return null
  }
}

/**
 * 自动检测本地 AI 服务
 * 并发探测 OpenClaw（/health 策略）+ Ollama 等（/v1/models 策略）
 */
export async function detectLocalAIServices(): Promise<DetectedEndpoint[]> {
  logger.info('Starting local AI service auto-detection...')

  const [openclawResults, openaiResults] = await Promise.all([
    Promise.all(OPENCLAW_PORTS.map((p) => probeOpenClaw(p))),
    Promise.all(OPENAI_COMPAT_TARGETS.map((t) => probeOpenAICompatible(t.port, t.name, t.providerId)))
  ])

  const detected: DetectedEndpoint[] = [
    ...openclawResults.filter((r): r is DetectedEndpoint => r !== null),
    ...openaiResults.filter((r): r is DetectedEndpoint => r !== null)
  ]

  if (detected.length === 0) {
    logger.info('No local AI services detected')
  } else {
    logger.info(`Auto-detection complete: ${detected.length} service(s) found`, {
      services: detected.map((d) => `${d.name}:${d.port}`)
    })
  }
  return detected
}
