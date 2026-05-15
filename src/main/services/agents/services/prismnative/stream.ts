// [PRISM2] 2026-05-15 — PrismNativeStream: AgentStream 实现，供 prism-native agentType 使用
import { EventEmitter } from 'node:events'

import type { AgentStream, AgentStreamEvent } from '../../interfaces/AgentStreamInterface'

/**
 * prism-native agentType 的流对象，实现 AgentStream 接口。
 * 通过 emit('data', event) 向 SessionMessageService 传递流式事件。
 */
export class PrismNativeStream extends EventEmitter implements AgentStream {
  declare emit: (event: 'data', data: AgentStreamEvent) => boolean
  declare on: (event: 'data', listener: (data: AgentStreamEvent) => void) => this
  declare once: (event: 'data', listener: (data: AgentStreamEvent) => void) => this

  sdkSessionId?: string
}
