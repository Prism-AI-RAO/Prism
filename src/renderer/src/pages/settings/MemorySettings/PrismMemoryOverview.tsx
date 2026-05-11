// [PRISM] 2026-05-11 — Sprint 2-C: Prism Memory Overview card
// Shows OpenClaw bridge status, memory stats, and MEMORY.md preview
// in the Settings > Memory page.

import { useEffect, useRef, useState } from 'react'

import { Badge, Button, Collapse, Spin, Tooltip } from 'antd'
import { BrainCircuit, ChevronDown, Link, LinkOff, RefreshCw } from 'lucide-react'
import styled from 'styled-components'

import { SettingGroup, SettingHelpText, SettingRow, SettingRowTitle } from '../index'

type BridgeStatus = 'disconnected' | 'connecting' | 'connected' | 'error'

interface Props {
  memoryCount: number
  theme?: string
}

const OPENCLAW_MEMORY_MD = `${window.electron?.process?.env?.HOME ?? '~'}/.openclaw/workspace/MEMORY.md`

const statusColor: Record<BridgeStatus, string> = {
  connected: '#52c41a',
  connecting: '#faad14',
  disconnected: 'var(--color-text-tertiary)',
  error: '#ff4d4f'
}

const statusLabel: Record<BridgeStatus, string> = {
  connected: 'Connected',
  connecting: 'Connecting…',
  disconnected: 'Disconnected',
  error: 'Error'
}

