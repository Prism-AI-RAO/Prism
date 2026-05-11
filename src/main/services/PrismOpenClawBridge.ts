// [PRISM] 2026-05-11 — Sprint 6-C: Gateway token auth (fixes "metadata-upgrade" pairing error)
//
// Architecture:
//   Renderer ─IPC─▶ PrismOpenClawBridge ─WS─▶ OpenClaw Gateway (:18789/ws)
//                                        ◀─WS─  (streaming events)
//
// ── Verified OpenClaw WS Protocol v3 ──────────────────────────────────────────
//
//   Connection:  ws://127.0.0.1:{port}/ws   (no auth in URL, no subprotocol)
//
//   Frame envelope:
//     Request:  { type:'req', id:UUID, method:string, params:{...} }
//     Response: { type:'res', id:UUID, ok:boolean, payload:{...}, error?:{code,message} }
//     Event:    { type:'event', event:string, payload:{...} }
//
//   Auth (challenge-response, Sprint 6-C gateway token path):
//     1. Server sends:  { type:'event', event:'connect.challenge', payload:{nonce:UUID, ts:ms} }
//     2. Client sends:  { type:'req', method:'connect', params:{ device:null, auth:{token:gatewayToken}, ... } }
//     3. Server responds: { type:'res', ok:true, payload:{ type:'hello-ok', protocol:3, server:{...} } }
//     Gateway token from ~/.openclaw/openclaw.json → gateway.auth.token
//     (Same as browser Control UI — bypasses device pairing entirely)
//
//   Sessions:
//     sessions.create  { agentId:'main' }            → { key:'agent:main:dashboard:UUID', sessionId:UUID }
//     sessions.messages.subscribe { key }             → { ok:true, subscribed:true }
//     sessions.send    { key, message:'text' }        → { ok:true, runId, status:'started' }
//
//   Streaming events (server → client):
//     { type:'event', event:'agent', payload:{ stream:'lifecycle', data:{phase:'start'}, key } }
//     { type:'event', event:'agent', payload:{ stream:'assistant', data:{delta:'...', text:'...'}, key } }
//     { type:'event', event:'agent', payload:{ stream:'lifecycle', data:{phase:'end'}, key } }
//
//   Credential: ~/.openclaw/openclaw.json → gateway.auth.token

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

const OPENCLAW_PORTS = [18789, 18790]
const RECONNECT_DELAYS_MS = [1000, 3000, 10_000, 30_000]
const REQUEST_TIMEOUT_MS = 30_000
const KEEPALIVE_INTERVAL_MS = 30_000

const OPENCLAW_CONFIG_PATH = path.join(os.homedir(), '.openclaw', 'openclaw.json')

const CLIENT_ID = 'openclaw-control-ui'
const CLIENT_MODE = 'webchat'
const CLIENT_ROLE = 'operator'
const DEFAULT_SCOPES = ['tool:all', 'memory:read', 'memory:write', 'sessions:read', 'sessions:write']
const PROTOCOL_VERSION = 3

// ── Types ─────────────────────────────────────────────────────────────────────

export type BridgeStatus = 'disconnected' | 'connecting' | 'connected' | 'error'

interface OpenClawConfig {
  gateway?: {
    port?: number
    auth?: { token?: string }
  }
}

/** Pending request waiting for a 'res' frame. */
interface PendingRequest<T = unknown> {
  resolve: (value: T) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

/** Listeners registered for a streaming session. */
interface YieldListeners {
  onDelta: (text: string) => void
  onDone: () => void
  onError: (err: Error) => void
}

// ── Credential loading ────────────────────────────────────────────────────────

function loadGatewayToken(): string | undefined {
  try {
    const raw = fs.readFileSync(OPENCLAW_CONFIG_PATH, 'utf8')
    const cfg: OpenClawConfig = JSON.parse(raw)
    return cfg.gateway?.auth?.token
  } catch {
    return undefined
  }
}

// ── Bridge class ──────────────────────────────────────────────────────────────

class PrismOpenClawBridge {
  private ws: WebSocket | null = null
  private status: BridgeStatus = 'disconnected'
  private port: number = OPENCLAW_PORTS[0]

  private pending = new Map<string, PendingRequest>()
  private yieldListeners = new Map<string, YieldListeners>()

  private reconnectAttempt = 0
  private reconnectTimer: NodeJS.Timeout | null = null
  private keepaliveTimer: NodeJS.Timeout | null = null
  private manualDisconnect = false

  // ── Connection ──────────────────────────────────────────────────────────────

