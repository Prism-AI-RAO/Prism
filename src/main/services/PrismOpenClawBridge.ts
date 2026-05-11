// [PRISM] 2026-05-11 — Sprint 2-B: OpenClaw WebSocket Bridge
// Establishes a persistent bidirectional WebSocket connection to the local OpenClaw
// gateway and exposes sessions / memory operations via IPC to the renderer.
//
// Architecture:
//   Renderer ─IPC─▶ PrismOpenClawBridge ─WS─▶ OpenClaw Gateway
//                                        ◀─WS─
//
// Protocol note:
//   OpenClaw uses a JSON message protocol over WebSocket at /ws.
//   Authentication: ?token=<gatewayAuthToken> query parameter.
//   Messages follow { type, id?, data? } envelope (see OpenClawMessageType).
//   ⚠️  Some protocol details are inferred from OpenClaw's SPA/API surface.
//   Validate against a running instance via the debug log when USE_PROTOCOL_SNIFF=true.

import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { loggerService } from '@logger'
import { IpcChannel } from '@shared/IpcChannel'
import { ipcMain } from 'electron'
import { WebSocket } from 'ws'

import { windowService } from './WindowService'

const logger = loggerService.withContext('PrismOpenClawBridge')

// ── Constants ─────────────────────────────────────────────────────────────────

const RECONNECT_DELAYS_MS = [1000, 3000, 10000, 30000]
const REQUEST_TIMEOUT_MS = 30_000
const OPENCLAW_CONFIG_PATH = path.join(os.homedir(), '.openclaw', 'openclaw.json')

// ── Types ─────────────────────────────────────────────────────────────────────

export type BridgeStatus = 'disconnected' | 'connecting' | 'connected' | 'error'

interface OpenClawConfig {
  gateway?: {
    port?: number
    auth?: { token?: string }
  }
}

/** Envelope for all WebSocket messages (both outbound and inbound). */
interface WsEnvelope {
  type: string
  id?: string
  data?: unknown
  error?: { code: string; message: string }
}

/** A pending request waiting for its response. */
interface PendingRequest {
  resolve: (data: unknown) => void
  reject: (err: Error) => void
  timer: NodeJS.Timeout
}

// ── OpenClaw message types ───────────────────────────────────────────────────
// These are the request/response types Prism sends to / receives from OpenClaw.
// Based on OpenClaw's agent-platform API surface (SOUL.md / sessions / memory).
// ⚠️  Validate against actual running instance if behaviour is unexpected.

const MSG = {
  // Session lifecycle
  SESSIONS_SPAWN: 'sessions.spawn',
  SESSIONS_SPAWNED: 'sessions.spawned',
  SESSIONS_YIELD: 'sessions.yield',
  SESSIONS_YIELD_DELTA: 'sessions.yield.delta',
  SESSIONS_YIELD_DONE: 'sessions.yield.done',
  SESSIONS_HISTORY: 'sessions.history',
  SESSIONS_HISTORY_RESULT: 'sessions.history.result',
  // Memory
  MEMORY_SEARCH: 'memory.search',
  MEMORY_SEARCH_RESULT: 'memory.search.result',
  MEMORY_WRITE: 'memory.write',
  MEMORY_WRITE_RESULT: 'memory.write.result',
  MEMORY_READ: 'memory.read',
  MEMORY_READ_RESULT: 'memory.read.result',
  // System
  PING: 'ping',
  PONG: 'pong',
  ERROR: 'error'
} as const

// ── Session yield streaming ───────────────────────────────────────────────────

interface YieldStreamListener {
  onDelta: (text: string, sessionId: string) => void
  onDone: (sessionId: string) => void
  onError: (err: Error, sessionId: string) => void
}

// ── Main service class ────────────────────────────────────────────────────────

class PrismOpenClawBridge {
  private ws: WebSocket | null = null
  private status: BridgeStatus = 'disconnected'
  private reconnectTimer: NodeJS.Timeout | null = null
  private reconnectAttempt = 0
  private pendingRequests = new Map<string, PendingRequest>()
  private yieldListeners = new Map<string, YieldStreamListener>()
  private pingTimer: NodeJS.Timeout | null = null

  // ── Connection management ─────────────────────────────────────────────────

  /**
   * Read gateway port + auth token from the OpenClaw config file.
   * Returns null if config doesn't exist or is malformed.
   */
  private readGatewayConfig(): { port: number; token: string } | null {
    try {
      if (!fs.existsSync(OPENCLAW_CONFIG_PATH)) return null
      const raw = fs.readFileSync(OPENCLAW_CONFIG_PATH, 'utf-8')
      const cfg = JSON.parse(raw) as OpenClawConfig
      const port = cfg.gateway?.port ?? 18789
      const token = cfg.gateway?.auth?.token ?? ''
      return { port, token }
    } catch {
      return null
    }
  }

