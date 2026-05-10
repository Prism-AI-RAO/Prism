// [PRISM] 2026-05-10 — Sprint 2: Hermes 记忆层集成 — Prism Memory MCP Server
// Wraps MemoryService (SQLite + vector search) and exposes Hermes-style memory tools
// to any AI assistant running inside Prism. Design inspired by NousResearch/hermes-agent.

import { loggerService } from '@logger'
import MemoryService from '@main/services/memory/MemoryService'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { CallToolRequestSchema, ErrorCode, ListToolsRequestSchema, McpError } from '@modelcontextprotocol/sdk/types.js'

const logger = loggerService.withContext('MCPServer:PrismMemory')

// Default user scope for Prism (single-user app; could be extended to multi-user later)
const PRISM_DEFAULT_USER = 'prism-default-user'

/**
 * PrismMemoryServer — built-in MCP server that gives AI assistants in Prism
 * the ability to store and retrieve memories about the user across sessions.
 *
 * Exposed tools (Hermes-inspired):
 *   prism_memory_add     — store a new memory fragment
 *   prism_memory_search  — semantic / text search over memories
 *   prism_memory_list    — list all memories (paginated)
 *   prism_memory_delete  — soft-delete a specific memory by id
 *   prism_memory_clear   — delete all memories for the current user
 *
 * Storage: delegates to MemoryService (libsql SQLite, optional vector embeddings)
 * Path: {userData}/Data/Memory/memories.db
 */
class PrismMemoryServer {
  public server: Server
  private memoryService: MemoryService

  constructor() {
    this.memoryService = MemoryService.getInstance()

    this.server = new Server(
      { name: 'prism-memory-server', version: '1.0.0' },
      { capabilities: { tools: {} } }
    )

    this.setupHandlers()
    logger.debug('PrismMemoryServer initialized')
  }

