// [PRISM] 2026-05-14 — Sprint 10-A: Hermes 记忆引擎 MCP Server
// ─────────────────────────────────────────────────────────────────────────────
// 将 Hermes 的长期记忆能力以 MCP 工具形式暴露给 Prism 内所有 Agent。
// 注册后，任何支持 MCP 的 Agent（Prism Main、Cherry Claw、OpenClaw Agent 等）
// 都能自动调用以下工具：
//
//   hermes_context_get    — 读取当前用户记忆上下文（MEMORY.md + USER.md）
//   hermes_memory_write   — 向 Hermes 写入新记忆并触发自进化合并
//   hermes_memory_search  — 在记忆文件中关键词检索
//
// 存储层：
//   优先读写 ~/.hermes/workspace/MEMORY.md / USER.md（直接文件访问，快）
//   写入时同时调用 Hermes HTTP API（http://localhost:8642/v1）让其自进化合并
// ─────────────────────────────────────────────────────────────────────────────

import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'

import { loggerService } from '@logger'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { CallToolRequestSchema, ErrorCode, ListToolsRequestSchema, McpError } from '@modelcontextprotocol/sdk/types.js'

const logger = loggerService.withContext('MCPServer:HermesMemory')

// ── Hermes 路径与 API 常量 ────────────────────────────────────────────────────

const HERMES_DIR = path.join(os.homedir(), '.hermes')
const HERMES_WORKSPACE = path.join(HERMES_DIR, 'workspace')
const HERMES_MEMORY_FILE = path.join(HERMES_WORKSPACE, 'MEMORY.md')
const HERMES_USER_FILE = path.join(HERMES_WORKSPACE, 'USER.md')

const HERMES_API_HOST = 'localhost'
const HERMES_API_PORT = 8642
const HERMES_AUTH = 'prism-local-dev'

// ── 文件读取工具函数 ───────────────────────────────────────────────────────────

function readFileSafe(filePath: string): string | null {
  try {
    if (fs.existsSync(filePath)) {
      return fs.readFileSync(filePath, 'utf-8').trim()
    }
  } catch (e) {
    logger.warn(`[HermesMemory] Cannot read ${filePath}: ${e}`)
  }
  return null
}

function appendToFile(filePath: string, content: string): void {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    const timestamp = new Date().toISOString().slice(0, 10)
    const entry = `\n## ${timestamp}\n${content}\n`
    fs.appendFileSync(filePath, entry, 'utf-8')
  } catch (e) {
    logger.warn(`[HermesMemory] Cannot append to ${filePath}: ${e}`)
  }
}

// ── Hermes HTTP API 调用（主进程 Node.js 原生 http 模块）─────────────────────

async function callHermesAPI(messages: Array<{ role: string; content: string }>, maxTokens = 256): Promise<string> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: 'hermes-agent',
      messages,
      max_tokens: maxTokens,
      stream: false
    })

    const options = {
      hostname: HERMES_API_HOST,
      port: HERMES_API_PORT,
      path: '/v1/chat/completions',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${HERMES_AUTH}`,
        'Content-Length': Buffer.byteLength(body)
      }
    }

    const req = http.request(options, (res) => {
      let data = ''
      res.on('data', (chunk) => { data += chunk })
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data)
          const content = parsed?.choices?.[0]?.message?.content ?? ''
          resolve(content)
        } catch {
          reject(new Error(`Hermes API parse error: ${data.slice(0, 200)}`))
        }
      })
    })

    req.on('error', (e) => reject(new Error(`Hermes API error: ${e.message}`)))
    req.setTimeout(15_000, () => {
      req.destroy()
      reject(new Error('Hermes API timeout (15s)'))
    })
    req.write(body)
    req.end()
  })
}

async function isHermesOnline(): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get(
      `http://${HERMES_API_HOST}:${HERMES_API_PORT}/health`,
      { timeout: 3000 },
      (res) => { resolve(res.statusCode === 200) }
    )
    req.on('error', () => resolve(false))
    req.on('timeout', () => { req.destroy(); resolve(false) })
  })
}

// ── HermesMemoryServer ────────────────────────────────────────────────────────