  /**
   * Probe whether a gateway is reachable on the given port via HTTP health check.
   */
  private async probeGateway(port: number): Promise<boolean> {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`, {
        signal: AbortSignal.timeout(2000)
      })
      if (res.ok) {
        const data = (await res.json()) as { ok?: boolean; status?: string }
        return data.ok === true && data.status === 'live'
      }
    } catch {
      // not reachable
    }
    return false
  }

  /**
   * Connect to the OpenClaw WebSocket gateway.
   * Auto-discovers config from ~/.openclaw/openclaw.json.
   */
  public async connect(): Promise<{ success: boolean; message?: string }> {
    if (this.status === 'connected' || this.status === 'connecting') {
      return { success: true, message: 'Already connected or connecting' }
    }

    // Read config
    const cfg = this.readGatewayConfig()
    if (!cfg) {
      const msg = 'OpenClaw config not found at ~/.openclaw/openclaw.json'
      logger.info(`[PRISM] PrismOpenClawBridge: ${msg}`)
      return { success: false, message: msg }
    }

    // Probe health before attempting WebSocket (fast fail)
    const reachable = await this.probeGateway(cfg.port)
    if (!reachable) {
      // Try fallback ports common to RAO's setup
      const fallback = cfg.port === 18789 ? 18790 : 18789
      const fallbackOk = await this.probeGateway(fallback)
      if (fallbackOk) {
        cfg.port = fallback
      } else {
        const msg = `OpenClaw gateway not reachable on port ${cfg.port} or ${fallback}`
        logger.info(`[PRISM] PrismOpenClawBridge: ${msg}`)
        return { success: false, message: msg }
      }
    }

    const url = `ws://127.0.0.1:${cfg.port}/ws${cfg.token ? `?token=${encodeURIComponent(cfg.token)}` : ''}`
    this.doConnect(url, cfg.port)
    return { success: true }
  }

  /**
   * Internal: open the WebSocket and wire up event handlers.
   */
  private doConnect(url: string, port: number): void {
    this.setStatus('connecting')
    logger.info(`[PRISM] PrismOpenClawBridge: connecting to ws://127.0.0.1:${port}/ws`)

    const ws = new WebSocket(url)
    this.ws = ws

    ws.on('open', () => {
      logger.info('[PRISM] PrismOpenClawBridge: connected')
      this.reconnectAttempt = 0
      this.setStatus('connected')
      this.startPing()
    })

    ws.on('message', (data) => {
      try {
        const envelope = JSON.parse(data.toString()) as WsEnvelope
        this.handleMessage(envelope)
      } catch (err) {
        logger.warn('[PRISM] PrismOpenClawBridge: failed to parse message', err as Error)
      }
    })

    ws.on('close', (code, reason) => {
      const msg = reason?.toString() || '(no reason)'
      logger.info(`[PRISM] PrismOpenClawBridge: closed (code=${code}, reason=${msg})`)
      this.cleanup()
      if (this.status !== 'disconnected') {
        this.scheduleReconnect(url, port)
      }
    })

    ws.on('error', (err) => {
      logger.warn('[PRISM] PrismOpenClawBridge: WebSocket error', err as Error)
      this.setStatus('error')
    })
  }

  /**
   * Gracefully disconnect and cancel any pending reconnect.
   */
  public disconnect(): void {
    this.cancelReconnect()
    this.setStatus('disconnected')
    if (this.ws) {
      this.ws.close(1000, 'Prism disconnect')
      this.ws = null
    }
    this.stopPing()
    this.rejectAllPending(new Error('Bridge disconnected'))
  }

  private cleanup(): void {
    this.ws = null
    this.stopPing()
    this.rejectAllPending(new Error('WebSocket closed'))
  }

  // ── Reconnect ─────────────────────────────────────────────────────────────

