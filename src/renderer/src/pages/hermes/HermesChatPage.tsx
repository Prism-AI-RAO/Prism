// [PRISM] 2026-05-13 — Sprint 9: Hermes Chat UI
// ─────────────────────────────────────────────────────────────────────────────
// Hermes Agent 原生对话界面。
// 路由：/hermes
// 引擎：PrismMultiAgentService.hermesChat() — SSE 流式传输
// 特性：多会话 · SOUL 人格 · 实时流式 · 记忆保留跨轮次
// ─────────────────────────────────────────────────────────────────────────────

import { Navbar, NavbarCenter } from '@renderer/components/app/Navbar'
import { loggerService } from '@renderer/services/LoggerService'
import {
  closeHermesSession,
  createHermesSession,
  getHermesSession,
  hermesChat,
  hermesEmitter,
  listHermesSessions,
  type HermesSession
} from '@renderer/services/PrismMultiAgentService'
import { Badge, Button, Empty, Input, Select, Spin, Tooltip } from 'antd'
import dayjs from 'dayjs'
import relativeTime from 'dayjs/plugin/relativeTime'
import { BotMessageSquare, MessageSquarePlus, RefreshCw, Trash2, Zap, ZapOff } from 'lucide-react'
import { type FC, useCallback, useEffect, useRef, useState } from 'react'
import styled from 'styled-components'

dayjs.extend(relativeTime)

const logger = loggerService.withContext('HermesChatPage')

// ── 人格标签 ────────────────────────────────────────────────────────────────
const PERSONALITY_LABELS: Record<string, string> = {
  helpful: '🤝 Helpful',
  technical: '⚙️ Technical',
  concise: '⚡ Concise',
  creative: '🎨 Creative',
  teacher: '📚 Teacher',
  philosopher: '🔭 Philosopher',
  noir: '🕵️ Noir',
  pirate: '🏴‍☠️ Pirate',
  shakespeare: '🎭 Shakespeare',
  surfer: '🤙 Surfer',
  hype: '🚀 Hype',
  kawaii: '✨ Kawaii',
  catgirl: '🐱 Catgirl',
  uwu: '🥺 UwU',
  prism: '🔮 Prism'
}

// ── 健康检查 ────────────────────────────────────────────────────────────────
const HERMES_GATEWAY_BASE = 'http://localhost:8642'

async function checkHermesHealth(): Promise<{ online: boolean; model?: string }> {
  try {
    const res = await fetch(`${HERMES_GATEWAY_BASE}/health`, { signal: AbortSignal.timeout(4000) })
    if (res.ok) {
      const data = await res.json()
      return { online: true, model: data.model ?? undefined }
    }
    return { online: false }
  } catch {
    return { online: false }
  }
}

async function fetchPersonality(): Promise<string | null> {
  try {
    const result = await window.api.prism.hermes.getConfig()
    return result.ok && result.config ? result.config.personality : null
  } catch {
    return null
  }
}

