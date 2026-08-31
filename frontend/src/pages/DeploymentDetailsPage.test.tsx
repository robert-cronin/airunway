import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DeploymentDetailsPage } from './DeploymentDetailsPage'
import type { DeploymentStatus, Model } from '@/lib/api'

const deploymentMock = vi.hoisted(() => ({
  current: undefined as DeploymentStatus | undefined,
}))
const deleteMutationMock = vi.hoisted(() => vi.fn())
const chatMock = vi.hoisted(() => vi.fn())
const toastMock = vi.hoisted(() => vi.fn())
const modelMock = vi.hoisted(() => ({
  current: undefined as Model | null | undefined,
  isLoading: false,
}))

vi.mock('@/hooks/useDeployments', () => ({
  useDeployment: () => ({
    data: deploymentMock.current,
    isLoading: false,
    error: null,
  }),
  useDeleteDeployment: () => ({
    mutateAsync: deleteMutationMock,
  }),
}))

vi.mock('@/hooks/useAutoscaler', () => ({
  useAutoscalerDetection: () => ({ data: undefined }),
  usePendingReasons: () => ({ data: { reasons: [] }, isLoading: false }),
}))

vi.mock('@/hooks/useModels', () => ({
  useModel: () => ({ data: modelMock.current, isLoading: modelMock.isLoading }),
}))

vi.mock('@/hooks/useToast', () => ({
  useToast: () => ({ toast: toastMock }),
}))

vi.mock('@/components/metrics', () => ({
  MetricsTab: () => null,
}))

vi.mock('@/components/deployments/DeploymentLogs', () => ({
  DeploymentLogs: () => null,
}))

vi.mock('@/components/deployments/ManifestViewer', () => ({
  ManifestViewer: () => null,
}))

vi.mock('@/components/deployments/PendingExplanation', () => ({
  PendingExplanation: () => null,
}))

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>()
  return {
    ...actual,
    deploymentsApi: {
      ...actual.deploymentsApi,
      chat: chatMock,
    },
  }
})

function createDeployment(overrides: Partial<DeploymentStatus> = {}): DeploymentStatus {
  return {
    name: 'qwen3-0-6b-vllm-abc123',
    namespace: 'airunway-system',
    modelId: 'Qwen/Qwen3-0.6B',
    engine: 'vllm',
    mode: 'aggregated',
    phase: 'Running',
    provider: 'vllm',
    replicas: { desired: 1, ready: 1, available: 1 },
    pods: [],
    createdAt: '2025-01-15T10:30:00.000Z',
    frontendService: 'qwen3-0-6b-vllm-abc123-frontend:8000',
    gateway: { endpoint: '20.92.155.15', modelName: 'Qwen/Qwen3-0.6B' },
    ...overrides,
  }
}

function createModel(overrides: Partial<Model> = {}): Model {
  return {
    id: 'Qwen/Qwen3-0.6B',
    name: 'Qwen3 0.6B',
    description: 'Tiny model ideal for development, testing, and edge deployments',
    size: '0.6B',
    task: 'text-generation',
    conversational: true,
    contextLength: 32768,
    supportedEngines: ['vllm', 'sglang', 'trtllm'],
    minGpuMemory: '4GB',
    ...overrides,
  }
}

function renderDetailsPage() {
  return render(
    <MemoryRouter initialEntries={[`/deployments/${deploymentMock.current?.name ?? 'missing'}?namespace=airunway-system`]}>
      <Routes>
        <Route path="/deployments/:name" element={<DeploymentDetailsPage />} />
      </Routes>
    </MemoryRouter>
  )
}

function streamResponse(chunks: string[]): Response {
  const encoder = new TextEncoder()
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const chunk of chunks) {
          controller.enqueue(encoder.encode(chunk))
        }
        controller.close()
      },
    }),
    {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    }
  )
}