  private setupHandlers(): void {
    // ── ListTools ────────────────────────────────────────────────────────────
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: 'prism_memory_add',
          description:
            'Store a new memory about the user — preferences, facts, decisions, or anything that should persist across sessions. ' +
            'Call this whenever you learn something important about the user that will be useful in future conversations.',
          inputSchema: {
            type: 'object',
            properties: {
              memory: {
                type: 'string',
                description: 'The memory text to store (e.g. "User prefers dark mode", "User is building a startup called Prism")'
              },
              category: {
                type: 'string',
                description: 'Optional category tag (e.g. "preference", "fact", "project", "decision")',
                enum: ['preference', 'fact', 'project', 'decision', 'habit', 'context']
              }
            },
            required: ['memory']
          }
        },
        {
          name: 'prism_memory_search',
          description:
            'Search stored memories about the user using semantic or keyword matching. ' +
            'Call this at the start of each conversation to retrieve relevant context about the user.',
          inputSchema: {
            type: 'object',
            properties: {
              query: {
                type: 'string',
                description: 'The search query to match against stored memories'
              },
              limit: {
                type: 'number',
                description: 'Maximum number of memories to return (default: 10, max: 50)',
                default: 10
              }
            },
            required: ['query']
          }
        },
        {
          name: 'prism_memory_list',
          description: 'List all stored memories about the user, ordered by most recent first.',
          inputSchema: {
            type: 'object',
            properties: {
              limit: {
                type: 'number',
                description: 'Maximum number of memories to return (default: 20)',
                default: 20
              },
              offset: {
                type: 'number',
                description: 'Offset for pagination (default: 0)',
                default: 0
              }
            }
          }
        },
        {
          name: 'prism_memory_delete',
          description: 'Delete a specific memory by its ID. Use prism_memory_list to find the ID first.',
          inputSchema: {
            type: 'object',
            properties: {
              id: {
                type: 'string',
                description: 'The UUID of the memory to delete'
              }
            },
            required: ['id']
          }
        },
        {
          name: 'prism_memory_clear',
          description:
            'Delete ALL stored memories for the current user. This is irreversible. ' +
            'Only use when the user explicitly requests a full memory reset.',
          inputSchema: {
            type: 'object',
            properties: {
              confirm: {
                type: 'boolean',
                description: 'Must be true to confirm the destructive action'
              }
            },
            required: ['confirm']
          }
        }
      ]
    }))

    // ── CallTool ─────────────────────────────────────────────────────────────
    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params

      if (!args) {
        throw new McpError(ErrorCode.InvalidParams, `No arguments provided for tool: ${name}`)
      }

      try {
        switch (name) {
          // ── prism_memory_add ────────────────────────────────────────────
          case 'prism_memory_add': {
            const memory = args.memory as string
            const category = (args.category as string) || 'fact'

            if (!memory || typeof memory !== 'string') {
              throw new McpError(ErrorCode.InvalidParams, "'memory' must be a non-empty string")
            }

            const result = await this.memoryService.add(memory.trim(), {
              userId: PRISM_DEFAULT_USER,
              metadata: { category, source: 'prism-ai' }
            })

            if (result.count === 0) {
              return {
                content: [{
                  type: 'text',
                  text: JSON.stringify({ status: 'skipped', reason: 'Memory already exists or is too similar to an existing memory' })
                }]
              }
            }

            logger.info(`Memory stored: "${memory.slice(0, 60)}..." (category: ${category})`)
            return {
              content: [{
                type: 'text',
                text: JSON.stringify({ status: 'stored', id: result.memories[0]?.id, memory: result.memories[0]?.memory })
              }]
            }
          }

          // ── prism_memory_search ─────────────────────────────────────────
          case 'prism_memory_search': {
            const query = args.query as string
            const limit = Math.min(Number(args.limit) || 10, 50)

            if (!query || typeof query !== 'string') {
              throw new McpError(ErrorCode.InvalidParams, "'query' must be a non-empty string")
            }

            const result = await this.memoryService.search(query, {
              userId: PRISM_DEFAULT_USER,
              limit
            })

            return {
              content: [{
                type: 'text',
                text: JSON.stringify({
                  count: result.count,
                  memories: result.memories.map((m) => ({
                    id: m.id,
                    memory: m.memory,
                    category: m.metadata?.category || 'fact',
                    score: m.score,
                    createdAt: m.createdAt
                  }))
                }, null, 2)
              }]
            }
          }

          // ── prism_memory_list ───────────────────────────────────────────
          case 'prism_memory_list': {
            const limit = Math.min(Number(args.limit) || 20, 100)
            const offset = Number(args.offset) || 0

            const result = await this.memoryService.list({
              userId: PRISM_DEFAULT_USER,
              limit,
              offset
            })

            return {
              content: [{
                type: 'text',
                text: JSON.stringify({
                  total: result.count,
                  returned: result.memories.length,
                  offset,
                  memories: result.memories.map((m) => ({
                    id: m.id,
                    memory: m.memory,
                    category: m.metadata?.category || 'fact',
                    createdAt: m.createdAt,
                    updatedAt: m.updatedAt
                  }))
                }, null, 2)
              }]
            }
          }

          // ── prism_memory_delete ─────────────────────────────────────────
          case 'prism_memory_delete': {
            const id = args.id as string

            if (!id || typeof id !== 'string') {
              throw new McpError(ErrorCode.InvalidParams, "'id' must be a non-empty string")
            }

            await this.memoryService.delete(id)
            logger.info(`Memory deleted: ${id}`)

            return {
              content: [{ type: 'text', text: JSON.stringify({ status: 'deleted', id }) }]
            }
          }

          // ── prism_memory_clear ──────────────────────────────────────────
          case 'prism_memory_clear': {
            const confirm = args.confirm as boolean

            if (confirm !== true) {
              throw new McpError(
                ErrorCode.InvalidParams,
                "You must pass confirm: true to clear all memories. This action is irreversible."
              )
            }

            await this.memoryService.deleteAllMemoriesForUser(PRISM_DEFAULT_USER)
            logger.info('All memories cleared for default user')

            return {
              content: [{ type: 'text', text: JSON.stringify({ status: 'cleared', message: 'All memories deleted' }) }]
            }
          }

          default:
            throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`)
        }
      } catch (error) {
        if (error instanceof McpError) throw error
        logger.error(`Error executing tool ${name}:`, error as Error)
        throw new McpError(
          ErrorCode.InternalError,
          `Error executing ${name}: ${error instanceof Error ? error.message : String(error)}`
        )
      }
    })
  }
}

export default PrismMemoryServer
