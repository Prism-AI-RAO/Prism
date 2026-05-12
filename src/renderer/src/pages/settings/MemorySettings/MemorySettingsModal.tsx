import { loggerService } from '@logger'
import InputEmbeddingDimension from '@renderer/components/InputEmbeddingDimension'
import ModelSelector from '@renderer/components/ModelSelector'
import { InfoTooltip } from '@renderer/components/TooltipIcons'
import { isEmbeddingModel, isRerankModel } from '@renderer/config/models'
import { useModel } from '@renderer/hooks/useModel'
import { useAllProviders, useProviders } from '@renderer/hooks/useProvider'
import { getModelUniqId } from '@renderer/services/ModelService'
import { selectMemoryConfig, updateMemoryConfig } from '@renderer/store/memory'
import type { Model } from '@renderer/types'
import { Flex, Form, Modal } from 'antd'
import { t } from 'i18next'
import type { FC } from 'react'
import { useCallback, useEffect, useState } from 'react'
import { useDispatch, useSelector } from 'react-redux'

const logger = loggerService.withContext('MemorySettingsModal')

interface MemorySettingsModalProps {
  visible: boolean
  onSubmit: (values: any) => void
  onCancel: () => void
  form: any
}

type formValue = {
  llmModel: string
  embeddingModel: string
  embeddingDimensions: number
}

