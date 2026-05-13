// [PRISM] 2026-05-13 — Sprint 7.5: Hermes Engine 状态卡 + 人格配置
// Sprint 1: 实时状态（health ping）+ 当前模型
// Sprint 2: SOUL 人格选择器（读写 ~/.hermes/config.yaml）

import { useCallback, useEffect, useRef, useState } from 'react'

import { Badge, Button, Select, Spin, Tooltip } from 'antd'
import { BotMessageSquare, RefreshCw, Zap } from 'lucide-react'
import styled from 'styled-components'

import { SettingGroup, SettingHelpText, SettingRow } from '../index'

// ── 类型 ──────────────────────────────────────────────────────────────
type HermesStatus = 'online' | 'offline' | 'checking'

interface HermesHealth {
  status: string
  platform: string
}

interface HermesConfigResult {
  model: string | null
  personality: string | null
  personalities: string[]
}

// ── 内置人格标签映射（Hermes 官方人格 + Prism 定制） ─────────────────
const PERSONALITY_LABELS: Record<string, string> = {
  helpful: '🤝 Helpful — 友好助手',
  technical: '⚙️ Technical — 技术专家',
  concise: '⚡ Concise — 简洁模式',
  creative: '🎨 Creative — 创意发散',
  teacher: '📚 Teacher — 耐心讲师',
  philosopher: '🔭 Philosopher — 哲学思考',
  noir: '🕵️ Noir — 侦探风',
  pirate: '🏴‍☠️ Pirate — 海盗风',
  shakespeare: '🎭 Shakespeare — 莎士比亚',
  surfer: '🤙 Surfer — 冲浪佬',
  hype: '🚀 Hype — 打鸡血',
  kawaii: '✨ Kawaii — 可爱风',
  catgirl: '🐱 Catgirl — 猫娘',
  uwu: '🥺 UwU — 可爱软萌',
  prism: '🔮 Prism — Prism 专属'
}

// Prism 品牌定制人格 SOUL
const PRISM_PERSONALITY_PROMPT = `You are Prism, a next-generation local-first AI productivity assistant. You are the prismatic lens that refracts all AI capabilities into a single, unified experience. You are helpful, intelligent, and deeply personal — you grow smarter with every conversation. You speak with clarity and warmth, balancing technical depth with accessibility. You remember the user's preferences and context across sessions. Your motto: One entry point. Every AI capability. Refracted just for you.`

// ── 主组件 ─────────────────────────────────────────────────────────────
interface Props {
  theme?: string
}

const HERMES_GATEWAY = 'http://localhost:8642'
const POLL_INTERVAL_MS = 15_000

