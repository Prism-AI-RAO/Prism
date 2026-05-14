// [PRISM] 2026-05-14 — Modified to fall back to local provider models when API doesn't have the model
import type { ApiModel, ApiModelsFilter } from '@renderer/types'
import { useProviders } from '@renderer/hooks/useProvider'
import { useApiModels } from './useModels'

export type UseModelProps = {
  id?: string
  filter?: ApiModelsFilter
}

export const useApiModel = ({ id, filter }: UseModelProps): ApiModel | undefined => {
  const { models } = useApiModels(filter)
  const { providers } = useProviders()

  // First: look in API models (cloud providers via agents server)
  const apiModel = models.find((model) => model.id === id)
  if (apiModel) return apiModel

  // [PRISM] Fallback: look in local providers (LM Studio, Ollama, etc.)
  if (!id) return undefined
  for (const provider of providers) {
    const localModel = provider.models.find((m) => m.id === id)
    if (localModel) {
      return {
        id: localModel.id,
        object: 'model' as const,
        created: 0,
        name: localModel.name,
        owned_by: provider.name,
        provider: provider.id,
        provider_name: provider.name,
        provider_type: provider.type as ApiModel['provider_type'],
        provider_model_id: localModel.id
      }
    }
  }

  return undefined
}
