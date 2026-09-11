import type { ModelSource } from '@airunway/shared'

export function getHuggingFaceModelUrl(modelId: string, source?: ModelSource): string | undefined {
  // A custom model can also have an owner/name identifier, so require its source.
  if (source !== 'huggingface') return undefined

  const segments = modelId.split('/')
  // Accept repository names (including legacy unnamespaced models), not URLs or paths.
  if (
    segments.length > 2 ||
    segments.some(segment => segment.trim() !== segment || !/^\w(?:[\w.-]{0,94}\w)?$/.test(segment)) ||
    modelId.includes('..') ||
    modelId.includes('--') ||
    modelId.endsWith('.git')
  ) {
    return undefined
  }

  return `https://huggingface.co/${segments.map(encodeURIComponent).join('/')}`
}

export function getProviderDisplayName(provider?: string): string {
  switch (provider) {
    case 'vllm':
      return 'Direct vLLM'
    case 'dynamo':
      return 'Dynamo'
    case 'kuberay':
      return 'KubeRay'
    case 'kaito':
      return 'KAITO'
    case 'llmd':
      return 'llm-d'
    default:
      return provider || 'Pending'
  }
}

export function getEngineDisplayName(engine?: string): string {
  switch (engine) {
    case 'vllm':
      return 'vLLM'
    case 'sglang':
      return 'SGLang'
    case 'trtllm':
      return 'TensorRT-LLM'
    case 'llamacpp':
      return 'llama.cpp'
    default:
      return engine || 'Pending'
  }
}
