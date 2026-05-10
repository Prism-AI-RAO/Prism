// [PRISM] 2026-05-10 — Sprint 1: Prism 本地 AI 自动检测组件
// 挂载后静默探测本地运行的 OpenAI 兼容服务，自动注册为 Provider。
// [PRISM] 2026-05-10 Fix: 支持 apiKey（OpenClaw gateway token）+ 更新 openclaw store
// [PRISM] 2026-05-10 Fix v2: 修复 existingProviders 在 deps 中导致 persist rehydrate 时
//   cleanup 取消 timer（effect 只跑一次，用 ref 读取最新 providers 替代 closure）
// [PRISM] 2026-05-10 Fix v4: 支持 providerType 字段（openai/anthropic），每个 endpoint 独立注册
// [PRISM] 2026-05-10 Fix v4.1: 启动时清理旧的 prism-openclaw-{port} 聚合 provider（不再使用）
// 无 UI 渲染（返回 null）。

import { loggerService } from '@renderer/services/LoggerService'
import { useAppDispatch, useAppSelector } from '@renderer/store'
import { addProvider, removeProvider } from '@renderer/store/llm'
import { setGatewayPort, setGatewayStatus } from '@renderer/store/openclaw'
import type { Model, Provider } from '@renderer/types'
import { message } from 'antd'
import { useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'

const logger = loggerService.withContext('PrismAutoSetup')

const PrismAutoSetup: React.FC = () => {
  const dispatch = useAppDispatch()
  const { t } = useTranslation()
  const existingProviders = useAppSelector((state) => state.llm.providers)

  // [PRISM] Fix: 用 ref 跟踪最新 providers，避免 effect 将 existingProviders 放入 deps
  // 若放入 deps，persist rehydrate 时 effect cleanup 会取消 1.5s timer，导致检测从不执行
  const existingProvidersRef = useRef<Provider[]>(existingProviders)
  existingProvidersRef.current = existingProviders  // 每次渲染同步最新值

  const hasRun = useRef(false)

  useEffect(() => {
    // 只在首次挂载执行一次，空 deps 确保 timer 不被 cleanup 取消
    if (hasRun.current) return
    hasRun.current = true

    const runDetection = async () => {
      try {
        logger.info('[PRISM] Running local AI auto-detection...')
        const detected = await window.api.prism.detectLocalAI()

        if (!detected || detected.length === 0) {
          logger.info('[PRISM] No local AI services detected.')
          return
        }

        // 读取最新 providers（通过 ref，避免 stale closure）
        const currentProviders = existingProvidersRef.current

        // [PRISM] Fix v4.1: 清理旧的聚合 provider（prism-openclaw-{port}，如 prism-openclaw-18789）
        // v4 改为逐 provider 直连，旧的端口聚合 provider 不再有效，必须移除以避免 404 错误
        const legacyProviders = currentProviders.filter(
          (p) => /^prism-openclaw-\d+$/.test(p.id)
        )
        for (const legacy of legacyProviders) {
          dispatch(removeProvider(legacy))
          logger.info(`[PRISM] Removed legacy port-based provider: ${legacy.id} (replaced by per-provider direct connections)`)
        }

        let newCount = 0

        for (const endpoint of detected) {
          // 若检测到 OpenClaw 来源的 provider，同步更新 openclaw store（仅第一个触发）
          if (endpoint.providerId.startsWith('prism-openclaw-')) {
            dispatch(setGatewayPort(endpoint.port))
            dispatch(setGatewayStatus('running'))
            logger.info(`[PRISM] OpenClaw detected at port ${endpoint.port}, openclaw store updated.`)
          }

          // 幂等：若 provider 已存在，跳过
          const alreadyExists = currentProviders.some((p) => p.id === endpoint.providerId)
          if (alreadyExists) {
            logger.info(`[PRISM] Provider "${endpoint.providerId}" already exists, skipping.`)
            continue
          }

          // [PRISM] Fix v4: 使用 endpoint.providerType 而非硬编码 'openai'
          // 每个 provider 直连其真实 API（google/deepseek → openai-compat, anthropic → anthropic）
          const providerType = endpoint.providerType ?? 'openai'

          // 构建 Provider 对象
          const models: Model[] = endpoint.models.map((m) => ({
            id: m.id,
            name: m.name,
            provider: endpoint.providerId,
            group: endpoint.name
          }))

          const provider: Provider = {
            id: endpoint.providerId,
            type: providerType,
            name: endpoint.name,
            apiKey: endpoint.apiKey ?? '',
            apiHost: endpoint.apiBase,
            models,
            enabled: true,
            isSystem: false
          }

          dispatch(addProvider(provider))
          newCount++
          logger.info(
            `[PRISM] Auto-registered: ${endpoint.name} [${providerType}] apiBase=${endpoint.apiBase} × ${models.length} models`
          )
        }

        // 有新 provider 时显示 toast 提示
        if (newCount > 0) {
          const totalModels = detected
            .filter((d) => !currentProviders.some((p) => p.id === d.providerId))
            .reduce((sum, d) => sum + d.models.length, 0)

          message.success(
            t('prism.autoDetect.success', {
              count: newCount,
              models: totalModels,
              defaultValue: `✅ 已自动检测到 ${newCount} 个本地 AI 服务，共 ${totalModels} 个模型已就绪`
            }),
            4
          )
        }
      } catch (err) {
        // 自动检测失败不影响正常使用，静默记录
        logger.warn('[PRISM] Auto-detection failed:', err as Error)
      }
    }

    // 延迟 1.5s 等 Redux persist 恢复完成后再执行
    // 注意：空 deps 确保此 effect 只挂载一次，timer 不会被 persist rehydrate 打断
    const timer = setTimeout(runDetection, 1500)
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []) // 空 deps — 只在挂载时跑一次，通过 ref 读取最新 providers

  return null
}

export default PrismAutoSetup
