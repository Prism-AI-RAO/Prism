// [PRISM] 2026-05-10 — Sprint 1: Prism 本地 AI 自动检测组件
// 挂载后静默探测本地运行的 OpenAI 兼容服务，自动注册为 Provider。
// [PRISM] 2026-05-10 Fix: 支持 apiKey（OpenClaw gateway token）+ 更新 openclaw store
// 无 UI 渲染（返回 null）。

import { loggerService } from '@renderer/services/LoggerService'
import { useAppDispatch, useAppSelector } from '@renderer/store'
import { addProvider } from '@renderer/store/llm'
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
  const hasRun = useRef(false)

  useEffect(() => {
    // 只在首次挂载执行一次
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

        let newCount = 0

        for (const endpoint of detected) {
          // 若检测到 OpenClaw，同步更新 openclaw store
          if (endpoint.providerId.startsWith('prism-openclaw-')) {
            dispatch(setGatewayPort(endpoint.port))
            dispatch(setGatewayStatus('running'))
            logger.info(`[PRISM] OpenClaw detected at port ${endpoint.port}, openclaw store updated.`)
          }

          // 幂等：若 provider 已存在，跳过
          const alreadyExists = existingProviders.some((p) => p.id === endpoint.providerId)
          if (alreadyExists) {
            logger.info(`[PRISM] Provider "${endpoint.providerId}" already exists, skipping.`)
            continue
          }

          // 构建 Provider 对象（OpenAI 兼容格式）
          const models: Model[] = endpoint.models.map((m) => ({
            id: m.id,
            name: m.name,
            provider: endpoint.providerId,
            group: endpoint.name
          }))

          const provider: Provider = {
            id: endpoint.providerId,
            type: 'openai',
            name: endpoint.name,
            // 使用 gateway token（若无则 fallback 到 'no-key-required'）
            apiKey: endpoint.apiKey ?? 'no-key-required',
            apiHost: endpoint.apiBase,
            models,
            enabled: true,
            isSystem: false
          }

          dispatch(addProvider(provider))
          newCount++
          logger.info(
            `[PRISM] Auto-registered provider: ${endpoint.name} (port ${endpoint.port}), ${models.length} models, token=${endpoint.apiKey ? '✓' : '×'}`
          )
        }

        // 有新 provider 时显示 toast 提示
        if (newCount > 0) {
          const totalModels = detected
            .filter((d) => !existingProviders.some((p) => p.id === d.providerId))
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
    const timer = setTimeout(runDetection, 1500)
    return () => clearTimeout(timer)
  }, [dispatch, existingProviders, t])

  return null
}

export default PrismAutoSetup