describe('DeploymentDetailsPage chat panel', () => {
  beforeEach(() => {
    deploymentMock.current = createDeployment()
    modelMock.current = createModel()
    modelMock.isLoading = false
    chatMock.mockReset()
    deleteMutationMock.mockReset()
    toastMock.mockReset()
  })

  it('shows chat only for running deployments with a frontend service', () => {
    const running = renderDetailsPage()
    expect(screen.getByRole('heading', { name: 'Chat with model' })).toBeInTheDocument()
    running.unmount()

    deploymentMock.current = createDeployment({ phase: 'Pending' })
    const pending = renderDetailsPage()
    expect(screen.queryByRole('heading', { name: 'Chat with model' })).not.toBeInTheDocument()
    pending.unmount()

    deploymentMock.current = createDeployment({ frontendService: undefined })
    renderDetailsPage()
    expect(screen.queryByRole('heading', { name: 'Chat with model' })).not.toBeInTheDocument()
  })

  it('renders the empty transcript as a hint instead of an input-like box', () => {
    renderDetailsPage()

    const transcript = screen.getByTestId('chat-transcript')

    expect(screen.getByText('Start a conversation with this model.')).toBeInTheDocument()
    expect(transcript).not.toHaveClass('border')
    expect(transcript.className).not.toContain('bg-black/20')
  })

  it('shows readable chat errors instead of raw API JSON', async () => {
    chatMock.mockResolvedValue(new Response(JSON.stringify({
      error: {
        message: "The model endpoint for 'qwen3-0-6b-vllm-abc123' is not available yet. Try again in a moment.",
        statusCode: 404,
        details: '{\"message\":\"services \\\"qwen3-0-6b-vllm-abc123-frontend\\\" not found\"}',
      },
    }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    }))

    renderDetailsPage()

    await userEvent.type(screen.getByLabelText('Message'), 'Hello')
    await userEvent.click(screen.getByRole('button', { name: /send/i }))

    expect(await screen.findByRole('alert')).toHaveTextContent(
      "The model endpoint for 'qwen3-0-6b-vllm-abc123' is not available yet. Try again in a moment."
    )
    expect(screen.queryByText(/\{"error"/)).not.toBeInTheDocument()
  })

  it('aborts in-flight chat and resets the transcript when deployment identity changes', async () => {
    let capturedSignal: AbortSignal | undefined
    chatMock.mockImplementation((_name, _body, _namespace, options?: { signal?: AbortSignal }) => {
      capturedSignal = options?.signal

      return new Promise<Response>((_resolve, reject) => {
        capturedSignal?.addEventListener('abort', () => {
          const abortError = new Error('Aborted')
          abortError.name = 'AbortError'
          reject(abortError)
        }, { once: true })
      })
    })

    const { rerender } = renderDetailsPage()

    await userEvent.type(screen.getByLabelText('Message'), 'Hello before reset')
    await userEvent.click(screen.getByRole('button', { name: /send/i }))

    await waitFor(() => {
      expect(chatMock).toHaveBeenCalledWith(
        'qwen3-0-6b-vllm-abc123',
        { messages: [{ role: 'user', content: 'Hello before reset' }] },
        'airunway-system',
        expect.objectContaining({ signal: expect.any(AbortSignal) })
      )
      expect(capturedSignal?.aborted).toBe(false)
    })
    expect(screen.getByText('Hello before reset')).toBeInTheDocument()

    deploymentMock.current = createDeployment({
      name: 'llama3-vllm-def456',
      namespace: 'tenant-two',
      modelId: 'meta-llama/Llama-3.1-8B-Instruct',
      frontendService: 'llama3-vllm-def456-frontend:8000',
      gateway: { endpoint: '20.92.155.16', modelName: 'meta-llama/Llama-3.1-8B-Instruct' },
    })
    rerender(
      <MemoryRouter initialEntries={[`/deployments/${deploymentMock.current.name}?namespace=tenant-two`]}>
        <Routes>
          <Route path="/deployments/:name" element={<DeploymentDetailsPage />} />
        </Routes>
      </MemoryRouter>
    )

    await waitFor(() => {
      expect(capturedSignal?.aborted).toBe(true)
      expect(screen.getByText('Start a conversation with this model.')).toBeInTheDocument()
    })
    expect(screen.queryByText('Hello before reset')).not.toBeInTheDocument()
    expect(screen.getByLabelText('Message')).toHaveValue('')
    expect(screen.getByLabelText('Message')).not.toBeDisabled()
  })

  it('sends the prompt, renders streamed assistant responses, and keeps the transcript scrolled', async () => {
    chatMock.mockResolvedValue(streamResponse([
      'data: {"choices":[{"delta":{"content":"Hello "}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"from model"}}]}\n\n',
      'data: [DONE]\n\n',
    ]))

    renderDetailsPage()
    const transcript = screen.getByTestId('chat-transcript')
    Object.defineProperty(transcript, 'scrollHeight', {
      configurable: true,
      value: 4321,
    })
    transcript.scrollTop = 0

    await userEvent.type(screen.getByLabelText('Message'), 'Hello')
    await userEvent.click(screen.getByRole('button', { name: /send/i }))

    await waitFor(() => {
      expect(chatMock).toHaveBeenCalledWith(
        'qwen3-0-6b-vllm-abc123',
        { messages: [{ role: 'user', content: 'Hello' }] },
        'airunway-system',
        expect.objectContaining({
          signal: expect.objectContaining({ aborted: false }),
        })
      )
    })
    expect(await screen.findByText('Hello from model')).toBeInTheDocument()
    await waitFor(() => {
      expect(transcript.scrollTop).toBe(4321)
    })
  })
})

describe('DeploymentDetailsPage model details', () => {
  beforeEach(() => {
    deploymentMock.current = createDeployment()
    modelMock.current = createModel()
    modelMock.isLoading = false
    chatMock.mockReset()
    deleteMutationMock.mockReset()
    toastMock.mockReset()
  })

  it('shows model details from the catalog', () => {
    renderDetailsPage()

    expect(screen.getByText('Qwen3 0.6B')).toBeInTheDocument()
    expect(screen.getByText('Tiny model ideal for development, testing, and edge deployments')).toBeInTheDocument()
    expect(screen.getByText('32,768 tokens')).toBeInTheDocument()
    expect(screen.getByText('0.6B')).toBeInTheDocument()
    expect(screen.getByText('Chat')).toBeInTheDocument()
    expect(screen.getByText('4GB')).toBeInTheDocument()
    expect(screen.getByText('TensorRT-LLM')).toBeInTheDocument()

    expect(screen.queryByRole('link', { name: /view on hugging face/i })).not.toBeInTheDocument()
  })

  it('offers the model card when the deployment model is not in the catalog', () => {
    deploymentMock.current = createDeployment({ modelId: 'acme/new-model' })
    modelMock.current = null

    renderDetailsPage()

    expect(screen.getByText('acme/new-model')).toBeInTheDocument()
    expect(screen.getByText('Open the Hugging Face model card for capabilities, limits, and usage guidance.')).toBeInTheDocument()
    const modelCardLink = screen.getByRole('link', { name: /view on hugging face/i })
    expect(modelCardLink).toHaveAttribute('href', 'https://huggingface.co/acme/new-model')
    expect(modelCardLink).toHaveAttribute('target', '_blank')
    expect(modelCardLink).toHaveAttribute('rel', 'noreferrer')
  })

  it('does not create a model-card link for an invalid model identifier', () => {
    deploymentMock.current = createDeployment({ modelId: '../private?redirect=1' })
    modelMock.current = null

    renderDetailsPage()

    expect(screen.getByText('../private?redirect=1')).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: /view on hugging face/i })).not.toBeInTheDocument()
  })
})
