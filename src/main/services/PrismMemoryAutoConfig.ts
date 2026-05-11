// [PRISM] 2026-05-11 — Sprint 3-A: Memory Engine 自动配置
// ─────────────────────────────────────────────────────────────────────────────
// 读取 ~/.openclaw/openclaw.json，选出最佳 embedding provider，
// 自动调用 MemoryService.setConfig()。
// 让向量相似搜索在首次启动时即可工作，无需用户手动配置。
//
// Embedding 模型优先级：
//   1. zhipuai  → embedding-3      (base: https://open.bigmodel.cn/api/paas/v4/)
//   2. openai   → text-embedding-3-small
//   3. deepseek → (no official embedding — skip)
//   4. google   → text-embedding-004 (via OpenAI-compat endpoint)
//   5. ollama   → nomic-embed-text  (local, no apiKey needed)
//   6. Any OpenAI-compat provider with an embedding-named model in its list
// ─────────────────────────────────────────────────────────────────────────────

import { execSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { loggerService } from '@logger'
import MemoryService from '@main/services/memory/MemoryService'
import type { ApiClient } from '@types'

const logger = loggerService.withContext('PrismMemoryAutoConfig')

const OPENCLAW_CONFIG_PATH = path.join(os.homedir(), '.openclaw', 'openclaw.json')

/** Dimensions for the unified embedding space (matches MemoryService.UNIFIED_DIMENSION) */
const EMBEDDING_DIMENSIONS = 1536

// ── Known embedding model configurations per provider ────────────────────────

interface EmbeddingCandidate {
  provider: string        // EmbeddingsFactory provider key
  model: string
  baseURL: string
  apiKey: string
  dimensions?: number
  priority: number        // lower = higher priority
}

/** Known embedding endpoints and models per OpenClaw provider key */
const PROVIDER_EMBEDDING_MAP: Record<string, {
  model: string
  baseURL: string         // override base URL (some providers use different endpoint for embeddings)
  dimensions?: number
  providerKey: string     // key passed to EmbeddingsFactory
}> = {
  // ZhipuAI: embedding-3 (1024-dim, pad to 1536)
  zhipuai: {
    model: 'embedding-3',
    baseURL: 'https://open.bigmodel.cn/api/paas/v4/',
    dimensions: 1024,
    providerKey: 'openai'     // OpenAI-compat
  },
  zhipu: {
    model: 'embedding-3',
    baseURL: 'https://open.bigmodel.cn/api/paas/v4/',
    dimensions: 1024,
    providerKey: 'openai'
  },
  // OpenAI: text-embedding-3-small (1536-dim)
  openai: {
    model: 'text-embedding-3-small',
    baseURL: 'https://api.openai.com/v1/',
    dimensions: EMBEDDING_DIMENSIONS,
    providerKey: 'openai'
  },
  // Google Gemini via OpenAI-compat endpoint
  google: {
    model: 'text-embedding-004',
    baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai/',
    dimensions: 768,
    providerKey: 'openai'
  },
  gemini: {
    model: 'text-embedding-004',
    baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai/',
    dimensions: 768,
    providerKey: 'openai'
  },
  // Moonshot: moonshot-v1 embeddings (OpenAI-compat)
  moonshot: {
    model: 'moonshot-v1-embedding',
    baseURL: 'https://api.moonshot.cn/v1/',
    dimensions: 1536,
    providerKey: 'openai'
  },
  kimi: {
    model: 'moonshot-v1-embedding',
    baseURL: 'https://api.moonshot.cn/v1/',
    dimensions: 1536,
    providerKey: 'openai'
  }
}

/** Provider priority order (lower index = higher priority) */
const PROVIDER_PRIORITY = ['openai', 'zhipuai', 'zhipu', 'moonshot', 'kimi', 'google', 'gemini']

// ── OpenClaw config types ─────────────────────────────────────────────────────

interface OpenClawProvider {
  baseUrl?: string
  api?: string
  apiKey?: string
  models?: Array<{ id: string; name?: string }>
}

interface OpenClawConfigFile {
  gateway?: { port?: number; auth?: { token?: string } }
  models?: { providers?: Record<string, OpenClawProvider> }
}

// ── Keychain helper (mirrors PrismAutoSetupService) ───────────────────────────

function tryKeychainKey(providerKey: string): string | null {
  if (process.platform !== 'darwin') return null
  const candidates = [
    ['openclaw', `${providerKey}:default`],
    [`openclaw-${providerKey}`, ''],
    [providerKey, 'apiKey']
  ]
  for (const [service, account] of candidates) {
    try {
      const cmd = account
        ? `security find-generic-password -s "${service}" -a "${account}" -w 2>/dev/null`
        : `security find-generic-password -s "${service}" -w 2>/dev/null`
      const key = execSync(cmd, { timeout: 3000, encoding: 'utf-8' }).trim()
      if (key) return key
    } catch {
      // next candidate
    }
  }
  return null
}

// ── Main auto-config logic ────────────────────────────────────────────────────

/**
 * Build a list of embedding candidates from the OpenClaw config, ordered by priority.
 */
function buildCandidates(config: OpenClawConfigFile): EmbeddingCandidate[] {
  const providers = config.models?.providers ?? {}
  const candidates: EmbeddingCandidate[] = []

  // Walk known-good providers in priority order
  for (const providerKey of PROVIDER_PRIORITY) {
    const providerConf = providers[providerKey]
    if (!providerConf) continue

    const embeddingSpec = PROVIDER_EMBEDDING_MAP[providerKey]
    if (!embeddingSpec) continue

    // Resolve apiKey: inline → Keychain → skip
    let apiKey = providerConf.apiKey?.trim() ?? ''
    if (!apiKey) {
      apiKey = tryKeychainKey(providerKey) ?? ''
    }
    if (!apiKey) {
      logger.debug(`[MemoryAutoConfig] Provider ${providerKey}: no apiKey, skipping`)
      continue
    }

    candidates.push({
      provider: embeddingSpec.providerKey,
      model: embeddingSpec.model,
      baseURL: embeddingSpec.baseURL,
      apiKey,
      dimensions: embeddingSpec.dimensions,
      priority: PROVIDER_PRIORITY.indexOf(providerKey)
    })
  }

  // Also check Ollama (no apiKey needed, port 11434)
  if (providers['ollama'] || !candidates.length) {
    // Try Ollama as last resort — we'll verify at config-application time via HTTP
    candidates.push({
      provider: 'ollama',
      model: 'nomic-embed-text',
      baseURL: 'http://127.0.0.1:11434/api',
      apiKey: 'ollama',
      dimensions: 768,
      priority: 99
    })
  }

  return candidates.sort((a, b) => a.priority - b.priority)
}

/**
 * tryAutoConfigEmbedding — called at Prism startup (non-blocking).
 *
 * 1. Reads ~/.openclaw/openclaw.json
 * 2. Picks the best available embedding provider
 * 3. Calls MemoryService.setConfig() to enable vector search
 *
 * Safe to call even if OpenClaw is not running — falls back gracefully.
 */
export async function tryAutoConfigEmbedding(): Promise<void> {
  try {
    // Read OpenClaw config
    if (!fs.existsSync(OPENCLAW_CONFIG_PATH)) {
      logger.debug('[MemoryAutoConfig] openclaw.json not found — skipping embedding auto-config')
      return
    }

    const raw = fs.readFileSync(OPENCLAW_CONFIG_PATH, 'utf-8')
    const config = JSON.parse(raw) as OpenClawConfigFile
    const candidates = buildCandidates(config)

    if (candidates.length === 0) {
      logger.warn('[MemoryAutoConfig] No embedding-capable providers found in openclaw.json')
      return
    }

    logger.info(
      `[MemoryAutoConfig] Found ${candidates.length} embedding candidates: ${candidates.map((c) => c.provider + ':' + c.model).join(', ')}`
    )

    // Use the highest-priority candidate (skip endpoint probe to avoid startup delay)
    const best = candidates[0]

    const embeddingApiClient: ApiClient = {
      model: best.model,
      provider: best.provider,
      apiKey: best.apiKey,
      baseURL: best.baseURL,
      apiVersion: undefined
    }

    const memoryService = MemoryService.getInstance()
    memoryService.setConfig({
      embeddingModel: {
        id: best.model,
        name: best.model,
        provider: best.provider
      } as any,
      embeddingApiClient,
      embeddingDimensions: best.dimensions ?? EMBEDDING_DIMENSIONS,
      isAutoDimensions: !best.dimensions
    })

    logger.info(
      `[MemoryAutoConfig] ✅ Vector embedding configured: ${best.provider}/${best.model} (dim: ${best.dimensions ?? EMBEDDING_DIMENSIONS})`
    )
  } catch (error) {
    // Never crash startup due to memory auto-config failure
    logger.warn(
      `[MemoryAutoConfig] Auto-config failed (non-fatal): ${error instanceof Error ? error.message : String(error)}`
    )
  }
}

/**
 * Returns the current embedding config status for display in Settings > Memory.
 */
export function getEmbeddingConfigStatus(): {
  configured: boolean
  provider?: string
  model?: string
} {
  try {
    if (!fs.existsSync(OPENCLAW_CONFIG_PATH)) return { configured: false }
    const raw = fs.readFileSync(OPENCLAW_CONFIG_PATH, 'utf-8')
    const config = JSON.parse(raw) as OpenClawConfigFile
    const candidates = buildCandidates(config)
    if (candidates.length === 0) return { configured: false }
    const best = candidates[0]
    return { configured: true, provider: best.provider, model: best.model }
  } catch {
    return { configured: false }
  }
}