const PrismMemoryOverview: React.FC<Props> = ({ memoryCount, theme }) => {
  const [bridgeStatus, setBridgeStatus] = useState<BridgeStatus>('disconnected')
  const [connecting, setConnecting] = useState(false)
  const [memoryMd, setMemoryMd] = useState<string | null>(null)
  const [memoryMdSize, setMemoryMdSize] = useState<number | null>(null)
  const [loadingMd, setLoadingMd] = useState(false)
  const unsubRef = useRef<(() => void) | null>(null)

  // Initial status check + subscribe to changes
  useEffect(() => {
    const init = async () => {
      try {
        const { status } = await window.api.openclaw.bridge.getStatus()
        setBridgeStatus(status as BridgeStatus)
      } catch {
        // Bridge API not available (older build)
      }
    }
    void init()

    // Subscribe to bridge status changes
    if (window.api.openclaw?.bridge?.onStatusChanged) {
      const unsub = window.api.openclaw.bridge.onStatusChanged((status: string) => {
        setBridgeStatus(status as BridgeStatus)
      })
      unsubRef.current = unsub
    }

    return () => {
      unsubRef.current?.()
    }
  }, [])

  const handleConnect = async () => {
    setConnecting(true)
    try {
      await window.api.openclaw.bridge.connect()
    } finally {
      setConnecting(false)
    }
  }

  const handleDisconnect = async () => {
    await window.api.openclaw.bridge.disconnect()
  }

  const loadMemoryMd = async () => {
    setLoadingMd(true)
    try {
      const result = await window.api.prism.readMemoryFile(OPENCLAW_MEMORY_MD)
      if (result.content !== null) {
        setMemoryMd(result.content)
        setMemoryMdSize(result.sizeBytes ?? null)
      } else {
        setMemoryMd(null)
      }
    } finally {
      setLoadingMd(false)
    }
  }

  const formatBytes = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`
  }

  return (
    <SettingGroup
      theme={theme}
      style={{ marginBottom: 0, borderBottom: '1px solid var(--color-border)', paddingBottom: 16 }}>
      {/* Header row */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14 }}>
        <BrainCircuit size={16} color="var(--color-primary)" />
        <span style={{ fontWeight: 600, fontSize: 14, color: 'var(--color-text)' }}>Prism Memory Engine</span>
        <Badge
          color={statusColor[bridgeStatus]}
          text={
            <span style={{ fontSize: 12, color: 'var(--color-text-secondary)' }}>
              OpenClaw {statusLabel[bridgeStatus]}
            </span>
          }
        />
      </div>

      {/* Stats row */}
      <SettingRow>
        <StatsGrid>
          <StatCard>
            <div className="stat-value">{memoryCount}</div>
            <div className="stat-label">Memory Fragments</div>
          </StatCard>
          <StatCard>
            <div className="stat-value" style={{ color: statusColor[bridgeStatus] }}>
              {statusLabel[bridgeStatus]}
            </div>
            <div className="stat-label">OpenClaw Bridge</div>
          </StatCard>
          {memoryMdSize !== null && (
            <StatCard>
              <div className="stat-value">{formatBytes(memoryMdSize)}</div>
              <div className="stat-label">MEMORY.md</div>
            </StatCard>
          )}
        </StatsGrid>

        {/* Action buttons */}
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          {bridgeStatus === 'disconnected' || bridgeStatus === 'error' ? (
            <Tooltip title="Connect to local OpenClaw WebSocket gateway">
              <Button
                size="small"
                icon={<Link size={14} />}
                loading={connecting || bridgeStatus === 'connecting'}
                onClick={handleConnect}>
                Connect
              </Button>
            </Tooltip>
          ) : (
            <Tooltip title="Disconnect from OpenClaw gateway">
              <Button size="small" icon={<LinkOff size={14} />} onClick={handleDisconnect} danger>
                Disconnect
              </Button>
            </Tooltip>
          )}
        </div>
      </SettingRow>

      {/* MEMORY.md preview */}
      <div style={{ marginTop: 12 }}>
        <Collapse
          size="small"
          ghost
          onChange={(keys) => {
            if (keys.includes('memory-md') && memoryMd === null && !loadingMd) {
              void loadMemoryMd()
            }
          }}
          items={[
            {
              key: 'memory-md',
              label: (
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ fontSize: 13, color: 'var(--color-text-secondary)' }}>MEMORY.md preview</span>
                  <Button
                    type="text"
                    size="small"
                    icon={<RefreshCw size={12} />}
                    onClick={(e) => {
                      e.stopPropagation()
                      void loadMemoryMd()
                    }}
                    style={{ padding: '0 4px', height: 20 }}
                  />
                  {memoryMdSize !== null && (
                    <SettingHelpText style={{ fontSize: 11 }}>{formatBytes(memoryMdSize)}</SettingHelpText>
                  )}
                </div>
              ),
              children: loadingMd ? (
                <Spin size="small" />
              ) : memoryMd === null ? (
                <SettingHelpText>
                  MEMORY.md not found at <code>~/.openclaw/workspace/MEMORY.md</code>. This file is created by OpenClaw
                  after the first memory write.
                </SettingHelpText>
              ) : (
                <MemoryMdPreview>
                  {memoryMd.slice(0, 3000)}
                  {memoryMd.length > 3000 && (
                    <span style={{ color: 'var(--color-text-tertiary)' }}>{`\n\n… (${memoryMd.length - 3000} more chars)`}</span>
                  )}
                </MemoryMdPreview>
              )
            }
          ]}
          expandIcon={({ isActive }) => <ChevronDown size={12} style={{ transform: isActive ? 'rotate(180deg)' : 'none' }} />}
        />
      </div>
    </SettingGroup>
  )
}

const StatsGrid = styled.div`
  display: flex;
  gap: 24px;
`

const StatCard = styled.div`
  display: flex;
  flex-direction: column;
  gap: 2px;

  .stat-value {
    font-size: 20px;
    font-weight: 700;
    color: var(--color-text);
    line-height: 1.2;
  }

  .stat-label {
    font-size: 11px;
    color: var(--color-text-tertiary);
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }
`

const MemoryMdPreview = styled.pre`
  font-family: var(--font-mono, 'JetBrains Mono', monospace);
  font-size: 12px;
  line-height: 1.6;
  color: var(--color-text-secondary);
  background: var(--color-background-soft);
  border: 1px solid var(--color-border);
  border-radius: 6px;
  padding: 12px 14px;
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 320px;
  overflow-y: auto;
  margin: 0;
`

export default PrismMemoryOverview