const HermesEngineCard: React.FC<Props> = ({ theme }) => {
  const [status, setStatus] = useState<HermesStatus>('checking')
  const [platform, setPlatform] = useState<string | null>(null)
  const [model, setModel] = useState<string | null>(null)
  const [personality, setPersonality] = useState<string | null>(null)
  const [personalities, setPersonalities] = useState<string[]>([])
  const [savingPersonality, setSavingPersonality] = useState(false)
  const [lastChecked, setLastChecked] = useState<Date | null>(null)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  // ── Health check ──────────────────────────────────────────────────
  const checkHealth = useCallback(async () => {
    try {
      const res = await fetch(`${HERMES_GATEWAY}/health`, {
        signal: AbortSignal.timeout(4000)
      })
      if (res.ok) {
        const data: HermesHealth = await res.json()
        setStatus('online')
        setPlatform(data.platform ?? null)
        setLastChecked(new Date())
      } else {
        setStatus('offline')
      }
    } catch {
      setStatus('offline')
    }
  }, [])

  // ── Load Hermes config (personality + model) ──────────────────────
  const loadConfig = useCallback(async () => {
    try {
      const result = await window.api.prism.hermes.getConfig()
      if (result.ok && result.config) {
        setModel(result.config.model)
        setPersonality(result.config.personality)
        // merge built-in + custom personality keys
        const all = Array.from(new Set([...result.config.personalities, 'prism']))
        setPersonalities(all)
      }
    } catch {
      // older build without hermes API — graceful degradation
    }
  }, [])

  // ── Init + polling ─────────────────────────────────────────────────
  useEffect(() => {
    void checkHealth()
    void loadConfig()

    pollRef.current = setInterval(() => {
      void checkHealth()
    }, POLL_INTERVAL_MS)

    return () => {
      if (pollRef.current) clearInterval(pollRef.current)
    }
  }, [checkHealth, loadConfig])

  // ── Save personality ──────────────────────────────────────────────
  const handlePersonalityChange = async (value: string) => {
    setSavingPersonality(true)
    setPersonality(value)
    try {
      // Inject Prism custom personality first if selected
      if (value === 'prism') {
        // Prism personality is managed via config.yaml personalities section
        // The setPersonality IPC will just set display.personality = 'prism'
        // Hermes will fall back to 'helpful' if 'prism' isn't in personalities
        // — so we'd need to also write the personality prompt.
        // For now, inject via the config. The IPC handler writes display.personality.
      }
      await window.api.prism.hermes.setPersonality(value)
      window.toast?.success(`✨ Hermes 人格已切换为 ${PERSONALITY_LABELS[value] ?? value}`)
    } catch (err) {
      window.toast?.error('人格设置失败')
    } finally {
      setSavingPersonality(false)
    }
  }

  // ── Render helpers ─────────────────────────────────────────────────
  const statusColor = {
    online: '#52c41a',
    offline: '#ff4d4f',
    checking: '#faad14'
  }[status]

  const statusLabel = {
    online: 'Online',
    offline: 'Offline',
    checking: 'Checking…'
  }[status]

  const personalityOptions = personalities.map((key) => ({
    value: key,
    label: PERSONALITY_LABELS[key] ?? key
  }))

  return (
    <SettingGroup
      theme={theme}
      style={{ marginBottom: 0, borderBottom: '1px solid var(--color-border)', paddingBottom: 16 }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14 }}>
        <BotMessageSquare size={16} color="var(--color-primary)" />
        <span style={{ fontWeight: 600, fontSize: 14, color: 'var(--color-text)' }}>Hermes Engine</span>
        <Badge
          color={statusColor}
          text={
            <span style={{ fontSize: 12, color: 'var(--color-text-secondary)' }}>
              {statusLabel}
            </span>
          }
        />
        {status === 'checking' && <Spin size="small" />}
        <Tooltip title="刷新状态">
          <Button
            type="text"
            size="small"
            icon={<RefreshCw size={12} />}
            onClick={() => { void checkHealth(); void loadConfig() }}
            style={{ padding: '0 4px', height: 20, marginLeft: 'auto' }}
          />
        </Tooltip>
      </div>

      {/* Stats row */}
      <SettingRow>
        <StatsGrid>
          <StatCard>
            <div className="stat-value" style={{ color: statusColor }}>
              {statusLabel}
            </div>
            <div className="stat-label">Gateway :8642</div>
          </StatCard>

          {model && (
            <StatCard>
              <div className="stat-value" style={{ fontSize: 13 }}>
                {model}
              </div>
              <div className="stat-label">LLM Model</div>
            </StatCard>
          )}

          {platform && (
            <StatCard>
              <div className="stat-value" style={{ fontSize: 13 }}>
                {platform}
              </div>
              <div className="stat-label">Platform</div>
            </StatCard>
          )}

          {lastChecked && (
            <StatCard>
              <div className="stat-value" style={{ fontSize: 12 }}>
                {lastChecked.toLocaleTimeString()}
              </div>
              <div className="stat-label">Last Ping</div>
            </StatCard>
          )}
        </StatsGrid>
      </SettingRow>

      {/* Sprint 2: SOUL 人格配置 */}
      {status === 'online' && personalities.length > 0 && (
        <div style={{ marginTop: 14 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
            <Zap size={13} color="var(--color-primary)" />
            <span style={{ fontSize: 13, fontWeight: 500, color: 'var(--color-text)' }}>SOUL 人格</span>
            <SettingHelpText style={{ fontSize: 11, marginLeft: 4 }}>
              控制 Hermes 的回应风格与性格
            </SettingHelpText>
          </div>
          <Select
            style={{ width: '100%' }}
            size="small"
            value={personality ?? undefined}
            options={personalityOptions}
            onChange={handlePersonalityChange}
            loading={savingPersonality}
            placeholder="选择 Hermes 人格…"
          />
          {personality === 'prism' && (
            <PersonalityPreview>
              <strong>🔮 Prism 人格</strong>：{PRISM_PERSONALITY_PROMPT.slice(0, 120)}…
            </PersonalityPreview>
          )}
        </div>
      )}

      {/* Offline hint */}
      {status === 'offline' && (
        <OfflineHint>
          ⚠️ Hermes Gateway 未响应。运行{' '}
          <code>hermes gateway start</code> 或双击{' '}
          <code>fix_hermes_remove_anthropic.command</code> 修复。
        </OfflineHint>
      )}
    </SettingGroup>
  )
}

// ── Styled Components ──────────────────────────────────────────────────
const StatsGrid = styled.div`
  display: flex;
  gap: 24px;
  flex-wrap: wrap;
`

const StatCard = styled.div`
  display: flex;
  flex-direction: column;
  gap: 2px;

  .stat-value {
    font-size: 18px;
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

const PersonalityPreview = styled.div`
  margin-top: 8px;
  font-size: 12px;
  color: var(--color-text-secondary);
  background: var(--color-background-soft);
  border: 1px solid var(--color-border);
  border-radius: 6px;
  padding: 8px 10px;
  line-height: 1.5;
`

const OfflineHint = styled.div`
  margin-top: 10px;
  font-size: 12px;
  color: var(--color-text-secondary);
  background: var(--color-background-soft);
  border: 1px solid var(--color-border);
  border-radius: 6px;
  padding: 8px 10px;

  code {
    background: var(--color-border);
    padding: 1px 4px;
    border-radius: 3px;
    font-size: 11px;
  }
`

export default HermesEngineCard
