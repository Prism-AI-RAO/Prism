// [PRISM] 2026-05-11 — Sprint 3-B: MEMORY.md / USER.md 文件服务
// ─────────────────────────────────────────────────────────────────────────────
// 管理 ~/.prism/memory/ 目录下的两个人类可读记忆文件：
//
//   MEMORY.md — AI 跨会话积累的关于用户的知识（由 AI 写入）
//   USER.md   — 用户主动填写的关于自己的信息（由用户写入，AI 只读）
//
// 这两个文件在每次会话开始时由 prism_memory_read_context MCP 工具注入到 AI 上下文中，
// 实现"越用越懂你"的核心体验。
// ─────────────────────────────────────────────────────────────────────────────

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { loggerService } from '@logger'

const logger = loggerService.withContext('PrismMemoryFileService')

/** Prism 记忆文件根目录 */
const PRISM_MEMORY_DIR = path.join(os.homedir(), '.prism', 'memory')
const MEMORY_MD_PATH = path.join(PRISM_MEMORY_DIR, 'MEMORY.md')
const USER_MD_PATH = path.join(PRISM_MEMORY_DIR, 'USER.md')

/** USER.md 初始模板 — 引导用户填写 */
const USER_MD_TEMPLATE = `# About Me

> This file is yours. Fill it in so Prism can know you better from day one.
> AI assistants will read this at the start of every conversation.

## Role & Work
<!-- e.g. "Founder of a tech startup building AI productivity tools" -->

## Goals & Projects
<!-- e.g. "Building Prism — an AI desktop app for non-technical users" -->

## Preferences
<!-- e.g. "Prefer concise replies. Use Chinese for casual chat, English for code." -->

## Context
<!-- Any other things you want AI to always know about you -->
`

/** MEMORY.md 初始模板 */
const MEMORY_MD_TEMPLATE = `# Prism Memory

> This file is maintained by your AI assistant. It grows as you use Prism.
> Entries are added automatically when the AI learns something important about you.

`

/** A single parsed memory fragment from MEMORY.md */
export interface MemoryFragment {
  id: string        // sha1-prefix of content
  content: string
  timestamp?: string
  tags?: string[]
}

// ── Ensure directory exists ───────────────────────────────────────────────────

function ensureMemoryDir(): void {
  if (!fs.existsSync(PRISM_MEMORY_DIR)) {
    fs.mkdirSync(PRISM_MEMORY_DIR, { recursive: true })
    logger.info(`[MemoryFileService] Created ~/.prism/memory/`)
  }
}

// ── MEMORY.md operations ─────────────────────────────────────────────────────

/**
 * Read the full contents of MEMORY.md.
 * Returns null if the file doesn't exist yet.
 */
export function readMemoryMd(): { content: string | null; sizeBytes: number | null } {
  try {
    if (!fs.existsSync(MEMORY_MD_PATH)) return { content: null, sizeBytes: null }
    const content = fs.readFileSync(MEMORY_MD_PATH, 'utf-8')
    return { content, sizeBytes: Buffer.byteLength(content, 'utf-8') }
  } catch (error) {
    logger.error('[MemoryFileService] Failed to read MEMORY.md:', error as Error)
    return { content: null, sizeBytes: null }
  }
}

/**
 * Append a new memory entry to MEMORY.md.
 * Creates the file with template if it doesn't exist.
 * Format: ISO timestamp + content + optional tags
 */
