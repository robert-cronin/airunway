import { describe, expect, it } from 'vitest'
import { getHuggingFaceModelUrl } from './deploymentDisplay'

describe('getHuggingFaceModelUrl', () => {
  it.each([
    'Qwen/Qwen3-0.6B',
    'meta-llama/Llama-3.1-8B-Instruct',
    'TheBloke/Llama-2-7B-Chat-GGUF',
    'org/model_name.v2',
    'gpt2',
  ])('links the Hugging Face repository %s', modelId => {
    expect(getHuggingFaceModelUrl(modelId, 'huggingface')).toBe(`https://huggingface.co/${modelId}`)
  })

  it('does not infer a Hugging Face source from an owner/model identifier', () => {
    expect(getHuggingFaceModelUrl('Qwen/Qwen3-0.6B', 'custom')).toBeUndefined()
    expect(getHuggingFaceModelUrl('Qwen/Qwen3-0.6B')).toBeUndefined()
  })

  it.each([
    '',
    '/models/local-model',
    './local-model',
    '../local-model',
    'C:\\models\\model',
    'https://example.com/model',
    '//example.com/model',
    'javascript:alert(1)',
    'org/model?revision=main',
    'org/model#readme',
    'org/model/resolve/main',
    'org/../model',
    'org%2Fmodel',
    'org/model%0A',
    ' org/model',
    'org/model\n',
    'org/model name',
    'org/model--name',
    'org/model..name',
    'org/.model',
    'org/model-',
    'org/model.git',
    'org/',
    `org/${'a'.repeat(97)}`,
  ])('does not create a model-card link for the invalid identifier %j', modelId => {
    expect(getHuggingFaceModelUrl(modelId, 'huggingface')).toBeUndefined()
  })
})
