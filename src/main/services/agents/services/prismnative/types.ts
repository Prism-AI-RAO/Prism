// [PRISM2] 2026-05-15 — prism-native 内部类型定义

/** 解析后的 provider:model 格式 */
export interface ParsedModel {
  providerId: string
  modelId: string
}

/** 流式 SSE 中收集的 tool_call 条目 */
export interface ToolCallAccumulator {
  index: number
  id: string
  name: string
  arguments: string
}

/** prism-native 执行选项 */
export interface PrismNativeOptions {
  /** 最大 agentic loop 轮次，默认 20 */
  maxIterations?: number
  /** Hermes 记忆注入超时 ms，默认 5000 */
  hermesTimeoutMs?: number
}
