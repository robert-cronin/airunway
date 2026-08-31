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

package v1alpha1

import (
	"context"
	"strings"
	"testing"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"
	gatewayv1 "sigs.k8s.io/gateway-api/apis/v1"

	airunwayv1alpha1 "github.com/ai-runway/airunway/controller/api/v1alpha1"
)

func gatewayReferenceTestScheme(t *testing.T) *runtime.Scheme {
	t.Helper()
	scheme := runtime.NewScheme()
	if err := airunwayv1alpha1.AddToScheme(scheme); err != nil {
		t.Fatalf("add AIRunway types to scheme: %v", err)
	}
	if err := gatewayv1.Install(scheme); err != nil {
		t.Fatalf("add Gateway API types to scheme: %v", err)
	}
	return scheme
}

func gatewayReferenceTestDeployment(ref *airunwayv1alpha1.GatewayReference) *airunwayv1alpha1.ModelDeployment {
	return &airunwayv1alpha1.ModelDeployment{
		ObjectMeta: metav1.ObjectMeta{Name: "test-model", Namespace: "model-ns"},
		Spec: airunwayv1alpha1.ModelDeploymentSpec{
			Model: airunwayv1alpha1.ModelSpec{ID: "Qwen/Qwen3-0.6B"},
			Gateway: &airunwayv1alpha1.GatewaySpec{
				GatewayRef: ref,
			},
		},
	}
}

func TestGatewayReferenceValidation(t *testing.T) {
	scheme := gatewayReferenceTestScheme(t)
	reader := fake.NewClientBuilder().WithScheme(scheme).WithObjects(
		&gatewayv1.Gateway{ObjectMeta: metav1.ObjectMeta{Name: "model-gateway", Namespace: "model-ns"}},
		&gatewayv1.Gateway{ObjectMeta: metav1.ObjectMeta{Name: "shared-gateway", Namespace: "gateway-ns"}},
	).Build()
	validator := &ModelDeploymentCustomValidator{Reader: reader}

	tests := []struct {
		name    string
		ref     *airunwayv1alpha1.GatewayReference
		wantErr string
	}{
		{
			name: "same namespace defaults from ModelDeployment",
			ref:  &airunwayv1alpha1.GatewayReference{Name: "model-gateway"},
		},
		{
			name: "explicit cross namespace reference exists",
			ref:  &airunwayv1alpha1.GatewayReference{Name: "shared-gateway", Namespace: "gateway-ns"},
		},
		{
			name:    "missing reference is rejected",
			ref:     &airunwayv1alpha1.GatewayReference{Name: "missing-gateway"},
			wantErr: "referenced Gateway model-ns/missing-gateway not found",
		},
		{
			name:    "empty name is rejected",
			ref:     &airunwayv1alpha1.GatewayReference{},
			wantErr: "gatewayRef.name is required",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			warnings, err := validator.ValidateCreate(context.Background(), gatewayReferenceTestDeployment(tt.ref))
			if tt.wantErr == "" {
				if err != nil {
					t.Fatalf("unexpected validation error: %v", err)
				}
				if len(warnings) != 0 {
					t.Fatalf("unexpected validation warnings: %v", warnings)
				}
				return
			}
			if err == nil || !strings.Contains(err.Error(), tt.wantErr) {
				t.Fatalf("expected error containing %q, got %v", tt.wantErr, err)
			}
		})
	}
}

func TestGatewayReferenceValidationFallsBackToAPIReader(t *testing.T) {
	scheme := gatewayReferenceTestScheme(t)
	cached := &countingReader{inner: fake.NewClientBuilder().WithScheme(scheme).Build()}
	api := &countingReader{inner: fake.NewClientBuilder().WithScheme(scheme).WithObjects(
		&gatewayv1.Gateway{ObjectMeta: metav1.ObjectMeta{Name: "fresh-gateway", Namespace: "model-ns"}},
	).Build()}
	validator := &ModelDeploymentCustomValidator{Reader: cached, APIReader: api}
	md := gatewayReferenceTestDeployment(&airunwayv1alpha1.GatewayReference{Name: "fresh-gateway"})

	if warnings, err := validator.ValidateCreate(context.Background(), md); err != nil {
		t.Fatalf("expected uncached fallback to find Gateway, got error %v (warnings=%v)", err, warnings)
	}
	if cached.calls == 0 {
		t.Fatal("expected cached Reader to be consulted first")
	}
	if api.calls == 0 {
		t.Fatal("expected APIReader fallback after cached NotFound")
	}
}