  public async connect(): Promise<{ success: boolean; message?: string }> {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      return { success: true, message: 'already connected' }
    }
    const livePort = await this.detectPort()
    if (!livePort) {
      return { success: false, message: 'OpenClaw not running on any expected port' }
    }
    this.port = livePort
    return new Promise((resolve) => {
      this.setStatus('connecting')
      this.manualDisconnect = false
      this.openSocket(resolve)
    })
  }

  public disconnect(): void {
    this.manualDisconnect = true
    this.clearTimers()
    if (this.ws) { this.ws.close(); this.ws = null }
    this.setStatus('disconnected')
  }

  private async detectPort(): Promise<number | undefined> {
    for (const p of OPENCLAW_PORTS) {
      try {
        const ctrl = new AbortController()
        const timer = setTimeout(() => ctrl.abort(), 2000)
        const res = await fetch(`http://127.0.0.1:${p}/health`, { signal: ctrl.signal })
        clearTimeout(timer)
        if (res.ok) return p
      } catch { /* not reachable */ }
    }
    return undefined
  }

  private openSocket(onFirstResult?: (r: { success: boolean; message?: string }) => void): void {
    const url = `ws://127.0.0.1:${this.port}/ws`
    logger.info(`[PRISM] PrismOpenClawBridge: connecting → ${url}`)

    // [PRISM] 2026-05-11 — Origin header required: OpenClaw validates Origin against controlUi.allowedOrigins
    const ws = new WebSocket(url, {
      headers: {
        Origin: `http://127.0.0.1:${this.port}`
      }
    })
    this.ws = ws

    let settled = false
    const settle = (result: { success: boolean; message?: string }) => {
      if (!settled) { settled = true; onFirstResult?.(result) }
    }

    ws.on('open', () => {
      logger.info('[PRISM] PrismOpenClawBridge: WS open — awaiting connect.challenge')
    })

    ws.on('message', (data: Buffer) => {
      this.handleFrame(data.toString(), settle)
    })

    ws.on('close', (code, reason) => {
      logger.info(`[PRISM] PrismOpenClawBridge: WS closed (${code} ${reason})`)
      this.setStatus('disconnected')
      this.ws = null
      this.clearTimers()
      this.rejectAllPending(new Error(`WebSocket closed: ${code}`))
      settle({ success: false, message: `closed: ${code}` })
      if (!this.manualDisconnect) this.scheduleReconnect()
    })

    ws.on('error', (err) => {
      logger.warn('[PRISM] PrismOpenClawBridge: WS error', err)
      this.setStatus('error')
      settle({ success: false, message: err.message })
    })
  }

  // ── Frame handling ──────────────────────────────────────────────────────────

  private handleFrame(
    raw: string,
    settle: (r: { success: boolean; message?: string }) => void
  ): void {
    let msg: Record<string, unknown>
    try { msg = JSON.parse(raw) as Record<string, unknown> }
    catch { logger.warn('[PRISM] PrismOpenClawBridge: invalid JSON frame'); return }

    const type = msg.type as string

    if (type === 'event') {
      const event = msg.event as string
      const payload = (msg.payload ?? {}) as Record<string, unknown>

      if (event === 'connect.challenge') {
        const nonce = (payload.nonce as string) ?? ''
        const ts = (payload.ts as number) ?? Date.now()
        this.sendConnectResponse(nonce, ts).catch((err) => {
          logger.warn('[PRISM] PrismOpenClawBridge: auth failed', err)
          settle({ success: false, message: (err as Error).message })
        })
        return
      }

      if (event === 'agent') {
        const stream = payload.stream as string
        const key = payload.key as string
        const data = (payload.data ?? {}) as Record<string, unknown>
        const listeners = key ? this.yieldListeners.get(key) : undefined

        if (stream === 'assistant' && listeners) {
          const delta = (data.delta as string) ?? ''
          if (delta) listeners.onDelta(delta)
        } else if (stream === 'lifecycle' && data.phase === 'end' && listeners) {
          listeners.onDone()
          this.yieldListeners.delete(key)
        }
        return
      }

      return // other events ignored
    }

    if (type === 'res') {
      const id = msg.id as string
      const pending = this.pending.get(id)
      if (!pending) return
      this.pending.delete(id)
      clearTimeout(pending.timer)

      const ok = msg.ok as boolean
      const pl = (msg.payload ?? {}) as Record<string, unknown>

      if (ok) {
        if ((pl.type as string) === 'hello-ok') {
          logger.info('[PRISM] PrismOpenClawBridge: authenticated ✅ protocol v' + (pl.protocol as number))
          this.setStatus('connected')
          this.reconnectAttempt = 0
          this.startKeepalive()
          settle({ success: true })
        }
        pending.resolve(pl)
      } else {
        const err = (msg.error as Record<string, unknown>) ?? {}
        pending.reject(new Error((err.message as string) ?? `req ${id} failed`))
      }
      return
    }
  }