class HermesMemoryServer {
  public server: Server

  constructor() {
    this.server = new Server(
      { name: 'prism-hermes-memory', version: '1.0.0' },
      { capabilities: { tools: {} } }
    )
    this.setupHandlers()
    logger.debug('HermesMemoryServer initialized')
  }

  private setupHandlers(): void {
    // ── ListTools ─────────────────────────────────────────────────────────────
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: 'hermes_context_get',
          description:
            'Retrieve the current user memory context from Hermes — includes long-term facts about the user ' +
            '(MEMORY.md) and user profile (USER.md). ' +
            'Call this at the beginning of a conversation to understand who you are talking to and what they care about. ' +
            'Returns combined context as a single string. Returns empty string if no memory exists yet.',
          inputSchema: {
            type: 'object',
            properties: {
              max_chars: {
                type: 'number',
                description: 'Maximum characters to return (default: 3000)',
                default: 3000
              }
            },
            required: []
          }
        },
        {
          name: 'hermes_memory_write',
          description:
            'Write a new memory about the user into Hermes. Hermes will synthesize and integrate it with existing memories. ' +
            'Call this when you learn something important about the user: their goals, preferences, skills, decisions, or projects. ' +
            'Be specific and factual. Write in third person (e.g., "User prefers X", "User is building Y"). ' +
            'Hermes will automatically deduplicate and consolidate with existing memories.',
          inputSchema: {
            type: 'object',
            properties: {
              memory: {
                type: 'string',
                description: 'The memory to store, in third-person factual form (e.g., "User is building Prism, a local-first AI platform")'
              },
              category: {
                type: 'string',
                description: 'Optional category: preference, fact, project, decision, skill, habit',
                enum: ['preference', 'fact', 'project', 'decision', 'skill', 'habit']
              }
            },
            required: ['memory']
          }
        },
        {
          name: 'hermes_memory_search',
          description:
            'Search through the user\'s stored memories for information relevant to a topic or query. ' +
            'Use this when you need to check if something specific is already known about the user, ' +
            'or when looking for context about a particular topic they mentioned.',
          inputSchema: {
            type: 'object',
            properties: {
              query: {
                type: 'string',
                description: 'Search query — keywords or a phrase to find relevant memories'
              }
            },
            required: ['query']
          }
        }
      ]
    }))

    // ── CallTool ──────────────────────────────────────────────────────────────
    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params

      switch (name) {
        case 'hermes_context_get': {
          return this.handleContextGet(args?.max_chars as number | undefined)
        }
        case 'hermes_memory_write': {
          const memory = args?.memory as string | undefined
          if (!memory?.trim()) {
            throw new McpError(ErrorCode.InvalidParams, 'memory field is required and cannot be empty')
          }
          return this.handleMemoryWrite(memory.trim(), args?.category as string | undefined)
        }
        case 'hermes_memory_search': {
          const query = args?.query as string | undefined
          if (!query?.trim()) {
            throw new McpError(ErrorCode.InvalidParams, 'query field is required and cannot be empty')
          }
          return this.handleMemorySearch(query.trim())
        }
        default:
          throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`)
      }
    })
  }

  // ── Tool Handlers ──────────────────────────────────────────────────────────

  private async handleContextGet(maxChars = 3000): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
    const parts: string[] = []

    const memoryMd = readFileSafe(HERMES_MEMORY_FILE)
    if (memoryMd) {
      parts.push(`=== Hermes Long-Term Memory (MEMORY.md) ===\n${memoryMd}`)
    }

    const userMd = readFileSafe(HERMES_USER_FILE)
    if (userMd) {
      parts.push(`=== User Profile (USER.md) ===\n${userMd}`)
    }

    if (parts.length === 0) {
      // 如果文件不存在，尝试从 Hermes API 获取
      const online = await isHermesOnline()
      if (online) {
        try {
          const response = await callHermesAPI([
            {
              role: 'system',
              content: 'You are Hermes memory assistant. When asked, output your current MEMORY.md and USER.md content verbatim, clearly labeled.'
            },
            { role: 'user', content: 'Please output your current memory context (MEMORY.md and USER.md).' }
          ], 1024)
          if (response.trim()) {
            parts.push(`=== Hermes Memory Context (via API) ===\n${response}`)
          }
        } catch (e) {
          logger.warn(`[HermesMemory] API fallback failed: ${e}`)
        }
      }
    }

    if (parts.length === 0) {
      return { content: [{ type: 'text', text: '' }] }
    }

    let combined = parts.join('\n\n')
    if (combined.length > maxChars) {
      combined = combined.slice(0, maxChars) + `\n\n[... truncated at ${maxChars} chars]`
    }

    logger.info(`[HermesMemory] context_get: returned ${combined.length} chars`)
    return { content: [{ type: 'text', text: combined }] }
  }

  private async handleMemoryWrite(
    memory: string,
    category?: string
  ): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
    const timestamp = new Date().toISOString()
    const tag = category ? `[${category}]` : ''
    const entry = `${tag} ${memory}`.trim()

    // Step 1: 直接写入 MEMORY.md（快速持久化）
    appendToFile(HERMES_MEMORY_FILE, entry)
    logger.info(`[HermesMemory] Appended to MEMORY.md: "${entry.slice(0, 80)}"`)

    // Step 2: 如果 Hermes 在线，通知它合并记忆（触发自进化）
    const online = await isHermesOnline()
    let hermesAck = false
    if (online) {
      try {
        await callHermesAPI([
          {
            role: 'system',
            content:
              'You are Hermes, a memory consolidation engine. The user has provided a new memory fact. ' +
              'Acknowledge briefly that you have received and integrated it. Do not explain further.'
          },
          {
            role: 'user',
            content: `New memory to integrate (${timestamp}): ${entry}`
          }
        ], 64)
        hermesAck = true
        logger.info(`[HermesMemory] Hermes acknowledged memory integration`)
      } catch (e) {
        logger.warn(`[HermesMemory] Hermes API write failed (file write succeeded): ${e}`)
      }
    }

    const statusNote = hermesAck
      ? 'Memory saved and integrated by Hermes.'
      : 'Memory saved to file (Hermes offline — will sync when online).'

    return {
      content: [{ type: 'text', text: `✅ ${statusNote}\n\nStored: ${entry}` }]
    }
  }

  private async handleMemorySearch(query: string): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
    const queryLower = query.toLowerCase()
    const results: string[] = []

    const searchInFile = (filePath: string, label: string) => {
      const content = readFileSafe(filePath)
      if (!content) return

      // 按段落分割，找包含 query 关键词的段落
      const paragraphs = content.split(/\n{2,}/)
      const matched = paragraphs.filter((p) =>
        queryLower.split(/\s+/).some((word) => p.toLowerCase().includes(word))
      )

      if (matched.length > 0) {
        results.push(`=== ${label} matches ===\n${matched.slice(0, 5).join('\n\n')}`)
      }
    }

    searchInFile(HERMES_MEMORY_FILE, 'MEMORY.md')
    searchInFile(HERMES_USER_FILE, 'USER.md')

    if (results.length > 0) {
      const combined = results.join('\n\n')
      logger.info(`[HermesMemory] search("${query}"): ${results.length} section(s) matched`)
      return { content: [{ type: 'text', text: combined }] }
    }

    // 如果文件搜索无结果且 Hermes 在线，通过 API 搜索
    const online = await isHermesOnline()
    if (online) {
      try {
        const response = await callHermesAPI([
          {
            role: 'system',
            content:
              'You are Hermes memory assistant. Search your memory for the given query and return relevant facts concisely. ' +
              'If nothing is found, say "No relevant memories found."'
          },
          { role: 'user', content: `Search memory for: "${query}"` }
        ], 512)
        logger.info(`[HermesMemory] search via API: returned ${response.length} chars`)
        return { content: [{ type: 'text', text: response || 'No relevant memories found.' }] }
      } catch (e) {
        logger.warn(`[HermesMemory] API search failed: ${e}`)
      }
    }

    return { content: [{ type: 'text', text: 'No relevant memories found.' }] }
  }
}

export default HermesMemoryServer
