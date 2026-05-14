import { loggerService } from '@logger'
import type { Server } from '@modelcontextprotocol/sdk/server/index.js'
import type { BuiltinMCPServerName } from '@types'
import { BuiltinMCPServerNames } from '@types'

import BraveSearchServer from './brave-search'
import BrowserServer from './browser'
import DiDiMcpServer from './didi-mcp'
import DifyKnowledgeServer from './dify-knowledge'
import FetchServer from './fetch'
import FileSystemServer from './filesystem'
import { resolveFilesystemBaseDir } from './filesystem/config'
import HubServer from './hub'
import MemoryServer from './memory'
// [PRISM] 2026-05-14 — Sprint 14-C: PrismMemoryServer 已停用（与 MemoryServer 同名 @prism/memory，dead code）
// prismMemory.ts 保留备用；factory 仅用 MemoryServer 处理 @prism/memory
import HermesMemoryServer from './hermesMemory' // [PRISM] 2026-05-14 — Sprint 10-A: Hermes 记忆引擎全局 MCP
import PythonServer from './python'
import ThinkingServer from './sequentialthinking'

const logger = loggerService.withContext('MCPFactory')

export function createInMemoryMCPServer(
  name: BuiltinMCPServerName,
  args: string[] = [],
  envs: Record<string, string> = {}
): Server {
  logger.debug(`[MCP] Creating in-memory MCP server: ${name} with args: ${args} and envs: ${JSON.stringify(envs)}`)
  switch (name) {
    case BuiltinMCPServerNames.memory: {
      const envPath = envs.MEMORY_FILE_PATH
      return new MemoryServer(envPath).server
    }
    case BuiltinMCPServerNames.sequentialThinking: {
      return new ThinkingServer().server
    }
    case BuiltinMCPServerNames.braveSearch: {
      return new BraveSearchServer(envs.BRAVE_API_KEY).server
    }
    case BuiltinMCPServerNames.fetch: {
      return new FetchServer().server
    }
    case BuiltinMCPServerNames.filesystem: {
      return new FileSystemServer(resolveFilesystemBaseDir(args, envs)).server
    }
    case BuiltinMCPServerNames.difyKnowledge: {
      const difyKey = envs.DIFY_KEY
      return new DifyKnowledgeServer(difyKey, args).server
    }
    case BuiltinMCPServerNames.python: {
      return new PythonServer().server
    }
    case BuiltinMCPServerNames.didiMCP: {
      const apiKey = envs.DIDI_API_KEY
      return new DiDiMcpServer(apiKey).server
    }
    case BuiltinMCPServerNames.browser: {
      return new BrowserServer().server
    }
    case BuiltinMCPServerNames.hub: {
      return new HubServer().server
    }
    // [PRISM] 2026-05-14 — Sprint 14-C: prismMemory case 已移除
    // BuiltinMCPServerNames.prismMemory === '@prism/memory' === BuiltinMCPServerNames.memory
    // 两个 case 同值，prismMemory case 永远是 dead code，已合并到上方 memory case
    case BuiltinMCPServerNames.hermesMemory: { // [PRISM] 2026-05-14 — Sprint 10-A: Hermes 记忆引擎全局 MCP
      return new HermesMemoryServer().server
    }
    default:
      throw new Error(`Unknown in-memory MCP server: ${name}`)
  }
}