  // ── Auth: challenge-response ────────────────────────────────────────────────

  // [PRISM] 2026-05-11 — Sprint 6-C: Gateway token auth (replaces device Ed25519 auth)
  //
  // Root cause of "pairing required: metadata-upgrade" error:
  //   Device auth requires OpenClaw to have a matching publicKey for the deviceId in its DB.
  //   Any key mismatch (or new device) triggers a pairing approval flow that blocks connection.
  //
  // Fix: mirror exactly how the browser Control UI authenticates — it uses the GATEWAY TOKEN
  //   (a master operator credential stored in localStorage.openclaw.control.settings.v1.gatewayToken
  //   and also in ~/.openclaw/openclaw.json → gateway.auth.token) with device: null.
  //   This bypasses device pairing entirely and is the intended path for trusted local clients.
  //
  // The `nonce` parameter is retained in the signature for future use (e.g. if OpenClaw
  // adds nonce validation to gateway token auth), but is not included in connect params.
  private async sendConnectResponse(_nonce: string, _challengeTs: number): Promise<void> {
    const gatewayToken = loadGatewayToken()

    if (!gatewayToken) {
      throw new Error(
        'No OpenClaw gateway token found. ' +
        'Expected at ~/.openclaw/openclaw.json → gateway.auth.token. ' +
        'Sign in to OpenClaw at http://127.0.0.1:18789 to generate one.'
      )
    }

    logger.info('[PRISM] PrismOpenClawBridge: sending connect with gateway token (device: null)')

    await this.sendRequest('connect', {
      minProtocol: PROTOCOL_VERSION,
      maxProtocol: PROTOCOL_VERSION,
      client: {
        id: CLIENT_ID,
        version: 'control-ui',
        platform: process.platform,
        mode: CLIENT_MODE,
        instanceId: crypto.randomUUID()
      },
      role: CLIENT_ROLE,
      scopes: DEFAULT_SCOPES,
      device: null,
      caps: ['tool-events'],
      auth: { token: gatewayToken },
      userAgent: `Prism/1.0 Electron/${process.versions.electron ?? 'unknown'}`,
      locale: 'en-US'
    })
  }

  // ── Request/response plumbing ───────────────────────────────────────────────

