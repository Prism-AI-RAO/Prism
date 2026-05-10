// [PRISM] 2026-05-10 — Sprint 1: OpenClaw 零配置自动检测服务 (v2)
// 修复：OpenClaw 不暴露无鉴权的 /v1/models（SPA 拦截或需 token）
//       改用 /health 探测 + 读取 ~/.openclaw/openclaw.json 获取 token + 模型列表
// [PRISM] 2026-05-10 — Sprint 1 Fix: Use /health for OpenClaw, read config for token & models

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
    auth?: { token?: string }
  }
  models?: {
    providers?: Record<string, {
      models: Array<{ id: string; name?: string }>
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
 * 策略：
 * 1. GET /health → {"ok":true,"status":"live"} 确认存活
 * 2. 读取 ~/.openclaw/openclaw.json 获取 gateway token 和模型列表
 * 3. 若配置文件不存在，fallback 到带 token 的 /v1/models
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
      logger.debug(`Port ${port} /health returned unexpected payload: ${JSON.stringify(data)}`)
      return null
    }
  } catch (err) {
    logger.debug(`Port ${port} OpenClaw health probe failed: ${err instanceof Error ? err.message : String(err)}`)
    return null
  }

  // Step 2: 读取本地配置获取 token + 模型列表
  let apiKey = ''
  let models: Array<{ id: string; name: string }> = []

  try {
    const raw = fs.readFileSync(OPENCLAW_CONFIG_PATH, 'utf-8')
    const config = JSON.parse(raw) as OpenClawConfigFile
    apiKey = config.gateway?.auth?.token ?? ''
    const providers = config.models?.providers ?? {}
    for (const [providerKey, providerConf] of Object.entries(providers)) {
      for (const m of providerConf.models) {
        // OpenClaw 以 "providerKey/modelId" 形式路由请求
        models.push({ id: `${providerKey}/${m.id}`, name: m.name ?? m.id })
      }
    }
    logger.info(`Read OpenClaw config: token=${apiKey ? '✓' : '×'}, models=${models.length}`)
  } catch {
    logger.debug(`OpenClaw config not found at ${OPENCLAW_CONFIG_PATH}, trying /v1/models fallback`)
    // Step 3: fallback — 尝试带 token 的 /v1/models（token 此时为空串，可能仍失败）
    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' }
      if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`
      const res = await fetch(`http://127.0.0.1:${port}/v1/models`, {
        signal: AbortSignal.timeout(2000),
        headers
      })
      if (res.ok) {
        const data = (await res.json()) as { data?: Array<{ id: string; name?: string }> }
        models = (data.data ?? []).map((m) => ({ id: m.id, name: m.name ?? m.id }))
      }
    } catch {
      // 静默忽略，模型列表为空也能注册 provider
    }
  }

  logger.info(`✅ Detected OpenClaw on port ${port}: ${models.length} model(s)`)
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
