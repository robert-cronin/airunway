# vLLM Semantic Router Integration

[vLLM Semantic Router](https://github.com/vllm-project/semantic-router) adds
request-level decisions in front of OpenAI-compatible model servers. AI Runway
continues to deploy, scale, and report the health of each model; Semantic Router
can classify prompts, select a model, enable model-specific reasoning, cache
similar responses, and apply safety policy before a request reaches that model.

This integration requires no AI Runway controller changes. Semantic Router runs
as a separate service and points at the Services or InferencePools created for
your `ModelDeployment` resources.

## Choose a routing pattern

Use one of these patterns:

1. **Route directly to model Services.** Attach Semantic Router to a supported
   gateway as an ExtProc service, then route each selection to the corresponding
   AI Runway-managed Service. This is the simplest option when every model has
   one stable Service endpoint.
2. **Combine Semantic Router with Gateway API Inference Extension.** Let
   Semantic Router select a logical model, then let an AI Runway-managed
   `InferencePool` and Endpoint Picker choose a ready replica. This preserves
   endpoint-aware scheduling and provider-specific routing.

Semantic Router is a gateway-side processing service, not a sidecar that must
be added to every model Pod:

```text
Client
  -> Gateway
  -> Semantic Router (classification, policy, cache, model selection)
  -> HTTPRoute
  -> AI Runway Service or InferencePool
  -> model server
```

## Prerequisites

- Two or more ready `ModelDeployment` resources with OpenAI-compatible
  endpoints.
- A gateway integration supported by Semantic Router, such as Istio,
  agentgateway, or Envoy Gateway.
- Helm 3 and permission to install resources in a dedicated namespace.
- Network access from the gateway and Semantic Router namespaces to the model
  Services.

Pin Semantic Router, its Helm chart, the gateway, and Gateway API components to
a tested set of versions. The examples below use placeholders instead of an
unpinned `latest` release.

## Find the AI Runway endpoints

Provider-specific Service names differ. Read the resolved endpoint from each
`ModelDeployment` instead of assuming that the Service name matches the
deployment name:

```bash
kubectl get modeldeployments -n models \
  -o custom-columns='NAME:.metadata.name,SERVICE:.status.endpoint.service,PORT:.status.endpoint.port,MODEL:.status.gateway.modelName'
```

For a Semantic Router running in another namespace, write each endpoint as
`<service>.<namespace>.svc.cluster.local:<port>`. The model identifier forwarded
to the backend must match the identifier returned by its `/v1/models` endpoint.
When gateway integration is enabled, AI Runway records that identifier in
`status.gateway.modelName`; otherwise query `/v1/models` directly.

The example below assumes these resolved backends:

| Logical route | Service endpoint | Served model identifier |
|---|---|---|
| `general` | `qwen-general.models.svc.cluster.local:8000` | `Qwen/Qwen3-8B` |
| `reasoning` | `qwen-reasoning.models.svc.cluster.local:8000` | `Qwen/Qwen3-32B` |

## Configure Semantic Router

Create `semantic-router-values.yaml`. This example maps the two Services to
logical routes, sends computer-science prompts to the larger model with Qwen3
reasoning enabled, and enables a semantic response-cache plugin for general
traffic:

```yaml
config:
  version: v0.3

  # The gateway calls Semantic Router over ExtProc, so the chart supplies the
  # listener used by its Kubernetes integration.
  listeners: []

  providers:
    defaults:
      default_model: general
      default_reasoning_effort: high
      reasoning_families:
        qwen3:
          type: chat_template_kwargs
          parameter: enable_thinking
    models:
      - name: general
        provider_model_id: Qwen/Qwen3-8B
        api_format: openai
        backend_refs:
          - name: primary
            endpoint: qwen-general.models.svc.cluster.local:8000
            protocol: http
            weight: 100
      - name: reasoning
        provider_model_id: Qwen/Qwen3-32B
        api_format: openai
        backend_refs:
          - name: primary
            endpoint: qwen-reasoning.models.svc.cluster.local:8000
            protocol: http
            weight: 100

  routing:
    strategy: priority
    modelCards:
      - name: general
        modality: text
        capabilities: [chat]
      - name: reasoning
        modality: text
        capabilities: [chat, reasoning]
    signals:
      domains:
        - name: computer science
          description: Computer science and software engineering prompts.
          mmlu_categories: ["computer science"]
        - name: other
          description: General fallback traffic.
          mmlu_categories: [other]
    decisions:
      - name: technical-reasoning
        description: Use the reasoning model for computer-science requests.
        priority: 100
        rules:
          operator: AND
          conditions:
            - type: domain
              name: computer science
        modelRefs:
          - model: reasoning
            use_reasoning: true
      - name: general
        description: Route all remaining requests to the general model.
        priority: 10
        rules:
          operator: AND
          conditions:
            - type: domain
              name: other
        modelRefs:
          - model: general
            use_reasoning: false
        plugins:
          - type: response_cache
            configuration:
              enabled: true
              mode: exact_then_semantic
              scope: user
              semantic:
                similarity_threshold: 0.8
              ttl_seconds: 3600
              personalized:
                mode: disabled

  global:
    router:
      # Required when an ExtProc header selects the HTTPRoute.
      clear_route_cache: true
    stores:
      response_cache:
        enabled: true
        backend_type: memory
        similarity_threshold: 0.8
        max_entries: 1000
        ttl_seconds: 3600
        eviction_policy: fifo
        embedding_model: mmbert
```

The chart's `config` value merges these settings with its packaged defaults.
Use `configOverride` only when you supply a complete canonical Semantic Router
configuration, including every model asset and service setting it requires.

For guardrails, add Semantic Router's `jailbreak` or `pii` signals and bind
their matching decisions to the desired policy. Response-side controls are
available as decision plugins. Start from the maintained
[configuration fragments](https://github.com/vllm-project/semantic-router/tree/main/config/fragments)
rather than copying an old all-in-one example.

## Install and attach Semantic Router

Install the pinned chart:

```bash
export SEMANTIC_ROUTER_CHART_VERSION=<tested-chart-version>

helm upgrade --install semantic-router \
  oci://ghcr.io/vllm-project/charts/semantic-router \
  --version "${SEMANTIC_ROUTER_CHART_VERSION}" \
  --namespace semantic-router-system \
  --create-namespace \
  -f semantic-router-values.yaml

kubectl wait --for=condition=Available deployment/semantic-router \
  -n semantic-router-system --timeout=600s
```

The Helm release deploys Semantic Router, but it does not choose how your
gateway invokes ExtProc. Follow the Semantic Router instructions for your
gateway implementation and keep request-body processing enabled:

- [Istio](https://github.com/vllm-project/semantic-router/blob/main/website/docs/installation/k8s/istio.md)
- [Gateway API Inference Extension](https://github.com/vllm-project/semantic-router/blob/main/website/docs/installation/k8s/gateway-api-inference-extension.md)
- [Other gateway integrations](https://github.com/vllm-project/semantic-router/tree/main/website/docs/installation/k8s)

Review the upstream attachment resources before applying them. ExtProc failure
mode is a security decision: fail closed when Semantic Router enforces an
authorization or data-boundary policy, and test the outage path explicitly.

## Use Semantic Router instead of BBR

AI Runway's default multi-model flow uses Body-Based Router (BBR) to copy the
request's `model` field into `X-Gateway-Model-Name`. AI Runway-generated
`HTTPRoute` resources match that header. Semantic Router instead selects a
model from request meaning and writes the result to `x-selected-model`.

Because those header contracts differ, replacing BBR requires user-managed
`HTTPRoute` resources. Set `spec.gateway.httpRouteRef` on each
`ModelDeployment`; AI Runway will continue to create or adopt the
`InferencePool` and Endpoint Picker but will leave that route unchanged.

For example, configure the general model from the outset with:

```yaml
spec:
  gateway:
    enabled: true
    modelName: general
    httpRouteRef: qwen-general-semantic
```

Then create the referenced route in the same namespace as the
`ModelDeployment`:

```yaml
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: qwen-general-semantic
  namespace: models
spec:
  parentRefs:
    - name: inference-gateway
      namespace: default
  rules:
    - matches:
        - path:
            type: PathPrefix
            value: /
          headers:
            - type: Exact
              name: x-selected-model
              value: general
      backendRefs:
        - group: inference.networking.k8s.io
          kind: InferencePool
          name: qwen-general
      timeouts:
        request: 300s
```

Repeat the route for `reasoning`. Confirm the actual `InferencePool` name and
target port with `kubectl get inferencepools -n models -o yaml`;
provider-managed pools may use a different name or namespace. Cross-namespace
backends also require the appropriate `ReferenceGrant`.

Do not run BBR and Semantic Router as competing model selectors on the same
listener. Choose one component to own model selection, and make every route's
header match agree with that component's output.

## Verify the complete path

Send a request through the gateway using Semantic Router's automatic model
alias:

```bash
curl -i "${GATEWAY_URL}/v1/chat/completions" \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "vllm-sr/auto",
    "messages": [{"role": "user", "content": "Explain why this Go data race occurs."}]
  }'
```

Verify more than the HTTP status:

1. The response includes `x-vsr-selected-model` with the expected logical
   model.
2. The matching `HTTPRoute` reports `Accepted=True` and
   `ResolvedRefs=True`.
3. The chosen AI Runway endpoint receives the request with its real served
   model identifier.
4. A repeated cacheable request reports the expected cache behavior in
   Semantic Router metrics or logs.
5. Test the configured jailbreak, PII, and router-unavailable paths before
   treating guardrails as enforced.

AI Runway owns model lifecycle and endpoint health; Semantic Router owns the
request-level policy. Diagnose those layers independently when a request fails.

## References

- [vLLM Semantic Router](https://github.com/vllm-project/semantic-router)
- [Semantic Router configuration](https://github.com/vllm-project/semantic-router/blob/main/website/docs/installation/configuration.md)
- [Semantic Router Helm chart](https://github.com/vllm-project/semantic-router/tree/main/deploy/helm/semantic-router)
- [AI Runway Gateway integration](../gateway.md)
