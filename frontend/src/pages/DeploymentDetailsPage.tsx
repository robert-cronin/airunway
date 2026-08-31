import { useParams, useSearchParams, useNavigate } from 'react-router-dom'
import { useDeployment, useDeleteDeployment } from '@/hooks/useDeployments'
import { useModel } from '@/hooks/useModels'
import { useToast } from '@/hooks/useToast'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { DeploymentStatusBadge } from '@/components/deployments/DeploymentStatusBadge'
import { MetricsTab } from '@/components/metrics'
import { formatRelativeTime } from '@/lib/utils'
import { getEngineDisplayName, getProviderDisplayName } from '@/lib/deploymentDisplay'
import { Loader2, ArrowLeft, Trash2, Copy, Terminal, Globe, HardDrive, ExternalLink, Info } from 'lucide-react'
import { useState } from 'react'
import { buildPortForwardCommand } from '@airunway/shared'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { useAutoscalerDetection, usePendingReasons } from '@/hooks/useAutoscaler'
import { PendingExplanation } from '@/components/deployments/PendingExplanation'
import { DeploymentLogs } from '@/components/deployments/DeploymentLogs'
import { ManifestViewer } from '@/components/deployments/ManifestViewer'
import { ChatPanel } from '@/components/chat/ChatPanel'

const HF_REPO_SEGMENT_PATTERN = /^[A-Za-z0-9._-]+$/

function getHuggingFaceModelUrl(modelId: string): string | undefined {
  const segments = modelId.split('/')
  if (
    segments.length < 1 ||
    segments.length > 2 ||
    segments.some((segment) =>
      !segment ||
      segment.length > 96 ||
      segment === '.' ||
      segment === '..' ||
      !HF_REPO_SEGMENT_PATTERN.test(segment)
    )
  ) {
    return undefined
  }

  return `https://huggingface.co/${segments.map(encodeURIComponent).join('/')}`
}

function formatModelPurpose(task: string, conversational?: boolean): string {
  if (conversational) return 'Chat'
  if (task === 'image-text-to-text') return 'Text and images'
  if (task === 'text-generation') return 'Text generation'
  return task.replace(/-/g, ' ')
}

function InfoHint({ text }: { text: string }) {
  return (
    <span className="relative group/hint inline-flex">
      <button
        type="button"
        tabIndex={0}
        aria-label={text}
        title={text}
        className="inline-flex items-center justify-center text-muted-foreground hover:text-foreground transition-colors"
      >
        <Info className="h-3.5 w-3.5" />
      </button>
      <span
        role="tooltip"
        className="pointer-events-none absolute bottom-full left-1/2 -translate-x-1/2 mb-2 w-max max-w-xs rounded-lg border border-white/10 bg-[#0F1419]/95 backdrop-blur-md px-3 py-1.5 text-sm text-popover-foreground shadow-md opacity-0 transition-opacity group-hover/hint:opacity-100 group-focus-within/hint:opacity-100 z-50"
      >
        {text}
      </span>
    </span>
  )
}

