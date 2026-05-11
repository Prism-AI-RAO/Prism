// [PRISM] 2026-05-11 — Sprint 4: Dreaming bootstrap component
// 无 UI 渲染（返回 null）。
// 监听 prismDreamingEnabled 开关，自动启动/停止 PrismDreamingService。
// 挂载于 App.tsx 的 PersistGate 内（Redux 状态恢复后）。

import { loggerService } from '@renderer/services/LoggerService'
import { selectPrismDreamingEnabled } from '@renderer/store/memory'
import { useEffect } from 'react'
import { useSelector } from 'react-redux'

import { startDreaming, stopDreaming } from '../services/PrismDreamingService'

const logger = loggerService.withContext('PrismDreaming')

const PrismDreaming: React.FC = () => {
  const dreamingEnabled = useSelector(selectPrismDreamingEnabled)

  useEffect(() => {
    if (dreamingEnabled) {
      startDreaming()
      logger.info('[Dreaming] Enabled via settings — service started')
    } else {
      stopDreaming()
      logger.info('[Dreaming] Disabled via settings — service stopped')
    }

    // Cleanup: stop the service when the component unmounts
    return () => {
      stopDreaming()
    }
  }, [dreamingEnabled])

  return null
}

export default PrismDreaming