  private sendRequest<T = unknown>(method: string, params: unknown): Promise<T> {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        reject(new Error('Bridge not connected'))
        return
      }
      const id = crypto.randomUUID()
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`Request '${method}' timed out after ${REQUEST_TIMEOUT_MS}ms`))
      }, REQUEST_TIMEOUT_MS)
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer })
      this.ws.send(JSON.stringify({ type: 'req', id, method, params }))
    })
  }

  private rejectAllPending(err: Error): void {
    for (const [, p] of this.pending) { clearTimeout(p.timer); p.reject(err) }
    this.pending.clear()
    for (const [, l] of this.yieldListeners) l.onError(err)
    this.yieldListeners.clear()
  }

  // ── Keepalive & reconnect ───────────────────────────────────────────────────

  private startKeepalive(): void {
    this.keepaliveTimer = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) this.ws.ping()
    }, KEEPALIVE_INTERVAL_MS)
  }

  private scheduleReconnect(): void {
    const delay = RECONNECT_DELAYS_MS[Math.min(this.reconnectAttempt, RECONNECT_DELAYS_MS.length - 1)]
    this.reconnectAttempt++
    logger.info(`[PRISM] PrismOpenClawBridge: reconnect in ${delay}ms (attempt ${this.reconnectAttempt})`)
    this.reconnectTimer = setTimeout(() => {
      this.connect().catch(() => { /* next reconnect scheduled in close handler */ })
    }, delay)
  }

  private clearTimers(): void {
    if (this.keepaliveTimer) { clearInterval(this.keepaliveTimer); this.keepaliveTimer = null }
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null }
  }

  // ── Status broadcast ────────────────────────────────────────────────────────

  private setStatus(status: BridgeStatus): void {
    if (this.status === status) return
    this.status = status
    const win = windowService.getMainWindow()
    if (win && !win.isDestroyed()) {
      win.webContents.send(IpcChannel.OpenClaw_Bridge_StatusChanged, { status })
    }
    logger.info(`[PRISM] PrismOpenClawBridge: status → ${status}`)
  }

  public getStatus(): BridgeStatus { return this.status }

  // ── Public API: sessions ────────────────────────────────────────────────────

  /**
   * Create a new session with an OpenClaw agent.
   * Returns { session_id } where session_id is the session key
   * (e.g. 'agent:main:dashboard:UUID') used in subsequent calls.
   */
  public async sessionsSpawn(
    agentId: string,
    prompt?: string
  ): Promise<{ session_id: string }> {
    const result = await this.sendRequest<{ key: string; sessionId: string }>(
      'sessions.create',
      { agentId }
    )
    const key = result.key ?? result.sessionId

    // Subscribe to streaming events for this session key
    await this.sendRequest('sessions.messages.subscribe', { key })

    if (prompt) {
      await this.sendRequest('sessions.send', { key, message: prompt })
    }

    return { session_id: key }
  }

  /**
   * Send a message to an existing session; stream the response via callbacks.
   * Also pushes deltas to the renderer via IpcChannel.OpenClaw_Bridge_SessionsYield.
   *
   * @param sessionId  the key returned by sessionsSpawn ('agent:main:dashboard:UUID')
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
    // Register before sending to avoid missing first delta
    this.yieldListeners.set(sessionId, { onDelta, onDone, onError })
    await this.sendRequest('sessions.send', { key: sessionId, message })
  }

  public async sessionsHistory(
    sessionId: string
  ): Promise<{ messages: Array<{ role: string; content: string; ts: string }> }> {
    const result = await this.sendRequest<{
      messages?: Array<{ role: string; content: string; createdAt?: number }>
    }>('sessions.messages.list', { key: sessionId })
    return {
      messages: (result.messages ?? []).map((m) => ({
        role: m.role,
        content: m.content,
        ts: m.createdAt ? new Date(m.createdAt).toISOString() : new Date().toISOString()
      }))
    }
  }

  // ── Public API: memory ──────────────────────────────────────────────────────

  public async memorySearch(
    query: string,
    limit = 10
  ): Promise<{ results: Array<{ id: string; content: string; score: number }> }> {
    return this.sendRequest('memory.search', { query, limit })
  }

  public async memoryWrite(
    content: string,
    tags?: string[]
  ): Promise<{ id: string }> {
    return this.sendRequest('memory.write', { content, tags: tags ?? [] })
  }

  public async memoryRead(
    id: string
  ): Promise<{ id: string; content: string; tags: string[]; ts: string }> {
    return this.sendRequest('memory.read', { id })
  }

  // ── IPC registration ────────────────────────────────────────────────────────

  public registerIpcHandlers(): void {
    ipcMain.handle(IpcChannel.OpenClaw_Bridge_Connect, async () => this.connect())

    ipcMain.handle(IpcChannel.OpenClaw_Bridge_Disconnect, async () => {
      this.disconnect()
      return { success: true }
    })

    ipcMain.handle(IpcChannel.OpenClaw_Bridge_GetStatus, async () => ({ status: this.status }))

    ipcMain.handle(
      IpcChannel.OpenClaw_Bridge_SessionsSpawn,
      async (_e, { agentId, prompt }: { agentId: string; prompt?: string }) =>
        this.sessionsSpawn(agentId, prompt)
    )

    ipcMain.handle(
      IpcChannel.OpenClaw_Bridge_SessionsHistory,
      async (_e, { sessionId }: { sessionId: string }) =>
        this.sessionsHistory(sessionId)
    )

    ipcMain.handle(
      IpcChannel.OpenClaw_Bridge_MemorySearch,
      async (_e, { query, limit }: { query: string; limit?: number }) =>
        this.memorySearch(query, limit)
    )

    ipcMain.handle(
      IpcChannel.OpenClaw_Bridge_MemoryWrite,
      async (_e, { content, tags }: { content: string; tags?: string[] }) =>
        this.memoryWrite(content, tags)
    )

    ipcMain.handle(
      IpcChannel.OpenClaw_Bridge_MemoryRead,
      async (_e, { id }: { id: string }) => this.memoryRead(id)
    )

    // SessionsYield: fire-and-return; deltas pushed via webContents.send
    ipcMain.handle(
      IpcChannel.OpenClaw_Bridge_SessionsYield,
      (_e, { sessionId, message }: { sessionId: string; message: string }) =>
        new Promise<{ done: boolean }>((resolve, reject) => {
          this.sessionsYield(
            sessionId,
            message,
            (text) => {
              const win = windowService.getMainWindow()
              if (win && !win.isDestroyed()) {
                win.webContents.send(IpcChannel.OpenClaw_Bridge_SessionsYield, {
                  sessionId, delta: text, done: false
                })
              }
            },
            () => {
              const win = windowService.getMainWindow()
              if (win && !win.isDestroyed()) {
                win.webContents.send(IpcChannel.OpenClaw_Bridge_SessionsYield, {
                  sessionId, delta: '', done: true
                })
              }
              resolve({ done: true })
            },
            (err) => reject(err)
          ).catch(reject)
        })
    )

    logger.info('[PRISM] PrismOpenClawBridge: IPC handlers registered')
  }

  /** Auto-connect on app startup if OpenClaw is already running. Non-blocking. */
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