const MemorySettingsModal: FC<MemorySettingsModalProps> = ({ visible, onSubmit, onCancel, form }) => {
  const { providers } = useProviders()
  // [PRISM] 2026-05-12 — 嵌入模型选择器使用全量 provider，未启用的 provider 也能看到 embedding 模型
  const allProviders = useAllProviders()
  const dispatch = useDispatch()
  const memoryConfig = useSelector(selectMemoryConfig)
  const [loading, setLoading] = useState(false)

  // Get all models for lookup
  const llmModel = useModel(memoryConfig.llmModel?.id, memoryConfig.llmModel?.provider)
  const embeddingModel = useModel(memoryConfig.embeddingModel?.id, memoryConfig.embeddingModel?.provider)

  // Initialize form with current memory config when modal opens
  useEffect(() => {
    if (visible && memoryConfig) {
      form.setFieldsValue({
        llmModel: getModelUniqId(llmModel),
        embeddingModel: getModelUniqId(embeddingModel),
        embeddingDimensions: memoryConfig.embeddingDimensions
        // customFactExtractionPrompt: memoryConfig.customFactExtractionPrompt,
        // customUpdateMemoryPrompt: memoryConfig.customUpdateMemoryPrompt
      })
    }
  }, [embeddingModel, form, llmModel, memoryConfig, visible])

  const handleFormSubmit = async (values: formValue) => {
    try {
      // Convert model IDs back to Model objects
      // values.llmModel and values.embeddingModel are JSON strings from getModelUniqId()
      // e.g., '{"id":"gpt-4","provider":"openai"}'
      // We need to find models by comparing with getModelUniqId() result
      const enabledModels = providers.flatMap((p) => p.models)
      const llmModel = enabledModels.find((m) => getModelUniqId(m) === values.llmModel)
      // [PRISM] 2026-05-12 — 从全量 provider 中查找 embedding 模型，支持未启用的 provider
      const allModels = allProviders.flatMap((p) => p.models)
      const embeddingModel = allModels.find((m) => getModelUniqId(m) === values.embeddingModel)

      if (embeddingModel) {
        setLoading(true)
        // [PRISM] 2026-05-12 — 在全量 provider 中查找，未启用的 embedding provider 也能正常保存
        const provider = allProviders.find((p) => p.id === embeddingModel.provider)

        if (!provider) {
          return
        }

        const finalDimensions =
          typeof values.embeddingDimensions === 'string'
            ? parseInt(values.embeddingDimensions)
            : values.embeddingDimensions

        const updatedConfig = {
          ...memoryConfig,
          llmModel,
          embeddingModel,
          embeddingDimensions: finalDimensions
          // customFactExtractionPrompt: values.customFactExtractionPrompt,
          // customUpdateMemoryPrompt: values.customUpdateMemoryPrompt
        }

        dispatch(updateMemoryConfig(updatedConfig))
        onSubmit(updatedConfig)
        setLoading(false)
      }
    } catch (error) {
      logger.error('Error submitting form:', error as Error)
      setLoading(false)
    }
  }

  const llmPredicate = useCallback((m: Model) => !isEmbeddingModel(m) && !isRerankModel(m), [])

  const embeddingPredicate = useCallback((m: Model) => isEmbeddingModel(m) && !isRerankModel(m), [])

  return (
    <Modal
      title={t('memory.settings_title')}
      open={visible}
      onOk={form.submit}
      onCancel={onCancel}
      width={600}
      centered
      transitionName="animation-move-down"
      confirmLoading={loading}
      styles={{
        header: {
          borderBottom: '0.5px solid var(--color-border)',
          paddingBottom: 16,
          borderBottomLeftRadius: 0,
          borderBottomRightRadius: 0
        },
        body: {
          paddingTop: 24
        }
      }}>
      <Form form={form} layout="vertical" onFinish={handleFormSubmit}>
        <Form.Item
          label={t('memory.llm_model')}
          name="llmModel"
          rules={[{ required: true, message: t('memory.please_select_llm_model') }]}>
          <ModelSelector
            providers={providers}
            predicate={llmPredicate}
            placeholder={t('memory.select_llm_model_placeholder')}
          />
        </Form.Item>
        <Form.Item
          label={t('memory.embedding_model')}
          name="embeddingModel"
          rules={[{ required: true, message: t('memory.please_select_embedding_model') }]}>
          {/* [PRISM] 2026-05-12 — 使用 allProviders，未启用的 provider 的 embedding 模型也可选 */}
          <ModelSelector
            providers={allProviders}
            predicate={embeddingPredicate}
            placeholder={t('memory.select_embedding_model_placeholder')}
          />
        </Form.Item>
        <Form.Item
          noStyle
          shouldUpdate={(prevValues, currentValues) => prevValues.embeddingModel !== currentValues.embeddingModel}>
          {({ getFieldValue }) => {
            const embeddingModelId = getFieldValue('embeddingModel')
            // embeddingModelId is a JSON string from getModelUniqId(), find model by comparing
            // [PRISM] 2026-05-12 — 从全量 provider 查找，与上方选择器保持一致
            const allModels = allProviders.flatMap((p) => p.models)
            const embeddingModel = allModels.find((m) => getModelUniqId(m) === embeddingModelId)
            return (
              <Form.Item
                label={
                  <Flex align="center" gap={4}>
                    {t('memory.embedding_dimensions')}
                    <InfoTooltip title={t('knowledge.dimensions_size_tooltip')} />
                  </Flex>
                }
                name="embeddingDimensions"
                rules={[
                  {
                    validator(_, value) {
                      if (value === undefined || value === null || value > 0) {
                        return Promise.resolve()
                      }
                      return Promise.reject(new Error(t('knowledge.dimensions_error_invalid')))
                    }
                  }
                ]}>
                <InputEmbeddingDimension model={embeddingModel} disabled={!embeddingModel} />
              </Form.Item>
            )
          }}
        </Form.Item>
        {/* <Form.Item label="Custom Fact Extraction Prompt" name="customFactExtractionPrompt">
          <Input.TextArea placeholder="Optional custom prompt for fact extraction..." rows={3} />
        </Form.Item>
        <Form.Item label="Custom Update Memory Prompt" name="customUpdateMemoryPrompt">
          <Input.TextArea placeholder="Optional custom prompt for memory updates..." rows={3} />
        </Form.Item> */}
      </Form>
    </Modal>
  )
}

export default MemorySettingsModal
