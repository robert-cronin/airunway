# Airunway controller contributor guide

This file applies to `controller/` and supplements the repository-wide instructions in `../agents.md`. Keep it focused on stable Airunway invariants; use the Makefiles and current code for tool versions and command details.

## Architecture and ownership

- `api/v1alpha1/` defines the public `ModelDeployment` and cluster-scoped `InferenceProviderConfig` APIs. Markers on these types are authoritative for scope, schema, status subresources, and generated CRDs.
- `internal/controller/modeldeployment_controller.go` is the core reconciler. It validates defensively, selects an engine and provider from registered capabilities, writes core-owned status, records metrics, and coordinates gateway reconciliation. It does not create provider-specific workloads.
- `../providers/` contains independent provider controllers. They render provider resources or native workloads, own provider cleanup/finalizers, and report workload phase, endpoint, replicas, readiness, and upstream identity.
- `internal/controller/gateway_reconciler.go` owns Airunway-managed gateway resources. Some gateway state is shared or user-managed; preserve unrelated routes and namespace entries when patching it.
- `internal/webhook/v1alpha1/` owns admission defaulting and validation. `internal/validation/` contains pure compatibility rules shared by admission and reconciliation.
- `internal/controller/migration.go` migrates legacy provider capabilities at manager startup. It is leader-elected, idempotent, and intentionally uses a direct unstructured client before normal typed reads.

## Reconciliation invariants

- Reconciliation must remain idempotent and safe under retries, stale cache observations, conflicts, deletion, and controller restarts.
- Never mutate informer-backed objects indirectly. Resolve defaults and auto-selected values into local variables or status rather than rewriting the user's spec.
- Preserve status written by other controllers. The core currently patches from a deep-copy base so provider-owned fields survive; conditions must use `meta.SetStatusCondition` and the current object generation.
- Treat `InferenceProviderConfig.spec.capabilities.engines` as authoritative for engine, hardware, and serving-mode compatibility. Provider ready state gates selection, and relevant capability changes must enqueue affected deployments.
- Keep the webhook and reconciler backstops aligned. Put shared compatibility logic in `internal/validation` instead of duplicating it.
- Model identity, an explicitly configured engine, an already-selected provider, serving mode, and existing managed-storage definitions are not in-place changes. Admission rejects them; reconciliation keeps defensive checks for admission bypass and upgrade scenarios.
- Core deletion handles gateway cleanup. Provider-specific resources and finalizers belong to the selected provider controller. Owner references must reflect the actual controller and Kubernetes namespace rules.
- Do not turn user-managed gateway resources into continuously reconciled Airunway resources accidentally. In particular, understand the existing `InferencePool` watch and deliberate lack of an `HTTPRoute` watch before changing event sources.

## Validation and security

- Treat every CR spec, annotation, and raw provider override as untrusted. Recursively validate structured overrides, including objects nested in arrays, and never include raw override bodies or secrets in logs/errors.
- Preserve the blocked privilege and workload-sizing keys in provider overrides. New escape hatches need admission tests and a reconciliation or provider backstop where admission can be bypassed.
- Keep RBAC least-privilege. Add or change Kubebuilder RBAC markers beside the code that needs access, regenerate `config/rbac/role.yaml`, and review the resulting verbs and scopes.
- Use cached reads on hot reconciliation/admission paths. Add uncached reads only for a documented freshness or startup requirement, as in webhook cache-miss confirmation and legacy migration.
- Use conflict-safe patching for shared objects. Gateway namespace allowlists are updated concurrently by multiple deployments and must retain optimistic locking and retry behavior.

## Generated and hand-maintained files

Do not hand-edit these generated files:

- `api/v1alpha1/zz_generated.deepcopy.go`
- `config/crd/bases/*.yaml`
- `config/rbac/role.yaml`
- `config/webhook/manifests.yaml`

After changing API types, validation/default markers, webhook markers, or RBAC markers, run:

```bash
make controller-generate
```

Run that target from the repository root and review every generated diff. `controller/PROJECT` and Kubebuilder scaffold markers are tool metadata; preserve them, but use the Go types and generated manifests as runtime truth. Other files under `config/` are hand-maintained unless their header says otherwise.

## Canonical validation

For any controller Go change, run from the repository root:

```bash
make -C controller test
make -C controller lint
make controller-build
```

`make -C controller test` is the CI-parity unit/envtest path; it also regenerates, formats, and vets. `make controller-build` validates root version synchronization and linker-injected defaults. Focused `go test` commands are useful while editing but do not replace the final Make targets.

Additional validation by change type:

- API, webhook, or RBAC markers: run `make controller-generate`, inspect the CRD, RBAC, webhook, and deepcopy diffs, then run the canonical commands above.
- Manager or deployment configuration: run `make generate-deploy-manifests` and inspect `deploy/controller.yaml` for intended drift.
- Reconciliation changes: add focused tests for the success path, retries, NotFound/deletion, conflict behavior, condition transitions, and preservation of fields owned by other controllers.
- Admission changes: test create and update, defaults, warnings, malformed input, bypass backstops, and cached-reader fallback where relevant.
- Cross-component lifecycle behavior: use the relevant E2E workflow or `make -C controller test-e2e KIND_CLUSTER=<dedicated-kind-name>` only with an isolated disposable Kind cluster. Never point an E2E cleanup target at a shared or production cluster.
- Guidance-only changes: run `git diff --check` and verify referenced paths and targets exist; controller binaries and tests are not affected.

Before handing off a code change, confirm the worktree contains no unintended generated, formatting, coverage, binary, or deployment-manifest changes.