export function DeploymentDetailsPage() {
  const { name } = useParams<{ name: string }>()
  const [searchParams] = useSearchParams()
  const namespace = searchParams.get('namespace') || undefined
  const navigate = useNavigate()
  const { toast } = useToast()
  const deleteDeployment = useDeleteDeployment()
  const [showDeleteDialog, setShowDeleteDialog] = useState(false)

  const { data: deployment, isLoading, error } = useDeployment(name, namespace)
  const { data: model, isLoading: isModelLoading } = useModel(deployment?.modelId)

  // Autoscaler detection and pending reasons (only fetch when deployment is Pending)
  const { data: autoscaler } = useAutoscalerDetection()
  const { data: pendingReasons, isLoading: isPendingReasonsLoading } = usePendingReasons(
    deployment?.name || '',
    deployment?.namespace || '',
    deployment?.phase === 'Pending'
  )

  const handleDelete = async () => {
    if (!deployment) return

    try {
      await deleteDeployment.mutateAsync({
        name: deployment.name,
        namespace: deployment.namespace,
      })
      toast({
        title: 'Deployment Deleted',
        description: `${deployment.name} has been deleted`,
        variant: 'success',
      })
      navigate('/deployments')
    } catch (error) {
      toast({
        title: 'Delete Failed',
        description: error instanceof Error ? error.message : 'Failed to delete deployment',
        variant: 'destructive',
      })
    }
  }

  const copyPortForwardCommand = () => {
    if (!deployment) return
    const command = buildPortForwardCommand(deployment)
    navigator.clipboard.writeText(command)
    toast({
      title: 'Copied to clipboard',
      description: 'Port-forward command copied',
    })
  }

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    )
  }

  if (error || !deployment) {
    return (
      <div className="flex flex-col items-center justify-center py-12 text-center">
        <p className="text-lg font-medium text-destructive">
          Deployment not found
        </p>
        <p className="text-sm text-muted-foreground mt-1 mb-4">
          The requested deployment could not be found
        </p>
        <Button onClick={() => navigate('/deployments')}>
          Back to Deployments
        </Button>
      </div>
    )
  }

  const portForwardCommand = buildPortForwardCommand(deployment)
  const huggingFaceModelUrl = getHuggingFaceModelUrl(deployment.modelId)

  // Gateway endpoint (when available)
  const hasGateway = !!deployment.gateway?.endpoint
  const gatewayEndpoint = deployment.gateway?.endpoint
  const gatewayModelName = deployment.gateway?.modelName || deployment.modelId
  const gatewayBaseUrl = gatewayEndpoint
    ? (() => {
        // Parse endpoint to determine URL — omit port 80
        const host = gatewayEndpoint
        const url = host.includes('://') ? host : `http://${host}`
        try {
          const parsed = new URL(url)
          if (parsed.port === '80' || (!parsed.port && parsed.protocol === 'http:')) {
            return `${parsed.protocol}//${parsed.hostname}/v1`
          }
          return `${parsed.protocol}//${parsed.host}/v1`
        } catch {
          return `http://${host}/v1`
        }
      })()
    : undefined
  const showChatPanel = deployment.phase === 'Running' && !!deployment.frontendService

  return (
    <div className="space-y-6 max-w-4xl mx-auto animate-slide-up">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <Button variant="ghost" size="icon" onClick={() => navigate('/deployments')}>
            <ArrowLeft className="h-5 w-5" />
          </Button>
          <div>
            <h1 className="text-3xl font-heading">{deployment.name}</h1>
            <p className="text-muted-foreground">
              Created {formatRelativeTime(deployment.createdAt)}
            </p>
          </div>
        </div>

        <Button variant="destructive" onClick={() => setShowDeleteDialog(true)}>
          <Trash2 className="mr-2 h-4 w-4" />
          Delete
        </Button>
      </div>

      {/* Status Overview */}
      <div className="glass-panel animate-slide-up" style={{ animationDelay: '50ms', animationFillMode: 'both' }}>
        <h2 className="text-lg font-heading mb-4">Status</h2>
        <div className="grid gap-4 sm:grid-cols-5">
          <div>
            <p className="text-label text-slate-500 mb-1">Phase</p>
            <DeploymentStatusBadge phase={deployment.phase} />
          </div>
          <div>
            <p className="text-label text-slate-500 mb-1">Deployment method</p>
            <Badge
              variant="secondary"
            >
              {getProviderDisplayName(deployment.provider)}
            </Badge>
          </div>
          <div>
            <p className="text-label text-slate-500 mb-1">Replicas</p>
            <p className="font-medium">
              {deployment.replicas.ready}/{deployment.replicas.desired} Ready
            </p>
          </div>
          <div>
            <p className="text-label text-slate-500 mb-1">Model server</p>
            <Badge variant="outline">{getEngineDisplayName(deployment.engine)}</Badge>
          </div>
          <div>
            <p className="text-label text-slate-500 mb-1">Mode</p>
            <p className="font-medium capitalize">{deployment.mode}</p>
          </div>
        </div>
      </div>

      {/* Model Info */}
      <div className="glass-panel animate-slide-up" style={{ animationDelay: '100ms', animationFillMode: 'both' }}>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="text-lg font-heading">Model</h2>
            {model ? (
              <>
                <p className="font-medium mt-1">{model.name}</p>
                <p className="text-sm text-muted-foreground font-mono-code break-all">{deployment.modelId}</p>
              </>
            ) : (
              <p className="text-sm text-muted-foreground mt-1 font-mono-code break-all">{deployment.modelId}</p>
            )}
          </div>
          {!isModelLoading && !model && huggingFaceModelUrl && (
            <Button asChild variant="outline" size="sm">
              <a href={huggingFaceModelUrl} target="_blank" rel="noreferrer">
                View on Hugging Face
                <ExternalLink className="h-3.5 w-3.5" />
              </a>
            </Button>
          )}
        </div>

        {model ? (
          <div className="mt-4 space-y-4">
            <p className="text-sm text-muted-foreground">{model.description}</p>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              {model.contextLength && (
                <div>
                  <div className="flex items-center gap-1.5">
                    <p className="text-label text-slate-500">Context window</p>
                    <InfoHint text="The most text the model can consider at once. A token is roughly part of a word." />
                  </div>
                  <p className="font-medium">{model.contextLength.toLocaleString()} tokens</p>
                </div>
              )}
              <div>
                <p className="text-label text-slate-500">Model size</p>
                <p className="font-medium">{model.size}</p>
              </div>
              <div>
                <p className="text-label text-slate-500">Designed for</p>
                <p className="font-medium">{formatModelPurpose(model.task, model.conversational)}</p>
              </div>
              {model.minGpuMemory && (
                <div>
                  <div className="flex items-center gap-1.5">
                    <p className="text-label text-slate-500">Minimum memory</p>
                    <InfoHint text="An approximate amount of graphics memory needed to run this model." />
                  </div>
                  <p className="font-medium">{model.minGpuMemory}</p>
                </div>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm text-muted-foreground">Compatible model servers</span>
              {model.supportedEngines.map((engine) => (
                <Badge key={engine} variant="secondary" className="text-xs">
                  {getEngineDisplayName(engine)}
                </Badge>
              ))}
            </div>
          </div>
        ) : !isModelLoading && huggingFaceModelUrl ? (
          <p className="text-sm text-muted-foreground mt-4">
            Open the Hugging Face model card for capabilities, limits, and usage guidance.
          </p>
        ) : null}
      </div>

      {/* Storage Volumes - shown when storage is configured */}
      {deployment.storage?.volumes && deployment.storage.volumes.length > 0 && (
        <div className="glass-panel animate-slide-up" style={{ animationDelay: '120ms', animationFillMode: 'both' }}>
          <div className="flex items-center gap-2 mb-3">
            <HardDrive className="h-5 w-5" />
            <h2 className="text-lg font-heading">Storage</h2>
            <Badge variant="outline" className="text-xs">
              {deployment.storage.volumes.length} volume{deployment.storage.volumes.length !== 1 ? 's' : ''}
            </Badge>
          </div>
          <div className="space-y-3">
            {deployment.storage.volumes.map((vol) => (
              <div
                key={vol.name}
                className="rounded-lg border border-white/5 bg-white/[0.02] p-3"
              >
                <div className="flex items-center gap-2 flex-wrap">
                  <code className="text-sm font-mono-code font-medium">{vol.name}</code>
                  {vol.purpose && vol.purpose !== 'custom' && (
                    <Badge variant="secondary" className="text-xs">
                      {vol.purpose === 'modelCache' ? 'Model Cache' : 'Compilation Cache'}
                    </Badge>
                  )}
                  {vol.readOnly && (
                    <Badge variant="outline" className="text-xs text-yellow-400 border-yellow-500/50">
                      Read Only
                    </Badge>
                  )}
                  {vol.accessMode && (
                    <Badge variant="outline" className="text-xs">
                      {vol.accessMode === 'ReadWriteOnce' ? 'Single node' :
                       vol.accessMode === 'ReadWriteMany' ? 'Multi-node' :
                       vol.accessMode === 'ReadOnlyMany' ? 'Multi-node read only' :
                       'Single pod'}
                    </Badge>
                  )}
                </div>
                <div className="mt-2 text-sm text-muted-foreground space-y-1">
                  {vol.mountPath && (
                    <p>Path: <code className="font-mono-code">{vol.mountPath}</code></p>
                  )}
                  {vol.size ? (
                    <p>
                      New disk &middot; {vol.size}
                      {vol.storageClassName && ` &middot; ${vol.storageClassName}`}
                    </p>
                  ) : vol.claimName ? (
                    <p>Existing disk &middot; <code className="font-mono-code">{vol.claimName}</code></p>
                  ) : null}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Pending Explanation - shown when deployment is Pending */}
      {deployment.phase === 'Pending' && (
        <PendingExplanation
          reasons={pendingReasons?.reasons || []}
          autoscaler={autoscaler}
          isLoading={isPendingReasonsLoading}
        />
      )}

      {/* Access Model */}
      <div className="glass-panel animate-slide-up" style={{ animationDelay: '150ms', animationFillMode: 'both' }}>
        <div className="flex items-center gap-2 mb-1">
          <Terminal className="h-5 w-5" />
          <h2 className="text-lg font-heading">Access Model</h2>
        </div>
        <p className="text-sm text-muted-foreground mb-4">
          {hasGateway ? 'Access the deployed model through the gateway endpoint' : 'Run this command to access the deployed model locally'}
        </p>
        <div className="space-y-4">
          {hasGateway && gatewayBaseUrl ? (
            <>
              {/* Gateway Endpoint - Primary */}
              <div className="space-y-2">
                <div className="flex items-center gap-2 text-sm font-medium">
                  <Globe className="h-4 w-4 text-green-500" />
                  Gateway Endpoint
                </div>
                <div className="flex items-center gap-2">
                  <code className="flex-1 rounded-xl bg-[#0A0A0A] p-3 text-sm font-mono-code overflow-x-auto">
                    {gatewayBaseUrl}
                  </code>
                  <Button variant="outline" size="icon" onClick={() => {
                    navigator.clipboard.writeText(gatewayBaseUrl)
                    toast({ title: 'Copied to clipboard', description: 'Gateway URL copied' })
                  }}>
                    <Copy className="h-4 w-4" />
                  </Button>
                </div>
              </div>

              {/* Curl Example */}
              <div className="space-y-2">
                <span className="text-sm font-medium">Example Request</span>
                <div className="flex items-center gap-2">
                  <code className="flex-1 rounded-xl bg-[#0A0A0A] p-3 text-xs font-mono-code overflow-x-auto whitespace-pre-wrap">
                    {`curl ${gatewayBaseUrl}/chat/completions \\\n  -H "Content-Type: application/json" \\\n  -d '{"model": "${gatewayModelName}", "messages": [{"role": "user", "content": "Hello"}]}'`}
                  </code>
                  <Button variant="outline" size="icon" onClick={() => {
                    navigator.clipboard.writeText(`curl ${gatewayBaseUrl}/chat/completions -H "Content-Type: application/json" -d '{"model": "${gatewayModelName}", "messages": [{"role": "user", "content": "Hello"}]}'`)
                    toast({ title: 'Copied to clipboard', description: 'Curl command copied' })
                  }}>
                    <Copy className="h-4 w-4" />
                  </Button>
                </div>
              </div>
              {/* Port Forward - Secondary */}
              <details className="pt-2 border-t">
                <summary className="text-sm font-medium cursor-pointer text-muted-foreground hover:text-foreground">
                  Alternative: Port Forward
                </summary>
                <div className="mt-2 space-y-2">
                  <div className="flex items-center gap-2">
                    <code className="flex-1 rounded-xl bg-[#0A0A0A] p-3 text-sm font-mono-code overflow-x-auto">
                      {portForwardCommand}
                    </code>
                    <Button variant="outline" size="icon" onClick={copyPortForwardCommand}>
                      <Copy className="h-4 w-4" />
                    </Button>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    After running the command, access the model at http://localhost:8000
                  </p>
                </div>
              </details>
            </>
          ) : (
            <>
              <div className="flex items-center gap-2">
                <code className="flex-1 rounded-xl bg-[#0A0A0A] p-3 text-sm font-mono-code overflow-x-auto">
                  {portForwardCommand}
                </code>
                <Button variant="outline" size="icon" onClick={copyPortForwardCommand}>
                  <Copy className="h-4 w-4" />
                </Button>
              </div>
              <p className="text-xs text-muted-foreground mt-2">
                After running the command, access the model at http://localhost:8000
              </p>
            </>
          )}
        </div>
      </div>

      {/* Chat */}
      {showChatPanel && (
        <ChatPanel
          deploymentName={deployment.name}
          namespace={deployment.namespace}
          className="animate-slide-up"
          style={{ animationDelay: '175ms', animationFillMode: 'both' }}
        />
      )}

      {/* Metrics */}
      <div className="animate-slide-up" style={{ animationDelay: '200ms', animationFillMode: 'both' }}>
        <MetricsTab
          deploymentName={deployment.name}
          namespace={deployment.namespace}
          provider={deployment.provider}
        />
      </div>

      {/* Manifest */}
      <div className="animate-slide-up" style={{ animationDelay: '250ms', animationFillMode: 'both' }}>
        <ManifestViewer
          mode="deployed"
          deploymentName={deployment.name}
          namespace={deployment.namespace}
          provider={deployment.provider}
        />
      </div>

      {/* Logs */}
      <div className="animate-slide-up" style={{ animationDelay: '300ms', animationFillMode: 'both' }}>
        <DeploymentLogs
          deploymentName={deployment.name}
          namespace={deployment.namespace}
        />
      </div>

      {/* Delete Confirmation Dialog */}
      <Dialog open={showDeleteDialog} onOpenChange={setShowDeleteDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete Deployment</DialogTitle>
            <DialogDescription>
              Are you sure you want to delete <strong>{deployment.name}</strong>?
              This action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowDeleteDialog(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={handleDelete}
              disabled={deleteDeployment.isPending}
            >
              {deleteDeployment.isPending ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Deleting...
                </>
              ) : (
                'Delete'
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