// ── 主组件 ──────────────────────────────────────────────────────────────────
const HermesChatPage: FC = () => {
  const [hermesonline, setHermesOnline] = useState<boolean | null>(null)
  const [hermesModel, setHermesModel] = useState<string | null>(null)
  const [currentPersonality, setCurrentPersonality] = useState<string | null>(null)
  const [sessions, setSessions] = useState<HermesSession[]>([])
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null)
  const [inputText, setInputText] = useState('')
  const [sendLoading, setSendLoading] = useState(false)
  const [streamingVersion, setStreamingVersion] = useState(0)
  const streamingTextRef = useRef<Record<string, string>>({})
  const messagesEndRef = useRef<HTMLDivElement>(null)

  // ── 新会话 UI 状态 ────────────────────────────────────────────────────────
  const [newLabel, setNewLabel] = useState('')
  const [newPersonality, setNewPersonality] = useState<string>('helpful')
  const [showNewForm, setShowNewForm] = useState(false)

  // ── 刷新会话列表 ──────────────────────────────────────────────────────────
  const refreshSessions = useCallback(() => {
    setSessions([...listHermesSessions()])
  }, [])

  // ── 健康检查 ──────────────────────────────────────────────────────────────
  const doHealthCheck = useCallback(async () => {
    const { online, model } = await checkHermesHealth()
    setHermesOnline(online)
    if (model) setHermesModel(model)
    const personality = await fetchPersonality()
    setCurrentPersonality(personality)
  }, [])

  useEffect(() => {
    void doHealthCheck()
    const interval = setInterval(() => void doHealthCheck(), 15_000)
    return () => clearInterval(interval)
  }, [doHealthCheck])

  // ── Hermes 流事件监听 ─────────────────────────────────────────────────────
  useEffect(() => {
    const offDelta = hermesEmitter.on('hermes_delta', ({ sessionId, text }) => {
      streamingTextRef.current[sessionId] = (streamingTextRef.current[sessionId] ?? '') + text
      setStreamingVersion((v) => v + 1)
    })

    const offDone = hermesEmitter.on('hermes_done', ({ sessionId }) => {
      streamingTextRef.current[sessionId] = ''
      setStreamingVersion((v) => v + 1)
      refreshSessions()
    })

    const offError = hermesEmitter.on('hermes_error', ({ sessionId }) => {
      streamingTextRef.current[sessionId] = ''
      setStreamingVersion((v) => v + 1)
      refreshSessions()
    })

    return () => {
      offDelta()
      offDone()
      offError()
    }
  }, [refreshSessions])

  // ── 自动滚动到底部 ────────────────────────────────────────────────────────
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [sessions, streamingVersion, activeSessionId])

  // ── 创建新会话 ────────────────────────────────────────────────────────────
  const handleCreateSession = () => {
    const label = newLabel.trim() || `对话 ${dayjs().format('HH:mm:ss')}`
    const session = createHermesSession(label, { personality: newPersonality })
    setActiveSessionId(session.id)
    setShowNewForm(false)
    setNewLabel('')
    refreshSessions()
    logger.info(`[HermesChat] Created session: ${session.id} (${label})`)
  }

  // ── 关闭会话 ──────────────────────────────────────────────────────────────
  const handleCloseSession = (id: string) => {
    closeHermesSession(id)
    if (activeSessionId === id) {
      const remaining = listHermesSessions()
      setActiveSessionId(remaining.length > 0 ? remaining[0].id : null)
    }
    refreshSessions()
  }

  // ── 发送消息 ──────────────────────────────────────────────────────────────
  const handleSend = async () => {
    const text = inputText.trim()
    if (!text || !activeSessionId || sendLoading) return

    setInputText('')
    setSendLoading(true)
    try {
      await hermesChat(activeSessionId, text)
    } catch (err) {
      window.toast?.error(`发送失败：${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setSendLoading(false)
    }
  }

  const activeSession = activeSessionId ? getHermesSession(activeSessionId) : null
  const streamingText = activeSessionId ? (streamingTextRef.current[activeSessionId] ?? '') : ''

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <PageContainer>
      {/* ── Navbar ── */}
      <Navbar>
        <NavbarCenter style={{ borderRight: 'none', gap: 8 }}>
          <BotMessageSquare size={16} />
          <span style={{ fontWeight: 600 }}>Hermes</span>
          {hermesonline !== null && (
            <Tooltip title={hermesonline ? `在线 · ${hermesModel ?? 'hermes-agent'}` : 'Hermes Gateway 未响应'}>
              <span style={{ display: 'flex', alignItems: 'center' }}>
                {hermesonline ? (
                  <Zap size={13} color="var(--color-success, #52c41a)" />
                ) : (
                  <ZapOff size={13} color="var(--color-error)" />
                )}
              </span>
            </Tooltip>
          )}
          {currentPersonality && (
            <Badge
              color="var(--color-primary)"
              text={
                <span style={{ fontSize: 11, color: 'var(--color-text-secondary)' }}>
                  {PERSONALITY_LABELS[currentPersonality] ?? currentPersonality}
                </span>
              }
            />
          )}
          <Tooltip title="刷新状态">
            <Button
              type="text"
              size="small"
              icon={<RefreshCw size={12} />}
              onClick={() => void doHealthCheck()}
              style={{ padding: '0 4px', height: 20, marginLeft: 'auto' }}
            />
          </Tooltip>
        </NavbarCenter>
      </Navbar>

      {/* ── Offline Banner ── */}
      {hermesonline === false && (
        <OfflineBanner>
          ⚠️ Hermes Gateway 未运行 — 运行 <code>hermes gateway start</code> 或双击{' '}
          <code>fix_hermes_remove_anthropic.command</code>
        </OfflineBanner>
      )}

      <Body>
        {/* ── Session List ── */}
        <SessionList>
          <SessionListHeader>
            <span>会话</span>
            <Tooltip title="新建会话">
              <Button
                type="text"
                size="small"
                icon={<MessageSquarePlus size={13} />}
                onClick={() => setShowNewForm((v) => !v)}
                style={{ padding: '0 4px', height: 20 }}
              />
            </Tooltip>
          </SessionListHeader>

          {/* 新建会话表单 */}
          {showNewForm && (
            <NewSessionForm>
              <Input
                size="small"
                placeholder="会话名称（可选）"
                value={newLabel}
                onChange={(e) => setNewLabel(e.target.value)}
                onPressEnter={handleCreateSession}
                style={{ marginBottom: 6 }}
              />
              <Select
                size="small"
                style={{ width: '100%', marginBottom: 6 }}
                value={newPersonality}
                onChange={setNewPersonality}
                options={Object.entries(PERSONALITY_LABELS).map(([k, v]) => ({ value: k, label: v }))}
              />
              <div style={{ display: 'flex', gap: 4 }}>
                <Button size="small" type="primary" block onClick={handleCreateSession}>
                  创建
                </Button>
                <Button size="small" block onClick={() => setShowNewForm(false)}>
                  取消
                </Button>
              </div>
            </NewSessionForm>
          )}

          <SessionItems>
            {sessions.length === 0 ? (
              <EmptyHint>暂无会话<br />点击 + 新建</EmptyHint>
            ) : (
              sessions.map((s) => (
                <SessionItem
                  key={s.id}
                  $active={s.id === activeSessionId}
                  onClick={() => setActiveSessionId(s.id)}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                    <SessionItemLabel>{s.label}</SessionItemLabel>
                    <Tooltip title="关闭会话">
                      <Button
                        type="text"
                        size="small"
                        icon={<Trash2 size={11} />}
                        onClick={(e) => { e.stopPropagation(); handleCloseSession(s.id) }}
                        style={{ padding: '0 2px', height: 18, opacity: 0.5 }}
                      />
                    </Tooltip>
                  </div>
                  <SessionItemMeta>
                    <StatusDot $status={s.status} />
                    <span style={{ fontSize: 10, color: 'var(--color-text-tertiary)' }}>
                      {PERSONALITY_LABELS[s.personality ?? ''] ?? s.personality ?? 'helpful'} · {dayjs(s.createdAt).fromNow()}
                    </span>
                  </SessionItemMeta>
                </SessionItem>
              ))
            )}
          </SessionItems>

          <div style={{ padding: 8, borderTop: '0.5px solid var(--color-border)' }}>
            <Button
              block
              size="small"
              type="dashed"
              icon={<MessageSquarePlus size={12} />}
              onClick={() => setShowNewForm(true)}
              disabled={hermesonline === false}>
              新建 Hermes 会话
            </Button>
          </div>
        </SessionList>

        {/* ── Chat Area ── */}
        <ChatArea>
          {!activeSession ? (
            <NoSessionPane>
              <BotMessageSquare size={56} strokeWidth={1} color="var(--color-text-tertiary)" />
              <div style={{ fontSize: 15, fontWeight: 600, marginTop: 12 }}>Hermes Agent</div>
              <div style={{ fontSize: 13, color: 'var(--color-text-secondary)', marginTop: 4 }}>
                本地长期记忆 · 自进化 · SOUL 人格
              </div>
              <Button
                type="primary"
                icon={<MessageSquarePlus size={14} />}
                style={{ marginTop: 20 }}
                onClick={() => setShowNewForm(true)}
                disabled={hermesonline === false}>
                开始对话
              </Button>
            </NoSessionPane>
          ) : (
            <>
              {/* 消息区 */}
              <MessagesContainer>
                {activeSession.messages.filter((m) => m.role !== 'system').length === 0 && streamingText === '' ? (
                  <Empty
                    description={`${PERSONALITY_LABELS[activeSession.personality ?? ''] ?? '🤝 Helpful'} · 说点什么开始吧`}
                    style={{ marginTop: 48 }}
                  />
                ) : (
                  <>
                    {activeSession.messages
                      .filter((m) => m.role !== 'system')
                      .map((msg, i) => (
                        <MessageBubble key={i} $role={msg.role}>
                          <BubbleContent $role={msg.role}>
                            {msg.content}
                          </BubbleContent>
                          <BubbleTime>{dayjs(msg.ts).format('HH:mm:ss')}</BubbleTime>
                        </MessageBubble>
                      ))}
                    {/* 流式文字 */}
                    {streamingText && (
                      <MessageBubble $role="assistant">
                        <BubbleContent $role="assistant">
                          {streamingText}
                          <StreamingCursor />
                        </BubbleContent>
                      </MessageBubble>
                    )}
                    {/* 等待首个 token */}
                    {activeSession.status === 'streaming' && !streamingText && (
                      <MessageBubble $role="assistant">
                        <BubbleContent $role="assistant">
                          <Spin size="small" />
                        </BubbleContent>
                      </MessageBubble>
                    )}
                  </>
                )}
                <div ref={messagesEndRef} />
              </MessagesContainer>

              {/* 输入区 */}
              <InputArea>
                <Input.TextArea
                  value={inputText}
                  onChange={(e) => setInputText(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault()
                      void handleSend()
                    }
                  }}
                  placeholder="发送消息给 Hermes… (Enter 发送，Shift+Enter 换行)"
                  autoSize={{ minRows: 1, maxRows: 6 }}
                  disabled={sendLoading || hermesonline === false}
                  style={{ flex: 1, resize: 'none' }}
                />
                <Button
                  type="primary"
                  onClick={() => void handleSend()}
                  loading={sendLoading}
                  disabled={!inputText.trim() || hermesonline === false}>
                  发送
                </Button>
              </InputArea>
            </>
          )}
        </ChatArea>
      </Body>
    </PageContainer>
  )
}

// ── Styled Components ────────────────────────────────────────────────────────

const PageContainer = styled.div`
  display: flex;
  flex-direction: column;
  flex: 1;
  height: 100%;
  overflow: hidden;
`

const Body = styled.div`
  display: flex;
  flex: 1;
  overflow: hidden;
`

const SessionList = styled.div`
  width: 220px;
  min-width: 180px;
  border-right: 0.5px solid var(--color-border);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: var(--color-background-soft);
`

const SessionListHeader = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 12px;
  border-bottom: 0.5px solid var(--color-border);
  font-size: 12px;
  font-weight: 600;
  color: var(--color-text-2);
  text-transform: uppercase;
  letter-spacing: 0.04em;
`

const NewSessionForm = styled.div`
  padding: 8px 10px;
  border-bottom: 0.5px solid var(--color-border);
  background: var(--color-background);
`

const SessionItems = styled.div`
  flex: 1;
  overflow-y: auto;
  padding: 4px 0;
`

const SessionItem = styled.div<{ $active: boolean }>`
  padding: 8px 12px;
  cursor: pointer;
  border-left: 2px solid ${({ $active }) => ($active ? 'var(--color-primary)' : 'transparent')};
  background: ${({ $active }) => ($active ? 'var(--color-primary-bg, rgba(22,119,255,0.08))' : 'transparent')};

  &:hover {
    background: var(--color-background);
  }
`

const SessionItemLabel = styled.div`
  font-size: 13px;
  font-weight: 500;
  color: var(--color-text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 150px;
`

const SessionItemMeta = styled.div`
  display: flex;
  align-items: center;
  gap: 4px;
  margin-top: 2px;
`

const StatusDot = styled.span<{ $status: string }>`
  width: 6px;
  height: 6px;
  border-radius: 50%;
  display: inline-block;
  background: ${({ $status }) => ($status === 'streaming' ? '#faad14' : $status === 'error' ? '#ff4d4f' : '#52c41a')};
`

const EmptyHint = styled.div`
  padding: 24px 12px;
  text-align: center;
  font-size: 12px;
  color: var(--color-text-tertiary);
  line-height: 1.8;
`

const ChatArea = styled.div`
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
`

const NoSessionPane = styled.div`
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  color: var(--color-text-secondary);
`

const MessagesContainer = styled.div`
  flex: 1;
  overflow-y: auto;
  padding: 16px 20px;
  display: flex;
  flex-direction: column;
  gap: 12px;
`

const MessageBubble = styled.div<{ $role: string }>`
  display: flex;
  flex-direction: column;
  align-items: ${({ $role }) => ($role === 'user' ? 'flex-end' : 'flex-start')};
`

const BubbleContent = styled.div<{ $role: string }>`
  max-width: 72%;
  padding: 10px 14px;
  border-radius: ${({ $role }) => ($role === 'user' ? '16px 16px 4px 16px' : '4px 16px 16px 16px')};
  background: ${({ $role }) => ($role === 'user' ? 'var(--color-primary)' : 'var(--color-background-soft)')};
  color: ${({ $role }) => ($role === 'user' ? '#fff' : 'var(--color-text)')};
  font-size: 14px;
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-word;
`

const BubbleTime = styled.div`
  font-size: 10px;
  color: var(--color-text-tertiary);
  margin-top: 3px;
  padding: 0 4px;
`

const StreamingCursor = styled.span`
  display: inline-block;
  width: 2px;
  height: 1em;
  background: currentColor;
  margin-left: 2px;
  vertical-align: text-bottom;
  animation: blink 0.8s step-end infinite;

  @keyframes blink {
    0%, 100% { opacity: 1; }
    50% { opacity: 0; }
  }
`

const InputArea = styled.div`
  padding: 12px 16px;
  border-top: 0.5px solid var(--color-border);
  display: flex;
  gap: 8px;
  align-items: flex-end;
`

const OfflineBanner = styled.div`
  padding: 8px 16px;
  background: var(--color-error-bg, #fff2f0);
  border-bottom: 1px solid var(--color-error-border, #ffccc7);
  font-size: 12px;
  color: var(--color-error);

  code {
    background: rgba(0, 0, 0, 0.06);
    padding: 1px 4px;
    border-radius: 3px;
    font-size: 11px;
  }
`

export default HermesChatPage
