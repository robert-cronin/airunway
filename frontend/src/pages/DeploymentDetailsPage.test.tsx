import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DeploymentDetailsPage } from './DeploymentDetailsPage'
import type { DeploymentStatus } from '@/lib/api'

const deploymentMock = vi.hoisted(() => ({
  current: undefined as DeploymentStatus | undefined,
  isLoading: false,
  error: null as Error | null,
}))
const deleteMutationMock = vi.hoisted(() => vi.fn())
const chatMock = vi.hoisted(() => vi.fn())
const toastMock = vi.hoisted(() => vi.fn())

vi.mock('@/hooks/useDeployments', () => ({
  useDeployment: () => ({
    data: deploymentMock.current,
    isLoading: deploymentMock.isLoading,
    error: deploymentMock.error,
  }),
  useDeleteDeployment: () => ({
    mutateAsync: deleteMutationMock,
  }),
}))

vi.mock('@/hooks/useAutoscaler', () => ({
  useAutoscalerDetection: () => ({ data: undefined }),
  usePendingReasons: () => ({ data: { reasons: [] }, isLoading: false }),
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
    modelSource: 'huggingface',
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

function renderDetailsPage() {
  return render(
    <MemoryRouter initialEntries={[`/deployments/${deploymentMock.current?.name ?? 'missing'}?namespace=airunway-system`]}>
      <Routes>
        <Route path="/deployments/:name" element={<DeploymentDetailsPage />} />
        <Route path="/deployments" element={<h1>Deployment list</h1>} />
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

beforeEach(() => {
  deploymentMock.current = createDeployment()
  deploymentMock.isLoading = false
  deploymentMock.error = null
  chatMock.mockReset()
  deleteMutationMock.mockReset()
  toastMock.mockReset()
})

describe('DeploymentDetailsPage model details', () => {
  it('provides a descriptive, keyboard-accessible link to the Hugging Face model card', async () => {
    const user = userEvent.setup()
    renderDetailsPage()

    expect(screen.getByText('Qwen/Qwen3-0.6B')).toBeInTheDocument()
    const link = screen.getByRole('link', {
      name: 'View model on Hugging Face (opens in a new tab)',
    })
    expect(link).toHaveAttribute('href', 'https://huggingface.co/Qwen/Qwen3-0.6B')
    expect(link).toHaveAttribute('target', '_blank')
    expect(link).toHaveAttribute('rel', 'noopener noreferrer')

    await user.tab() // Back to deployments
    await user.tab() // Delete
    await user.tab() // Model card
    expect(link).toHaveFocus()
  })

  it.each([
    { modelId: 'Qwen/Qwen3-0.6B', modelSource: 'custom' as const },
    { modelId: 'my-team/custom-model', modelSource: 'custom' as const },
    { modelId: '/models/local-model', modelSource: 'custom' as const },
    { modelId: 'ollama://qwen3:0.6b', modelSource: 'custom' as const },
    { modelId: 'Qwen/Qwen3-0.6B', modelSource: undefined },
  ])('keeps $modelId from source $modelSource visible without a guessed link', overrides => {
    deploymentMock.current = createDeployment(overrides)
    renderDetailsPage()

    expect(screen.getByRole('heading', { name: 'Model' })).toBeInTheDocument()
    expect(screen.getByText(overrides.modelId)).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: /Hugging Face/ })).not.toBeInTheDocument()
  })

  it.each([
    'https://example.com/model',
    'org/model?revision=main',
    'org/../model',
  ])('keeps malformed Hugging Face identifier %s as plain text', modelId => {
    deploymentMock.current = createDeployment({ modelId })
    renderDetailsPage()

    expect(screen.getByText(modelId)).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: /Hugging Face/ })).not.toBeInTheDocument()
  })

  it('does not show stale model details while the deployment is loading', () => {
    deploymentMock.isLoading = true
    renderDetailsPage()

    expect(screen.queryByRole('heading', { name: 'Model' })).not.toBeInTheDocument()
    expect(screen.queryByRole('link', { name: /Hugging Face/ })).not.toBeInTheDocument()
    expect(screen.queryByText('Deployment not found')).not.toBeInTheDocument()
  })

  it.each(['missing', 'failed'] as const)('preserves back navigation for %s deployment details', async state => {
    if (state === 'missing') {
      deploymentMock.current = undefined
    } else {
      deploymentMock.error = new Error('Unable to load deployment')
    }
    renderDetailsPage()

    expect(screen.getByText('Deployment not found')).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: /Hugging Face/ })).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Back to Deployments' }))
    expect(screen.getByRole('heading', { name: 'Deployment list' })).toBeInTheDocument()
  })
})

describe('DeploymentDetailsPage chat panel', () => {
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