  private scheduleReconnect(url: string, port: number): void {
    const delay = RECONNECT_DELAYS_MS[Math.min(this.reconnectAttempt, RECONNECT_DELAYS_MS.length - 1)]
    this.reconnectAttempt++
    logger.info(`[PRISM] PrismOpenClawBridge: reconnecting in ${delay}ms (attempt ${this.reconnectAttempt})`)
    this.setStatus('connecting')
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.doConnect(url, port)
    }, delay)
  }

  private cancelReconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
  }

  // ── Keepalive ping ────────────────────────────────────────────────────────

  private startPing(): void {
    this.stopPing()
    this.pingTimer = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.ping()
      }
    }, 30_000)
  }

  private stopPing(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer)
      this.pingTimer = null
    }
  }

  // ── Message routing ───────────────────────────────────────────────────────

  private handleMessage(envelope: WsEnvelope): void {
    const { type, id, data, error } = envelope
    logger.debug(`[PRISM] PrismOpenClawBridge ← ${type}`, { id })

    // Correlate request/response pairs
    if (id && this.pendingRequests.has(id)) {
      const pending = this.pendingRequests.get(id)!
      clearTimeout(pending.timer)
      this.pendingRequests.delete(id)

      if (error) {
        pending.reject(new Error(`[${error.code}] ${error.message}`))
      } else {
        pending.resolve(data)
      }
      return
    }

    // Handle streaming session yield deltas
    if (type === MSG.SESSIONS_YIELD_DELTA) {
      const d = data as { session_id?: string; delta?: string }
      const sid = d?.session_id
      if (sid && this.yieldListeners.has(sid)) {
        this.yieldListeners.get(sid)!.onDelta(d.delta ?? '', sid)
      }
      return
    }

    if (type === MSG.SESSIONS_YIELD_DONE) {
      const d = data as { session_id?: string }
      const sid = d?.session_id
      if (sid && this.yieldListeners.has(sid)) {
        this.yieldListeners.get(sid)!.onDone(sid)
        this.yieldListeners.delete(sid)
      }
      return
    }

    // Server-side error without a request id
    if (type === MSG.ERROR) {
      logger.warn('[PRISM] PrismOpenClawBridge: server error', { data })
    }
  }

  // ── Request/response ──────────────────────────────────────────────────────

  /**
   * Send a typed request to OpenClaw and await the correlated response.
   */
  private sendRequest<T = unknown>(type: string, data?: unknown): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        reject(new Error('Bridge not connected'))
        return
      }

      const id = crypto.randomUUID()
      const envelope: WsEnvelope = { type, id, data }

      const timer = setTimeout(() => {
        this.pendingRequests.delete(id)
        reject(new Error(`Request timeout: ${type} (${REQUEST_TIMEOUT_MS}ms)`))
      }, REQUEST_TIMEOUT_MS)

      this.pendingRequests.set(id, {
        resolve: resolve as (v: unknown) => void,
        reject,
        timer
      })

      logger.debug(`[PRISM] PrismOpenClawBridge → ${type}`, { id })
      this.ws.send(JSON.stringify(envelope))
    })
  }

  private rejectAllPending(err: Error): void {
    for (const [, pending] of this.pendingRequests) {
      clearTimeout(pending.timer)
      pending.reject(err)
    }
    this.pendingRequests.clear()
  }

  // ── Status management ─────────────────────────────────────────────────────

  private setStatus(status: BridgeStatus): void {
    if (this.status === status) return
    this.status = status
    const win = windowService.getMainWindow()
    if (win && !win.isDestroyed()) {
      win.webContents.send(IpcChannel.OpenClaw_Bridge_StatusChanged, { status })
    }
  }

  public getStatus(): BridgeStatus {
    return this.status
  }

  // ── Public API: sessions ──────────────────────────────────────────────────

  /**
   * Spawn a new session with the specified OpenClaw agent.
   * Returns { session_id: string }
   */
  public async sessionsSpawn(agentId: string, prompt?: string): Promise<{ session_id: string }> {
    return this.sendRequest<{ session_id: string }>(MSG.SESSIONS_SPAWN, { agent_id: agentId, prompt })
  }

  /**
   * Yield (send a message) to an existing session.
   * Streaming deltas are pushed to the renderer via IpcChannel.OpenClaw_Bridge_SessionsYield.
   */
  public async sessionsYield(
    sessionId: string,
    message: string,
    onDelta: (text: string) => void,
    onDone: () => void,
    onError: (err: Error) => void
  ): Promise<void> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('Bridge not connected')
    }

    // Register streaming listener before sending the request
    this.yieldListeners.set(sessionId, {
      onDelta: (text) => onDelta(text),
      onDone: () => onDone(),
      onError: (err) => onError(err)
    })

    const id = crypto.randomUUID()
    const envelope: WsEnvelope = {
      type: MSG.SESSIONS_YIELD,
      id,
      data: { session_id: sessionId, message }
    }
    this.ws.send(JSON.stringify(envelope))
  }

  /**
   * Fetch message history for a session.
   */
  public async sessionsHistory(
    sessionId: string
  ): Promise<{ messages: Array<{ role: string; content: string; ts: string }> }> {
    return this.sendRequest(MSG.SESSIONS_HISTORY, { session_id: sessionId })
  }

  // ── Public API: memory ────────────────────────────────────────────────────

  /**
   * Semantic search over OpenClaw's memory store.
   */
  public async memorySearch(
    query: string,
    limit = 10
  ): Promise<{ results: Array<{ id: string; content: string; score: number }> }> {
    return this.sendRequest(MSG.MEMORY_SEARCH, { query, limit })
  }

  /**
   * Write a new memory fragment to OpenClaw's memory store.
   */
  public async memoryWrite(content: string, tags?: string[]): Promise<{ id: string }> {
    return this.sendRequest(MSG.MEMORY_WRITE, { content, tags: tags ?? [] })
  }

  /**
   * Read a specific memory by id.
   */
  public async memoryRead(id: string): Promise<{ id: string; content: string; tags: string[]; ts: string }> {
    return this.sendRequest(MSG.MEMORY_READ, { id })
  }

  // ── IPC registration ──────────────────────────────────────────────────────

  /**
   * Register all IPC handlers for the renderer to call.
   * Called once from ipc.ts during app bootstrap.
   */
  public registerIpcHandlers(): void {
    ipcMain.handle(IpcChannel.OpenClaw_Bridge_Connect, async () => {
      return this.connect()
    })

    ipcMain.handle(IpcChannel.OpenClaw_Bridge_Disconnect, async () => {
      this.disconnect()
      return { success: true }
    })

    ipcMain.handle(IpcChannel.OpenClaw_Bridge_GetStatus, async () => {
      return { status: this.status }
    })

    ipcMain.handle(
      IpcChannel.OpenClaw_Bridge_SessionsSpawn,
      async (_event, { agentId, prompt }: { agentId: string; prompt?: string }) => {
        return this.sessionsSpawn(agentId, prompt)
      }
    )

    ipcMain.handle(
      IpcChannel.OpenClaw_Bridge_SessionsHistory,
      async (_event, { sessionId }: { sessionId: string }) => {
        return this.sessionsHistory(sessionId)
      }
    )

    ipcMain.handle(
      IpcChannel.OpenClaw_Bridge_MemorySearch,
      async (_event, { query, limit }: { query: string; limit?: number }) => {
        return this.memorySearch(query, limit)
      }
    )

    ipcMain.handle(
      IpcChannel.OpenClaw_Bridge_MemoryWrite,
      async (_event, { content, tags }: { content: string; tags?: string[] }) => {
        return this.memoryWrite(content, tags)
      }
    )

    ipcMain.handle(IpcChannel.OpenClaw_Bridge_MemoryRead, async (_event, { id }: { id: string }) => {
      return this.memoryRead(id)
    })

    // Sessions.yield is handled via streaming: renderer subscribes to
    // OpenClaw_Bridge_StatusChanged and receives chunks via webContents.send.
    // Direct IPC invoke triggers the yield and returns when the stream is done.
    ipcMain.handle(
      IpcChannel.OpenClaw_Bridge_SessionsYield,
      (_event, { sessionId, message }: { sessionId: string; message: string }) => {
        return new Promise<{ done: boolean }>((resolve, reject) => {
          const chunks: string[] = []
          this.sessionsYield(
            sessionId,
            message,
            (text) => {
              chunks.push(text)
              const win = windowService.getMainWindow()
              if (win && !win.isDestroyed()) {
                win.webContents.send(IpcChannel.OpenClaw_Bridge_SessionsYield, {
                  sessionId,
                  delta: text,
                  done: false
                })
              }
            },
            () => {
              const win = windowService.getMainWindow()
              if (win && !win.isDestroyed()) {
                win.webContents.send(IpcChannel.OpenClaw_Bridge_SessionsYield, {
                  sessionId,
                  delta: '',
                  done: true
                })
              }
              resolve({ done: true })
            },
            (err) => reject(err)
          ).catch(reject)
        })
      }
    )

    logger.info('[PRISM] PrismOpenClawBridge: IPC handlers registered')
  }

  /**
   * Auto-connect if OpenClaw is already running (called during app startup).
   * Never throws — failure is logged and silently ignored.
   */
  public async tryAutoConnect(): Promise<void> {
    try {
      const result = await this.connect()
      if (result.success) {
        logger.info('[PRISM] PrismOpenClawBridge: auto-connect succeeded')
      } else {
        logger.info(`[PRISM] PrismOpenClawBridge: auto-connect skipped — ${result.message}`)
      }
    } catch (err) {
      logger.warn('[PRISM] PrismOpenClawBridge: auto-connect failed', err as Error)
    }
  }
}

export const prismOpenClawBridge = new PrismOpenClawBridge()
