// [PRISM] 2026-05-11 — Sprint 5: Multi-Agent 对话页面
// ─────────────────────────────────────────────────────────────────────────────
// 通过 PrismOpenClawBridge 与任意 OpenClaw Agent 直接对话。
// 支持多会话并发、流式响应、会话历史。
//
// 路由：/sessions
// 入口：OpenClaw 页面 "管理 Agent 会话" 按钮
// ─────────────────────────────────────────────────────────────────────────────

import { Navbar, NavbarCenter } from '@renderer/components/app/Navbar'
import { loggerService } from '@renderer/services/LoggerService'
import {
  clearAllSessions,
  forgetSession,
  getSession,
  listSessions,
  multiAgentEmitter,
  sendMessage,
  spawnSession,
  type AgentMessage,
  type AgentSession
} from '@renderer/services/PrismMultiAgentService'
import { useAppSelector } from '@renderer/store'
import { Button, Empty, Form, Input, Modal, Spin, Tooltip } from 'antd'
import dayjs from 'dayjs'
import relativeTime from 'dayjs/plugin/relativeTime'
import { BotMessageSquare, MessageSquarePlus, RotateCcw, Trash2, Zap, ZapOff } from 'lucide-react'
import { type FC, useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import styled from 'styled-components'

dayjs.extend(relativeTime)

const logger = loggerService.withContext('PrismMultiAgentPage')

// ── Styled components ─────────────────────────────────────────────────────────

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

const SessionItems = styled.div`
  flex: 1;
  overflow-y: auto;
  padding: 4px 0;
`

const SessionItem = styled.div<{ $active: boolean }>`
  padding: 8px 12px;
  cursor: pointer;
  border-radius: 6px;
  margin: 2px 6px;
  background: ${(p) => (p.$active ? 'var(--color-primary-bg)' : 'transparent')};
  border: 1px solid ${(p) => (p.$active ? 'var(--color-primary-border)' : 'transparent')};
  transition: background 0.15s;
  &:hover {
    background: ${(p) => (p.$active ? 'var(--color-primary-bg)' : 'var(--color-background-mute)')};
  }
`

const SessionItemAgent = styled.div`
  font-size: 12px;
  font-weight: 600;
  color: var(--color-text-1);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
`

const SessionItemMeta = styled.div`
  font-size: 11px;
  color: var(--color-text-3);
  margin-top: 2px;
  display: flex;
  align-items: center;
  gap: 6px;
`

const StatusDot = styled.span<{ $status: AgentSession['status'] }>`
  width: 6px;
  height: 6px;
  border-radius: 50%;
  flex-shrink: 0;
  background: ${(p) =>
    p.$status === 'sending'
      ? 'var(--color-primary)'
      : p.$status === 'error'
        ? 'var(--color-error)'
        : 'var(--color-success, #52c41a)'};
`

const ChatArea = styled.div`
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
`

const MessagesContainer = styled.div`
  flex: 1;
  overflow-y: auto;
  padding: 16px 20px;
  display: flex;
  flex-direction: column;
  gap: 12px;
`

const MessageBubble = styled.div<{ $role: 'user' | 'assistant' }>`
  display: flex;
  flex-direction: column;
  align-items: ${(p) => (p.$role === 'user' ? 'flex-end' : 'flex-start')};
  gap: 4px;
`

const BubbleContent = styled.div<{ $role: 'user' | 'assistant' }>`
  max-width: 78%;
  padding: 9px 13px;
  border-radius: ${(p) => (p.$role === 'user' ? '14px 14px 4px 14px' : '14px 14px 14px 4px')};
  background: ${(p) => (p.$role === 'user' ? 'var(--color-primary)' : 'var(--color-background-mute)')};
  color: ${(p) => (p.$role === 'user' ? '#fff' : 'var(--color-text-1)')};
  font-size: 13.5px;
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-word;
`

const BubbleTime = styled.div`
  font-size: 10px;
  color: var(--color-text-3);
  padding: 0 4px;
`

const StreamingIndicator = styled.span`
  display: inline-block;
  width: 6px;
  height: 14px;
  background: var(--color-primary);
  border-radius: 2px;
  margin-left: 4px;
  animation: blink 0.8s step-end infinite;
  @keyframes blink {
    50% { opacity: 0; }
  }
`

const InputArea = styled.div`
  border-top: 0.5px solid var(--color-border);
  padding: 12px 16px;
  display: flex;
  gap: 8px;
  align-items: flex-end;
  background: var(--color-background);
`

const NoSessionPane = styled.div`
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 16px;
  color: var(--color-text-3);
`

// ── Sub-component: New Session Modal ──────────────────────────────────────────

interface NewSessionModalProps {
  open: boolean
  onClose: () => void
  onCreated: (sessionId: string) => void
}

const NewSessionModal: FC<NewSessionModalProps> = ({ open, onClose, onCreated }) => {
  const [form] = Form.useForm()
  const [loading, setLoading] = useState(false)

  const handleOk = async () => {
    const values = await form.validateFields() as { agentId: string; prompt?: string }
    setLoading(true)
    try {
      const sessionId = await spawnSession(values.agentId.trim(), values.prompt?.trim())
      form.resetFields()
      onCreated(sessionId)
    } catch (err) {
      logger.warn('[MultiAgent] Failed to spawn session:', err as Error)
      window.toast?.error('无法创建 Agent 会话 — 请确认 OpenClaw 网关已运行并已连接')
    } finally {
      setLoading(false)
    }
  }

  return (
    <Modal
      title={
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <BotMessageSquare size={16} color="var(--color-primary)" />
          <span>新建 Agent 会话</span>
        </div>
      }
      open={open}
      onCancel={onClose}
      onOk={handleOk}
      confirmLoading={loading}
      okText="开始对话"
      cancelText="取消"
      width={460}
      centered
      transitionName="animation-move-down">
      <Form form={form} layout="vertical" style={{ marginTop: 16 }}>
        <Form.Item
          label="Agent ID"
          name="agentId"
          rules={[{ required: true, message: '请输入 Agent ID（如 meta）' }]}
          extra="OpenClaw Agent 的唯一标识符，例如：meta、prism-assistant">
          <Input placeholder="meta" autoFocus />
        </Form.Item>
        <Form.Item
          label="初始提示词（可选）"
          name="prompt"
          extra="将作为第一条用户消息发送，用于初始化 Agent 上下文">
          <Input.TextArea rows={3} placeholder="你好，我想聊聊..." />
        </Form.Item>
      </Form>
    </Modal>
  )
}

// ── Main page ─────────────────────────────────────────────────────────────────

const PrismMultiAgentPage: FC = () => {
  const navigate = useNavigate()
  const bridgeStatus = useAppSelector((state) => state.openclaw?.gatewayStatus)

  const [sessions, setSessions] = useState<AgentSession[]>([])
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null)
  const [inputText, setInputText] = useState('')
  const [sendLoading, setSendLoading] = useState(false)
  const [newSessionOpen, setNewSessionOpen] = useState(false)

  // Streaming state per session: accumulate deltas in a local ref (no re-render per char)
  const streamingTextRef = useRef<Record<string, string>>({})
  const [streamingVersion, setStreamingVersion] = useState(0) // bump to trigger re-render

  const messagesEndRef = useRef<HTMLDivElement>(null)

  // ── Load sessions from service ──────────────────────────────────────────────

  const refreshSessions = useCallback(() => {
    setSessions(listSessions())
  }, [])

  useEffect(() => {
    refreshSessions()
  }, [refreshSessions])

  // ── Subscribe to multi-agent events ────────────────────────────────────────

  useEffect(() => {
    const offDelta = multiAgentEmitter.on('delta', ({ sessionId, text }) => {
      streamingTextRef.current[sessionId] = (streamingTextRef.current[sessionId] ?? '') + text
      setStreamingVersion((v) => v + 1)
    })

    const offDone = multiAgentEmitter.on('done', ({ sessionId }) => {
      streamingTextRef.current[sessionId] = ''
      refreshSessions()
      setStreamingVersion((v) => v + 1)
    })

    const offSessionCreated = multiAgentEmitter.on('session_created', () => {
      refreshSessions()
    })

    const offSessionUpdated = multiAgentEmitter.on('session_updated', () => {
      refreshSessions()
    })

    const offError = multiAgentEmitter.on('error', () => {
      refreshSessions()
    })

    return () => {
      offDelta()
      offDone()
      offSessionCreated()
      offSessionUpdated()
      offError()
    }
  }, [refreshSessions])

  // ── Auto-scroll to bottom ───────────────────────────────────────────────────

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [sessions, streamingVersion, activeSessionId])

  // ── Handlers ───────────────────────────────────────────────────────────────

  const handleSessionCreated = (sessionId: string) => {
    setActiveSessionId(sessionId)
    setNewSessionOpen(false)
    refreshSessions()
  }

  const handleSend = async () => {
    const text = inputText.trim()
    if (!text || !activeSessionId || sendLoading) return

    setInputText('')
    setSendLoading(true)
    try {
      await sendMessage(activeSessionId, text)
    } catch (err) {
      window.toast?.error(`发送失败：${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setSendLoading(false)
    }
  }

  const handleDeleteSession = (sessionId: string) => {
    forgetSession(sessionId)
    if (activeSessionId === sessionId) {
      const remaining = listSessions()
      setActiveSessionId(remaining.length > 0 ? remaining[0].sessionId : null)
    }
    refreshSessions()
  }

  const handleClearAll = () => {
    Modal.confirm({
      title: '清除所有会话',
      content: '确认清除所有本地会话记录？此操作不影响 OpenClaw 服务端的数据。',
      okText: '清除',
      okButtonProps: { danger: true },
      cancelText: '取消',
      centered: true,
      onOk: () => {
        clearAllSessions()
        setActiveSessionId(null)
        refreshSessions()
      }
    })
  }

  const activeSession = activeSessionId ? getSession(activeSessionId) : null
  const streamingText = activeSessionId ? (streamingTextRef.current[activeSessionId] ?? '') : ''
  const isBridgeConnected = bridgeStatus === 'running'

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <PageContainer>
      <Navbar>
        <NavbarCenter style={{ borderRight: 'none', gap: 8 }}>
          <BotMessageSquare size={16} />
          <span>Agent 会话</span>
          <Tooltip title={isBridgeConnected ? 'OpenClaw 网关运行中' : 'OpenClaw 网关未运行'}>
            <span style={{ display: 'flex', alignItems: 'center' }}>
              {isBridgeConnected ? (
                <Zap size={13} color="var(--color-success, #52c41a)" />
              ) : (
                <ZapOff size={13} color="var(--color-error)" />
              )}
            </span>
          </Tooltip>
        </NavbarCenter>
      </Navbar>

      {!isBridgeConnected && (
        <div
          style={{
            padding: '10px 16px',
            background: 'var(--color-error-bg, #fff2f0)',
            borderBottom: '1px solid var(--color-error-border, #ffccc7)',
            fontSize: 13,
            color: 'var(--color-error)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between'
          }}>
          <span>⚠️ OpenClaw 网关未运行 — Agent 会话功能不可用</span>
          <Button size="small" type="link" onClick={() => navigate('/openclaw')} style={{ padding: 0 }}>
            去启动网关 →
          </Button>
        </div>
      )}

      <Body>
        {/* ── Session List ── */}
        <SessionList>
          <SessionListHeader>
            <span>会话列表</span>
            <div style={{ display: 'flex', gap: 4 }}>
              {sessions.length > 0 && (
                <Tooltip title="清除所有会话">
                  <Button
                    type="text"
                    size="small"
                    icon={<Trash2 size={12} />}
                    onClick={handleClearAll}
                    style={{ padding: '0 4px', height: 20 }}
                  />
                </Tooltip>
              )}
              <Tooltip title="新建会话">
                <Button
                  type="text"
                  size="small"
                  icon={<MessageSquarePlus size={13} />}
                  onClick={() => setNewSessionOpen(true)}
                  disabled={!isBridgeConnected}
                  style={{ padding: '0 4px', height: 20 }}
                />
              </Tooltip>
            </div>
          </SessionListHeader>

          <SessionItems>
            {sessions.length === 0 ? (
              <div style={{ padding: '20px 12px', textAlign: 'center', fontSize: 12, color: 'var(--color-text-3)' }}>
                暂无会话
              </div>
            ) : (
              sessions.map((s) => (
                <SessionItem
                  key={s.sessionId}
                  $active={s.sessionId === activeSessionId}
                  onClick={() => setActiveSessionId(s.sessionId)}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                    <SessionItemAgent>🤖 {s.agentId}</SessionItemAgent>
                    <Tooltip title="移除会话">
                      <Button
                        type="text"
                        size="small"
                        icon={<Trash2 size={11} />}
                        onClick={(e) => { e.stopPropagation(); handleDeleteSession(s.sessionId) }}
                        style={{ padding: '0 2px', height: 18, opacity: 0.5 }}
                      />
                    </Tooltip>
                  </div>
                  <SessionItemMeta>
                    <StatusDot $status={s.status} />
                    <span>{s.sessionId.slice(0, 8)}</span>
                    <span>{dayjs(s.createdAt).fromNow()}</span>
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
              onClick={() => setNewSessionOpen(true)}
              disabled={!isBridgeConnected}>
              新建会话
            </Button>
          </div>
        </SessionList>

        {/* ── Chat Area ── */}
        <ChatArea>
          {!activeSession ? (
            <NoSessionPane>
              <BotMessageSquare size={48} strokeWidth={1} />
              <div style={{ fontSize: 14 }}>选择或新建一个 Agent 会话</div>
              <Button
                type="primary"
                icon={<MessageSquarePlus size={14} />}
                onClick={() => setNewSessionOpen(true)}
                disabled={!isBridgeConnected}>
                新建会话
              </Button>
            </NoSessionPane>
          ) : (
            <>
              {/* Messages */}
              <MessagesContainer>
                {activeSession.messages.length === 0 && streamingText === '' ? (
                  <Empty description={`与 ${activeSession.agentId} 的对话还没有开始`} style={{ marginTop: 40 }} />
                ) : (
                  <>
                    {activeSession.messages.map((msg, i) => (
                      <MessageBubble key={i} $role={msg.role}>
                        <BubbleContent $role={msg.role}>{msg.content}</BubbleContent>
                        <BubbleTime>{dayjs(msg.ts).format('HH:mm:ss')}</BubbleTime>
                      </MessageBubble>
                    ))}
                    {/* Streaming in-progress */}
                    {streamingText && (
                      <MessageBubble $role="assistant">
                        <BubbleContent $role="assistant">
                          {streamingText}
                          <StreamingIndicator />
                        </BubbleContent>
                      </MessageBubble>
                    )}
                    {/* Sending indicator (no text yet) */}
                    {activeSession.status === 'sending' && !streamingText && (
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

              {/* Input */}
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
                  placeholder={`发送消息给 ${activeSession.agentId}… (Enter 发送，Shift+Enter 换行)`}
                  autoSize={{ minRows: 1, maxRows: 6 }}
                  disabled={sendLoading || !isBridgeConnected}
                  style={{ flex: 1, resize: 'none' }}
                />
                <Tooltip title="重新加载历史">
                  <Button
                    icon={<RotateCcw size={14} />}
                    onClick={async () => {
                      try {
                        // Load history from OpenClaw (may not be supported by all agents)
                      } catch (_e) {
                        // Silently ignore — not all agents support history
                      }
                    }}
                    disabled={sendLoading}
                  />
                </Tooltip>
                <Button
                  type="primary"
                  onClick={() => void handleSend()}
                  loading={sendLoading}
                  disabled={!inputText.trim() || !isBridgeConnected}>
                  发送
                </Button>
              </InputArea>
            </>
          )}
        </ChatArea>
      </Body>

      {/* New Session Modal */}
      <NewSessionModal
        open={newSessionOpen}
        onClose={() => setNewSessionOpen(false)}
        onCreated={handleSessionCreated}
      />
    </PageContainer>
  )
}

export default PrismMultiAgentPage
