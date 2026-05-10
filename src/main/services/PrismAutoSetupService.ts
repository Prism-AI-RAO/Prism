// [PRISM] 2026-05-10 — Sprint 1: OpenClaw 零配置自动检测服务
// 作用：Prism 启动时自动探测本地运行的 OpenAI 兼容服务，无需用户手动配置

import { loggerService } from '@logger'

const logger = loggerService.withContext('PrismAutoSetupService')

/** 探测的本地端口列表（优先级从高到低） */
const PROBE_TARGETS: Array<{ port: number; name: string; providerId: string }> = [
  { port: 18789, name: 'OpenClaw (本地)', providerId: 'prism-openclaw-18789' },
  { port: 18790, name: 'OpenClaw (网关)', providerId: 'prism-openclaw-18790' },
  { port: 11434, name: 'Ollama', providerId: 'prism-ollama-11434' }
]

export interface DetectedEndpoint {
  port: number
  name: string
  providerId: string
  apiBase: string
  models: Array<{ id: string; name: string }>
}

/**
 * 探测单个端口是否有 OpenAI 兼容 API 在运行
 * 调用 /v1/models 获取模型列表
 */
async function probeEndpoint(
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
    const models = rawModels.map((m) => ({
      id: m.id,
      name: m.name ?? m.id
    }))
    logger.info(`Detected ${name} on port ${port}: ${models.length} models`)
    return { port, name, providerId, apiBase, models }
  } catch (err) {
    // 连接拒绝、超时等都是正常情况（服务未运行）
    logger.debug(`Port ${port} not reachable: ${err instanceof Error ? err.message : String(err)}`)
    return null
  }
}

/**
 * 自动检测本地 AI 服务
 * 并发探测所有目标端口，收集成功结果
 */
export async function detectLocalAIServices(): Promise<DetectedEndpoint[]> {
  logger.info('Starting local AI service auto-detection...')
  const results = await Promise.all(
    PROBE_TARGETS.map((t) => probeEndpoint(t.port, t.name, t.providerId))
  )
  const detected = results.filter((r): r is DetectedEndpoint => r !== null)
  if (detected.length === 0) {
    logger.info('No local AI services detected')
  } else {
    logger.info(`Auto-detection complete: ${detected.length} service(s) found`, {
      services: detected.map((d) => `${d.name}:${d.port}`)
    })
  }
  return detected
}
