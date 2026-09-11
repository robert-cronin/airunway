# vLLM Semantic Router integration

[vLLM Semantic Router](https://github.com/vllm-project/semantic-router/releases/tag/v0.3.0) can choose between AI Runway-managed models using the contents of a request. This optional guide connects its routing processor and a separate Envoy frontend proxy to existing OpenAI-compatible model Services.

AI Runway owns model deployment, provider selection, scaling, and model Services. You own the Semantic Router installation, its classification models and routing configuration, and the Envoy proxy. Updating or deleting an AI Runway deployment does not update this router configuration automatically.

```text
Client -> airunway-sr-proxy:8000 (Envoy) -> selected model Service
                    |
                    +-- gRPC <-> airunway-sr:50051 (Semantic Router)
```

Envoy sends the request to the processor through its `ext_proc` filter. The processor selects a model, rewrites the request's `model` field, and returns an `x-selected-model` header. Envoy uses that header to select a configured backend. The Helm chart's HTTP port `8080` serves the router's classification/management API; clients send chat requests to **Envoy on port `8000`**.

## Routing by model name and by meaning

With [AI Runway's gateway and Body-Based Router](../gateway.md#body-based-routing-bbr), the client supplies a model name and the gateway routes to that model. BBR extracts the request's `model` field; it does not classify the prompt.

In this example, a client sends `"model": "auto"`. Semantic Router's domain classifier predicts the request's subject. A `computer science` match selects `code-chat`; the catch-all decision selects `general-chat`. The names and mapping are your policy, and classification can be wrong. Supplying a configured model name directly lets the client select that model instead of automatic model selection.

This is an independent frontend proxy path to model Services. It does not use an AI Runway Gateway, HTTPRoute, InferencePool, or endpoint picker. A Gateway API integration or BBR replacement needs its own supported filter, header, authentication, and routing contract; this guide does not establish that contract or a sidecar deployment pattern.

## Versions and prerequisites

The example uses the **published Semantic Router chart `0.3.0`**, configuration format **`v0.3`**, and router image **`v0.3.0`**, from upstream release commit `9afc5a421886f44085f9070a8fbd878b80724f64`. Envoy **`1.34.14`** is a fixed patch release in the `1.34` series selected by that release's CLI. Both container images below include immutable digests. Use these versions together; older examples using top-level `vllm_endpoints` or `model_config` have a different schema.

You need:

- An authorized development cluster, `kubectl`, Helm 3, Bash, `curl`, `jq`, and `sha256sum`.
- Two working AI Runway `ModelDeployment` resources (`airunway.ai/v1alpha1`) with HTTP OpenAI-compatible `/v1/models` and `/v1/chat/completions` endpoints. The example assumes those endpoints accept requests without an API key and have no extra URL prefix.
- Connectivity from the proxy namespace to the model Services and from Envoy to the processor on TCP `50051`. Check any existing network policies. The DNS examples use the usual `cluster.local` domain; substitute your cluster's domain if different.
- Capacity for the router's CPU classification/embedding models, separately from the model servers. The chart requests one CPU and `3Gi` memory and limits the router to two CPUs and `7Gi` memory; check that these fit your workload. The CPU configuration below does not allocate GPUs.
- Access to GHCR and Docker Hub for the pinned images and to Hugging Face for the release's classifier/embedding assets, or an approved way to stage those assets at their configured paths. The chart optionally reads `token` from a Secret named `hf-token-secret` **in the router namespace** for gated downloads. Manage any needed credential through your normal secret workflow. Startup downloads can take several minutes and repeat after a restart because this example uses ephemeral model storage.

Use a fresh namespace named `airunway-semantic-router-demo` for the guide-owned resources. This is a trusted development example using internal HTTP and a loopback port-forward. The proxy does not inherit the web UI's authentication or an existing gateway's authentication, TLS, or traffic policies. Keep it internal; exposing it requires a separately configured access-control boundary.

## 1. Discover each model endpoint and served name

List the deployments and their reported endpoints:

```bash
kubectl --request-timeout=10s get modeldeployments.airunway.ai -A \
  -o custom-columns='NAMESPACE:.metadata.namespace,NAME:.metadata.name,PHASE:.status.phase,SERVICE:.status.endpoint.service,REPORTED_PORT:.status.endpoint.port'
```

For each deployment, use **its namespace** and `status.endpoint.service` to inspect the actual Service. For example:

```bash
kubectl --request-timeout=10s -n models get service qwen-general -o json \
  | jq '.spec.ports[] | {name, port, targetPort}'
```

Choose the Service's HTTP **`port`**, not its `targetPort`, a metrics port, or an assumed value of `8000`. Some providers report a container port in `status.endpoint.port`; the Service can expose a different client port. An empty endpoint or a Service without working backends must be resolved before continuing.

Probe `/v1/models` to learn the exact model ID accepted by that server. In one terminal, forward the selected Service port (here `8000`):

```bash
kubectl -n models port-forward --address 127.0.0.1 \
  service/qwen-general 18001:8000
```

In another terminal:

```bash
curl --fail --silent --show-error --connect-timeout 5 --max-time 15 \
  http://127.0.0.1:18001/v1/models | jq -r '.data[].id'
```

Stop that port-forward with Ctrl-C and repeat for the second Service. If a server lists multiple IDs, choose one it accepts for chat. `spec.model.servedName` expresses the requested serving name where the provider supports it. `status.gateway.modelName` describes gateway routing and may come from an override, discovery, or a fallback; it is not proof of the name accepted by a direct backend. Use the live `/v1/models` response to check both.

The rest of this guide assumes the following **illustrative discovery results**, not resources created by the guide. Replace them throughout both YAML files with your actual results:

| ModelDeployment | Namespace | `status.endpoint.service` | Service HTTP `port` | Chosen `/v1/models` ID |
| --- | --- | --- | --- | --- |
| `qwen-general` | `models` | `qwen-general` | `8000` | `general-chat` |
| `qwen-code` | `models` | `qwen-code` | `8000` | `code-chat` |

For example, an aggregated Direct vLLM deployment creates its Service in the deployment's namespace and exposes port `8000`. Other providers can use different names or ports, so always perform discovery. See the [CRD reference](../crd-reference.md) for the AI Runway fields.

## 2. Configure the routing processor

Save this as `router-values.yaml`. Use each chosen server ID consistently in `providers.models`, `provider_model_id`, `routing.modelCards`, `modelRefs`, and the corresponding Envoy routes in the next section. `backend_refs[].endpoint` is **DNS name plus Service port**, without `http://` or `/v1`.

```yaml title="router-values.yaml"
fullnameOverride: airunway-sr
image:
  repository: ghcr.io/vllm-project/semantic-router/extproc
  tag: v0.3.0@sha256:5c5a6421f7a1fc0596fc7e9053b35952fef4bc12564c01a3f7315c51e3602ae6
replicaCount: 1
rbac:
  create: false
persistence:
  enabled: false
dashboard:
  enabled: false
service:
  type: ClusterIP
  metrics:
    enabled: false
router:
  skipProcessing:
    enabled: false
config:
  version: v0.3
  providers:
    defaults:
      default_model: general-chat
    models:
      - name: general-chat
        provider_model_id: general-chat
        backend_refs:
          - name: general-service
            endpoint: qwen-general.models.svc.cluster.local:8000
            protocol: http
            weight: 100
      - name: code-chat
        provider_model_id: code-chat
        backend_refs:
          - name: code-service
            endpoint: qwen-code.models.svc.cluster.local:8000
            protocol: http
            weight: 100
  routing:
    modelCards:
      - name: general-chat
      - name: code-chat
    signals:
      domains:
        - name: computer science
          description: Computer science and software engineering questions.
          mmlu_categories: [computer science]
        - name: other
          description: General questions.
          mmlu_categories: [other]
    decisions:
      - name: computer-science
        description: Route computer science questions to the code model.
        priority: 100
        rules:
          operator: AND
          conditions:
            - type: domain
              name: computer science
        modelRefs:
          - model: code-chat
            use_reasoning: false
        algorithm:
          type: static
      - name: general-fallback
        description: Use the general model when no higher-priority decision matches.
        priority: 1
        rules:
          operator: AND
          conditions: []
        modelRefs:
          - model: general-chat
            use_reasoning: false
        algorithm:
          type: static
  global:
    router:
      config_source: file
      auto_model_name: auto
      clear_route_cache: true
    services:
      response_api:
        enabled: false
      router_replay:
        enabled: false
      observability:
        tracing:
          enabled: false
    stores:
      semantic_cache:
        enabled: false
      memory:
        enabled: false
    integrations:
      tools:
        enabled: false
    model_catalog:
      modules:
        classifier:
          domain:
            model_ref: domain_classifier
            threshold: 0.5
            use_cpu: true
        prompt_guard:
          enabled: false
        feedback_detector:
          enabled: false
        hallucination_mitigation:
          enabled: false
```

The domain classifier and embedding asset identifiers come from the pinned release's model catalog. Container/chart pins do not pin independently downloaded model-weight revisions; retain the exact assets used when evaluating classification results. The higher-priority domain decision wins on a match, while the empty `AND` decision provides the fallback. No reasoning-family override, caching, tool selection, or guardrail plugin is configured here.

The chart's optional Redis, Milvus, and observability dependencies are disabled by default in this version. `config_source: file`, disabled chart RBAC, and `--skip-crds` below keep the example independent of the router's Kubernetes CRD integration.

## 3. Configure Envoy's model routes

Save the following as `envoy.yaml`. **Configure the same model destinations in both files**: setting `backend_refs` alone does not create Envoy clusters. This follows the release's model-header routing pattern with explicit HTTP clusters for the discovered Services and an HTTP/2 gRPC cluster for the processor.

```yaml title="envoy.yaml"
static_resources:
  listeners:
    - name: chat
      address:
        socket_address:
          address: 0.0.0.0
          port_value: 8000
      per_connection_buffer_limit_bytes: 1048576
      filter_chains:
        - filters:
            - name: envoy.filters.network.http_connection_manager
              typed_config:
                "@type": type.googleapis.com/envoy.extensions.filters.network.http_connection_manager.v3.HttpConnectionManager
                stat_prefix: chat
                route_config:
                  name: models
                  virtual_hosts:
                    - name: models
                      domains: ["*"]
                      routes:
                        - match:
                            path: /v1/chat/completions
                            headers:
                              - name: x-selected-model
                                string_match:
                                  exact: code-chat
                          route:
                            cluster: code
                            timeout: 60s
                        - match:
                            path: /v1/chat/completions
                          route:
                            cluster: general
                            timeout: 60s
                        - match:
                            prefix: /
                          direct_response:
                            status: 404
                          typed_per_filter_config:
                            envoy.filters.http.ext_proc:
                              "@type": type.googleapis.com/envoy.extensions.filters.http.ext_proc.v3.ExtProcPerRoute
                              disabled: true
                http_filters:
                  - name: envoy.filters.http.header_mutation
                    typed_config:
                      "@type": type.googleapis.com/envoy.extensions.filters.http.header_mutation.v3.HeaderMutation
                      mutations:
                        request_mutations:
                          - remove: x-selected-model
                          - remove: x-vsr-skip-processing
                          - remove: x-vsr-looper-request
                          - remove: x-vsr-looper-secret
                          - remove: x-vsr-looper-decision
                          - remove: x-vsr-looper-iteration
                          - remove: x-authz-user-id
                          - remove: x-authz-user-groups
                  - name: envoy.filters.http.ext_proc
                    typed_config:
                      "@type": type.googleapis.com/envoy.extensions.filters.http.ext_proc.v3.ExternalProcessor
                      grpc_service:
                        envoy_grpc:
                          cluster_name: processor
                        timeout: 60s
                      message_timeout: 60s
                      failure_mode_allow: false
                      allow_mode_override: true
                      processing_mode:
                        request_header_mode: SEND
                        response_header_mode: SEND
                        request_body_mode: BUFFERED
                        response_body_mode: BUFFERED
                        request_trailer_mode: SKIP
                        response_trailer_mode: SKIP
                  - name: envoy.filters.http.router
                    typed_config:
                      "@type": type.googleapis.com/envoy.extensions.filters.http.router.v3.Router
                access_log:
                  - name: envoy.access_loggers.stdout
                    typed_config:
                      "@type": type.googleapis.com/envoy.extensions.access_loggers.stream.v3.StdoutAccessLog
                      log_format:
                        text_format_source:
                          inline_string: "status=%RESPONSE_CODE% cluster=%UPSTREAM_CLUSTER% flags=%RESPONSE_FLAGS%\n"
  clusters:
    - name: processor
      type: STRICT_DNS
      connect_timeout: 5s
      typed_extension_protocol_options:
        envoy.extensions.upstreams.http.v3.HttpProtocolOptions:
          "@type": type.googleapis.com/envoy.extensions.upstreams.http.v3.HttpProtocolOptions
          explicit_http_config:
            http2_protocol_options: {}
      load_assignment:
        cluster_name: processor
        endpoints:
          - lb_endpoints:
              - endpoint:
                  address:
                    socket_address:
                      address: airunway-sr.airunway-semantic-router-demo.svc.cluster.local
                      port_value: 50051
    - name: general
      type: STRICT_DNS
      connect_timeout: 5s
      load_assignment:
        cluster_name: general
        endpoints:
          - lb_endpoints:
              - endpoint:
                  address:
                    socket_address:
                      address: qwen-general.models.svc.cluster.local
                      port_value: 8000
    - name: code
      type: STRICT_DNS
      connect_timeout: 5s
      load_assignment:
        cluster_name: code
        endpoints:
          - lb_endpoints:
              - endpoint:
                  address:
                    socket_address:
                      address: qwen-code.models.svc.cluster.local
                      port_value: 8000
```

The general route also supplies Envoy's initial route before the processor selects a model. `clear_route_cache: true` lets the returned header select the code route afterward. The first filter removes client-supplied internal routing headers before processing. With `failure_mode_allow: false`, an unavailable processor causes a request failure instead of forwarding an unprocessed request. The catch-all 404 route disables the processor, including its own immediate-response endpoints, so only `/v1/chat/completions` is exposed by this proxy configuration.

Save this as `proxy.yaml`; its resources will be installed in the guide's namespace:

```yaml title="proxy.yaml"
apiVersion: apps/v1
kind: Deployment
metadata:
  name: airunway-sr-proxy
spec:
  replicas: 1
  selector:
    matchLabels:
      app: airunway-sr-proxy
  template:
    metadata:
      labels:
        app: airunway-sr-proxy
    spec:
      automountServiceAccountToken: false
      containers:
        - name: envoy
          image: envoyproxy/envoy:v1.34.14@sha256:cfc0678bc03cca19cbb031688acb31d510bff501ff97e163026a375fe0515d69
          args: ["-c", "/etc/envoy/envoy.yaml", "--concurrency", "2"]
          ports:
            - name: http
              containerPort: 8000
          readinessProbe:
            tcpSocket:
              port: http
          resources:
            requests:
              cpu: 100m
              memory: 128Mi
            limits:
              cpu: "1"
              memory: 256Mi
          volumeMounts:
            - name: config
              mountPath: /etc/envoy
              readOnly: true
      volumes:
        - name: config
          configMap:
            name: airunway-sr-envoy-config
---
apiVersion: v1
kind: Service
metadata:
  name: airunway-sr-proxy
spec:
  type: ClusterIP
  selector:
    app: airunway-sr-proxy
  ports:
    - name: http
      port: 8000
      targetPort: http
```

## 4. Render and install

Download the exact published chart and check its archive checksum. The release pipeline stamps the published chart with version `0.3.0` and app version `v0.3.0`; a source checkout's chart metadata is different.

```bash
set -euo pipefail
helm pull oci://ghcr.io/vllm-project/charts/semantic-router --version 0.3.0
printf '%s  %s\n' \
  f7f0e489b5d074e7a0a998dd058c5c58976d5028cafcd44699dd181ce16f6a4e \
  semantic-router-0.3.0.tgz | sha256sum --check -

helm lint ./semantic-router-0.3.0.tgz -f router-values.yaml
helm template airunway-sr ./semantic-router-0.3.0.tgz \
  --namespace airunway-semantic-router-demo \
  -f router-values.yaml > router-rendered.yaml
```

Review `router-rendered.yaml`: it should contain a router Deployment, configuration ConfigMap, Service, and ServiceAccount, with the selected names, image, and model endpoints. A successful render checks templates and the chart's limited values schema; it does not prove model loading or request routing.

Install on your authorized development cluster. Creating the namespace should fail if it already exists; reuse it only if you own the resources from an earlier run of this guide.

```bash
set -euo pipefail
kubectl create namespace airunway-semantic-router-demo
helm install airunway-sr ./semantic-router-0.3.0.tgz \
  --namespace airunway-semantic-router-demo --skip-crds \
  -f router-values.yaml --wait --timeout 30m

kubectl -n airunway-semantic-router-demo create configmap airunway-sr-envoy-config \
  --from-file=envoy.yaml
kubectl -n airunway-semantic-router-demo apply -f proxy.yaml
kubectl -n airunway-semantic-router-demo rollout status \
  deployment/airunway-sr-proxy --timeout=180s
```

After changing router values, use `helm upgrade` with the same chart, namespace, and values file, then check the rollout. After changing `envoy.yaml`, update its guide-owned ConfigMap and restart `deployment/airunway-sr-proxy` so Envoy loads the new static configuration. Model additions, Service changes, and served-name changes require updating both configurations.

## 5. Send a bounded request

Forward the **proxy** Service in one terminal:

```bash
kubectl -n airunway-semantic-router-demo port-forward --address 127.0.0.1 \
  service/airunway-sr-proxy 18080:8000
```

In another terminal, request a short, non-streaming answer:

```bash
curl --fail-with-body --silent --show-error --connect-timeout 5 --max-time 60 \
  http://127.0.0.1:18080/v1/chat/completions \
  -H 'Content-Type: application/json' \
  --data '{"model":"auto","messages":[{"role":"user","content":"Explain the time complexity of binary search in two sentences."}],"max_tokens":64,"stream":false,"temperature":0}'
```

Check the response's model ID and the proxy's selected cluster:

```bash
kubectl --request-timeout=10s -n airunway-semantic-router-demo logs \
  deployment/airunway-sr-proxy --tail=20
kubectl --request-timeout=10s -n airunway-semantic-router-demo logs \
  deployment/airunway-sr --tail=50
```

A `computer science` prediction should use cluster `code`; a different prediction should use `general`. Try a general question and a direct `"model":"general-chat"` request as additional checks. A listening proxy port or a Ready processor does not establish that both model servers accept the rewritten requests. Verify each model directly and through the proxy in your environment.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Router stays Pending or takes a long time to start | CPU/memory capacity, image pulls, classifier downloads, and the router logs. Check whether an enabled model needs an authorized Hugging Face token in this namespace. |
| Chat request fails on port `8080` | Use the Envoy proxy's port `8000`; `8080` belongs to the processor API. |
| Envoy returns `503` or a processor error | Service DNS, the selected Service ports, network policies, and gRPC connectivity to `airunway-sr:50051`. The processor cluster must use HTTP/2. |
| Backend rejects the model or returns `404` | Probe that backend's `/v1/models` again. Check all model references, the request path, and whether you mistakenly used a gateway alias or model download ID. |
| Everything goes to the general model | Check the classifier's prediction, the decision name and priority, `auto_model_name: auto`, `clear_route_cache: true`, and Envoy's exact `x-selected-model` match. A prompt does not guarantee a particular classification. |
| Service or model was renamed | Rediscover the endpoint and update both router values and Envoy configuration, then reload both workloads. |
| Requests work directly but fail through the proxy | Check protocol features and credentials. This example covers unauthenticated internal HTTP and non-streaming chat; other API shapes, streaming, tools, reasoning parameters, and authentication need their own validation. |

## Cleanup

Stop the guide's port-forwards with Ctrl-C, then remove only its release, proxy resources, and proxy ConfigMap:

```bash
kubectl -n airunway-semantic-router-demo delete -f proxy.yaml --ignore-not-found
kubectl -n airunway-semantic-router-demo delete configmap \
  airunway-sr-envoy-config --ignore-not-found
helm uninstall airunway-sr --namespace airunway-semantic-router-demo --timeout 2m
```

This leaves the namespace, any separately managed Secrets, and all existing AI Runway ModelDeployments, model Services, and gateway resources in place. The example creates no persistent volumes or router CRDs.

## Capabilities and validation limits

Upstream offers semantic caching, jailbreak/PII detection, hallucination-related checks, and other plugins. Each needs its own model assets, configuration, evaluation, and operational policy. Installing the router does not establish their accuracy or enable them in this example. Cache isolation and retention also require explicit design before handling sensitive or multi-user traffic.

This guide's validation covers the pinned chart render, configuration/schema checks, command syntax, documentation links, and AI Runway's endpoint/model-name contracts. It does not establish live classifier accuracy, GPU inference, production readiness, or end-to-end interoperability with every provider. Run the bounded checks above against your actual model endpoints before relying on the integration.

Automatic discovery, an AI Runway controller or provider for the router, routing CRD extensions, UI metrics, and sharing or replacing the existing gateway policy are future integration work.

## Versioned upstream references

- [Semantic Router v0.3.0 release and published artifacts](https://github.com/vllm-project/semantic-router/releases/tag/v0.3.0)
- [Chart values, templates, and values schema at the release commit](https://github.com/vllm-project/semantic-router/tree/9afc5a421886f44085f9070a8fbd878b80724f64/deploy/helm/semantic-router)
- [v0.3 configuration contract and defaults](https://github.com/vllm-project/semantic-router/tree/9afc5a421886f44085f9070a8fbd878b80724f64/src/semantic-router/pkg/config)
- [Domain signal examples](https://github.com/vllm-project/semantic-router/blob/9afc5a421886f44085f9070a8fbd878b80724f64/config/signal/domain/mmlu.yaml) and [domain decision example](https://github.com/vllm-project/semantic-router/blob/9afc5a421886f44085f9070a8fbd878b80724f64/config/decision/single/domain-computer-science.yaml)
- [Envoy model-header routing template](https://github.com/vllm-project/semantic-router/blob/9afc5a421886f44085f9070a8fbd878b80724f64/src/vllm-sr/cli/templates/envoy.template.yaml) and [CLI image defaults](https://github.com/vllm-project/semantic-router/blob/9afc5a421886f44085f9070a8fbd878b80724f64/src/vllm-sr/cli/consts.py)
- [Envoy v1.34.14 release](https://github.com/envoyproxy/envoy/releases/tag/v1.34.14)