export function appendMemoryEntry(content: string, tags?: string[]): void {
  ensureMemoryDir()

  const timestamp = new Date().toISOString().slice(0, 16).replace('T', ' ')
  const tagLine = tags && tags.length > 0 ? `\n**Tags**: ${tags.map((t) => `\`${t}\``).join(', ')}` : ''
  const entry = `\n---\n\n**${timestamp}**${tagLine}\n\n${content.trim()}\n`

  if (!fs.existsSync(MEMORY_MD_PATH)) {
    fs.writeFileSync(MEMORY_MD_PATH, MEMORY_MD_TEMPLATE + entry, 'utf-8')
    logger.info('[MemoryFileService] Created MEMORY.md with first entry')
  } else {
    fs.appendFileSync(MEMORY_MD_PATH, entry, 'utf-8')
    logger.debug('[MemoryFileService] Appended entry to MEMORY.md')
  }
}

/**
 * Overwrite the entire MEMORY.md with new content.
 * Used by the "Dreaming" consolidation feature (Sprint 4).
 */
export function writeMemoryMd(content: string): void {
  ensureMemoryDir()
  fs.writeFileSync(MEMORY_MD_PATH, content, 'utf-8')
  logger.info(`[MemoryFileService] Wrote MEMORY.md (${Buffer.byteLength(content, 'utf-8')} bytes)`)
}

/**
 * Parse MEMORY.md into individual fragments split by `---` dividers.
 * Strips the header template section.
 */
export function parseMemoryFragments(): MemoryFragment[] {
  const { content } = readMemoryMd()
  if (!content) return []

  const fragments: MemoryFragment[] = []
  const sections = content.split(/\n---\n/)

  for (const section of sections) {
    const trimmed = section.trim()
    if (!trimmed || trimmed.startsWith('# Prism Memory') || trimmed.startsWith('>')) continue

    // Extract timestamp line (bold **YYYY-MM-DD HH:MM**)
    const tsMatch = trimmed.match(/^\*\*(\d{4}-\d{2}-\d{2} \d{2}:\d{2})\*\*/)
    const timestamp = tsMatch?.[1]

    // Extract tags
    const tagsMatch = trimmed.match(/\*\*Tags\*\*:\s*(.+)/)
    const tags = tagsMatch
      ? tagsMatch[1].match(/`([^`]+)`/g)?.map((t) => t.replace(/`/g, '')) ?? []
      : []

    // Extract body (everything after the header lines)
    const bodyLines = trimmed.split('\n').filter((l) => {
      if (tsMatch && l.trim() === tsMatch[0]) return false
      if (tagsMatch && l.includes('**Tags**:')) return false
      return l.trim().length > 0
    })
    const body = bodyLines.join('\n').trim()
    if (!body) continue

    // Generate deterministic ID from content
    const id = Buffer.from(body).toString('base64').slice(0, 12)
    fragments.push({ id, content: body, timestamp, tags })
  }

  return fragments
}

// ── USER.md operations ────────────────────────────────────────────────────────

/**
 * Read the full contents of USER.md.
 * Creates it from template if it doesn't exist.
 */
export function readUserMd(): { content: string; isNew: boolean } {
  ensureMemoryDir()

  if (!fs.existsSync(USER_MD_PATH)) {
    fs.writeFileSync(USER_MD_PATH, USER_MD_TEMPLATE, 'utf-8')
    logger.info('[MemoryFileService] Created USER.md from template')
    return { content: USER_MD_TEMPLATE, isNew: true }
  }

  const content = fs.readFileSync(USER_MD_PATH, 'utf-8')
  return { content, isNew: false }
}

/**
 * Write USER.md content.
 */
export function writeUserMd(content: string): void {
  ensureMemoryDir()
  fs.writeFileSync(USER_MD_PATH, content, 'utf-8')
  logger.info(`[MemoryFileService] Wrote USER.md (${Buffer.byteLength(content, 'utf-8')} bytes)`)
}

// ── Combined context read ─────────────────────────────────────────────────────

/**
 * Read both MEMORY.md and USER.md as a combined context string.
 * This is what gets injected into the AI's system prompt at conversation start.
 *
 * Returns null if neither file exists (fresh install, no context yet).
 */
export function readCombinedContext(): string | null {
  const { content: memoryContent } = readMemoryMd()
  const userFile = fs.existsSync(USER_MD_PATH)
    ? fs.readFileSync(USER_MD_PATH, 'utf-8')
    : null

  const parts: string[] = []

  if (userFile) {
    const stripped = userFile
      .split('\n')
      .filter((l) => !l.trim().startsWith('>') && !l.trim().startsWith('<!--'))
      .join('\n')
      .trim()
    if (stripped && stripped !== '# About Me') {
      parts.push('## User Profile\n\n' + stripped)
    }
  }

  if (memoryContent) {
    // Only include the memory entries (strip template header)
    const memoryEntries = memoryContent.split(/\n---\n/).slice(1).join('\n---\n').trim()
    if (memoryEntries) {
      parts.push('## Memory\n\n' + memoryEntries)
    }
  }

  if (parts.length === 0) return null

  return `# Prism: What I Know About You\n\n${parts.join('\n\n')}`
}

// ── File path helpers (for IPC) ───────────────────────────────────────────────

export const PRISM_MEMORY_PATHS = {
  dir: PRISM_MEMORY_DIR,
  memoryMd: MEMORY_MD_PATH,
  userMd: USER_MD_PATH
} as const

// ── Stats ─────────────────────────────────────────────────────────────────────

export function getMemoryFileStats(): {
  fragmentCount: number
  memorySizeBytes: number | null
  userMdExists: boolean
  userMdSizeBytes: number | null
} {
  const fragments = parseMemoryFragments()
  const { sizeBytes: memorySizeBytes } = readMemoryMd()
  const userMdExists = fs.existsSync(USER_MD_PATH)
  let userMdSizeBytes: number | null = null
  if (userMdExists) {
    try {
      userMdSizeBytes = fs.statSync(USER_MD_PATH).size
    } catch {
      // ignore
    }
  }
  return { fragmentCount: fragments.length, memorySizeBytes, userMdExists, userMdSizeBytes }
}
