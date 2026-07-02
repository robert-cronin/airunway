/*
Copyright 2026.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

package dynamo

import (
	"context"
	"fmt"
	"strings"
	"testing"

	"k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/apimachinery/pkg/util/validation/field"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"

	airunwayv1alpha1 "github.com/kaito-project/airunway/controller/api/v1alpha1"
)

// TestClassifyCompatErr verifies that a dry-run apply error is classified into
// the correct compatibility verdict (issue #308). Deterministic schema
// rejections gate the deployment; everything else is inconclusive.
func TestClassifyCompatErr(t *testing.T) {
	gr := schema.GroupResource{Group: "nvidia.com", Resource: "dynamographdeployments"}
	gk := schema.GroupKind{Group: "nvidia.com", Kind: "DynamoGraphDeployment"}

	tests := []struct {
		name string
		err  error
		want compatVerdict
	}{
		{"nil accepts", nil, compatCompatible},
		{"bad request rejects", errors.NewBadRequest(`unknown field "spec.services.Frontend.frontendSidecar"`), compatIncompatible},
		{"invalid rejects", errors.NewInvalid(gk, "test", field.ErrorList{field.Invalid(field.NewPath("spec"), nil, "bad")}), compatIncompatible},
		{"unknown field string rejects", fmt.Errorf(`strict decoding error: unknown field "spec.frontendSidecar"`), compatIncompatible},
		{"undeclared field string rejects", fmt.Errorf(".spec.frontendSidecar: field not declared in schema"), compatIncompatible},
		{"crd kind absent is inconclusive", errors.NewNotFound(gr, "test"), compatUnknown},
		{"rbac forbidden is inconclusive", errors.NewForbidden(gr, "test", fmt.Errorf("nope")), compatUnknown},
		{"conflict is inconclusive", errors.NewConflict(gr, "test", fmt.Errorf("conflict")), compatUnknown},
		{"transient error is inconclusive", fmt.Errorf("connection refused"), compatUnknown},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, _ := classifyCompatErr(tt.err)
			if got != tt.want {
				t.Errorf("classifyCompatErr(%v) = %d, want %d", tt.err, got, tt.want)
			}
		})
	}
}

// TestPlanUpstreamIncompatibility verifies the refuse-fast vs freeze decision.
func TestPlanUpstreamIncompatibility(t *testing.T) {
	t.Run("fresh create refuses fast and stays Pending", func(t *testing.T) {
		p := planUpstreamIncompatibility(false, "older CRD")
		if p.preserveExisting {
			t.Error("a fresh create must not be preserved")
		}
		if p.phase != airunwayv1alpha1.DeploymentPhasePending {
			t.Errorf("refuse-fast must stay Pending (recoverable), got %s", p.phase)
		}
		if !strings.Contains(p.message, "Refusing to deploy") {
			t.Errorf("expected a refusal message, got %q", p.message)
		}
	})

	t.Run("existing workload is preserved (frozen)", func(t *testing.T) {
		p := planUpstreamIncompatibility(true, "older CRD")
		if !p.preserveExisting {
			t.Error("an existing workload must be preserved (frozen)")
		}
		// The freeze branch does not use plan.phase: the realized phase comes from
		// syncStatus and reflects the preserved workload's real state. See
		// TestSyncStatusFrozenWorkloadNeverReady for the realized behavior.
		if p.phase != "" {
			t.Errorf("freeze plan must not set a phase, got %q", p.phase)
		}
		if !strings.Contains(p.message, "preserving") {
			t.Errorf("expected a preserve message, got %q", p.message)
		}
	})
}

// TestProviderKnownCompatible verifies the readiness-gate predicate: only an
// explicit False blocks readiness; absent/Unknown is treated as compatible so
// the gate never regresses behavior when the upstream check could not run.
func TestProviderKnownCompatible(t *testing.T) {
	mk := func(conds ...metav1.Condition) *airunwayv1alpha1.ModelDeployment {
		md := &airunwayv1alpha1.ModelDeployment{}
		md.Status.Conditions = conds
		return md
	}
	cond := func(s metav1.ConditionStatus) metav1.Condition {
		return metav1.Condition{Type: airunwayv1alpha1.ConditionTypeProviderCompatible, Status: s, Reason: "x"}
	}

	if !providerKnownCompatible(mk()) {
		t.Error("absent condition should be treated as compatible")
	}
	if !providerKnownCompatible(mk(cond(metav1.ConditionTrue))) {
		t.Error("True should be compatible")
	}
	if !providerKnownCompatible(mk(cond(metav1.ConditionUnknown))) {
		t.Error("Unknown should be treated as compatible")
	}
	if providerKnownCompatible(mk(cond(metav1.ConditionFalse))) {
		t.Error("False must not be treated as compatible")
	}
}

// TestSyncStatusReadyGatedByUpstreamCompatibility reproduces the #308
// silent-broken scenario at the unit level: the upstream reports a healthy
// "successful" state, but because the provider is marked incompatible the
// ModelDeployment must NOT be reported Ready. Before the fix, Ready was set
// purely from the upstream phase and would have been True.
func TestSyncStatusReadyGatedByUpstreamCompatibility(t *testing.T) {
	scheme := newScheme()

	dgd := &unstructured.Unstructured{}
	setDGDGVK(dgd)
	dgd.SetName("test")
	dgd.SetNamespace("default")
	dgd.Object["status"] = map[string]interface{}{"state": "successful"}

	c := fake.NewClientBuilder().WithScheme(scheme).WithObjects(dgd).Build()
	r := NewDynamoProviderReconciler(c, scheme, "")

	md := &airunwayv1alpha1.ModelDeployment{}
	r.setCondition(md, airunwayv1alpha1.ConditionTypeProviderCompatible, metav1.ConditionFalse, "IncompatibleUpstream", "older CRD prunes frontendSidecar")

	desired := &unstructured.Unstructured{}
	setDGDGVK(desired)
	desired.SetName("test")
	desired.SetNamespace("default")

	if err := r.syncStatus(context.Background(), md, desired); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	// Phase still reflects the real upstream state...
	if md.Status.Phase != airunwayv1alpha1.DeploymentPhaseRunning {
		t.Errorf("expected phase to reflect the upstream (Running), got %s", md.Status.Phase)
	}
	// ...but Ready is gated off because the provider is not known-compatible.
	assertCondition(t, md.Status.Conditions, airunwayv1alpha1.ConditionTypeReady, metav1.ConditionFalse, "IncompatibleUpstream")
}

// TestSyncStatusReadyWhenCompatible is the positive control: a running workload
// with no incompatibility marker is reported Ready, so the gate does not
// over-block healthy deployments.
func TestSyncStatusReadyWhenCompatible(t *testing.T) {
	scheme := newScheme()

	dgd := &unstructured.Unstructured{}
	setDGDGVK(dgd)
	dgd.SetName("test")
	dgd.SetNamespace("default")
	dgd.Object["status"] = map[string]interface{}{"state": "successful"}

	c := fake.NewClientBuilder().WithScheme(scheme).WithObjects(dgd).Build()
	r := NewDynamoProviderReconciler(c, scheme, "")

	md := &airunwayv1alpha1.ModelDeployment{}
	desired := &unstructured.Unstructured{}
	setDGDGVK(desired)
	desired.SetName("test")
	desired.SetNamespace("default")

	if err := r.syncStatus(context.Background(), md, desired); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	assertCondition(t, md.Status.Conditions, airunwayv1alpha1.ConditionTypeReady, metav1.ConditionTrue, "DeploymentReady")
}

// TestSyncStatusFrozenWorkloadNeverReady documents the freeze path's realized
// status behavior: a preserved (frozen) workload surfaces its real upstream phase
// — including Failed if it crashed — but is never reported Ready while the
// provider is incompatible. Surfacing Failed is safe because gateway
// reconciliation is gated on phase==Running, so it triggers no teardown. This is
// the realized-phase check the freeze path needs; the plan struct's phase field
// is unused for freeze, so asserting on it would give false assurance.
func TestSyncStatusFrozenWorkloadNeverReady(t *testing.T) {
	scheme := newScheme()

	dgd := &unstructured.Unstructured{}
	setDGDGVK(dgd)
	dgd.SetName("test")
	dgd.SetNamespace("default")
	dgd.Object["status"] = map[string]interface{}{"state": "failed", "message": "oom"}

	c := fake.NewClientBuilder().WithScheme(scheme).WithObjects(dgd).Build()
	r := NewDynamoProviderReconciler(c, scheme, "")

	// Freeze marks the provider incompatible before syncing status.
	md := &airunwayv1alpha1.ModelDeployment{}
	r.setCondition(md, airunwayv1alpha1.ConditionTypeProviderCompatible, metav1.ConditionFalse, "IncompatibleUpstream", "older CRD")

	desired := &unstructured.Unstructured{}
	setDGDGVK(desired)
	desired.SetName("test")
	desired.SetNamespace("default")

	if err := r.syncStatus(context.Background(), md, desired); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	// The real (failed) phase is surfaced, not hidden behind a stale Running.
	if md.Status.Phase != airunwayv1alpha1.DeploymentPhaseFailed {
		t.Errorf("expected the real upstream phase (Failed) to be surfaced, got %s", md.Status.Phase)
	}
	// But the deployment is never Ready while incompatible — the safety property.
	assertCondition(t, md.Status.Conditions, airunwayv1alpha1.ConditionTypeReady, metav1.ConditionFalse, "DeploymentFailed")
}

// TestUpstreamResourceExists verifies the existence probe that distinguishes a
// fresh create (refuse-fast) from a workload predating a version change (freeze).
func TestUpstreamResourceExists(t *testing.T) {
	scheme := newScheme()

	dgd := &unstructured.Unstructured{}
	setDGDGVK(dgd)
	dgd.SetName("test")
	dgd.SetNamespace("default")

	resources := []*unstructured.Unstructured{dgd.DeepCopy()}

	t.Run("absent", func(t *testing.T) {
		c := fake.NewClientBuilder().WithScheme(scheme).Build()
		r := NewDynamoProviderReconciler(c, scheme, "")
		if r.upstreamResourceExists(context.Background(), resources) {
			t.Error("expected no existing upstream resource")
		}
	})

	t.Run("present", func(t *testing.T) {
		c := fake.NewClientBuilder().WithScheme(scheme).WithObjects(dgd).Build()
		r := NewDynamoProviderReconciler(c, scheme, "")
		if !r.upstreamResourceExists(context.Background(), resources) {
			t.Error("expected the existing upstream resource to be found")
		}
	})
}
