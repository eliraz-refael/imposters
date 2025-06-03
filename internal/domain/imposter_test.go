package domain

import (
	"testing"
	"time"
)

func TestNewImposterConfig(t *testing.T) {
	tests := []struct {
		name     string
		nameArg  string
		port     int
		wantName string
	}{
		{
			name:     "with provided name",
			nameArg:  "test-imposter",
			port:     3001,
			wantName: "test-imposter",
		},
		{
			name:     "with empty name - should use generated ID",
			nameArg:  "",
			port:     3002,
			wantName: "", // Will be set to generated ID
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := NewImposterConfig(tt.nameArg, tt.port)

			// Check basic fields
			if got.Port != tt.port {
				t.Errorf("NewImposterConfig() Port = %v, want %v", got.Port, tt.port)
			}

			if got.Status != "running" {
				t.Errorf("NewImposterConfig() Status = %v, want %v", got.Status, "running")
			}

			// Check ID is generated
			if got.ID == "" {
				t.Error("NewImposterConfig() should generate ID")
			}

			if len(got.ID) != 8 {
				t.Errorf("NewImposterConfig() ID should be 8 characters, got %d", len(got.ID))
			}

			// Check name handling
			if tt.nameArg != "" {
				if got.Name != tt.nameArg {
					t.Errorf("NewImposterConfig() Name = %v, want %v", got.Name, tt.nameArg)
				}
			} else {
				// When no name provided, should use ID
				if got.Name != got.ID {
					t.Errorf("NewImposterConfig() Name should equal ID when not provided, got Name=%v, ID=%v", got.Name, got.ID)
				}
			}

			// Check CreatedAt is set
			if got.CreatedAt.IsZero() {
				t.Error("NewImposterConfig() should set CreatedAt")
			}

			// Check CreatedAt is recent (within last second)
			if time.Since(got.CreatedAt) > time.Second {
				t.Error("NewImposterConfig() CreatedAt should be recent")
			}
		})
	}
}

func TestGenerateShortID_Uniqueness(t *testing.T) {
	// Generate multiple IDs and check for uniqueness
	ids := make(map[string]bool)
	const numIDs = 1000

	for i := 0; i < numIDs; i++ {
		id := GenerateShortID()

		if len(id) != 8 {
			t.Errorf("GenerateShortID() should return 8-character ID, got %d", len(id))
		}

		if ids[id] {
			t.Errorf("GenerateShortID() generated duplicate ID: %s", id)
		}

		ids[id] = true
	}

	if len(ids) != numIDs {
		t.Errorf("Expected %d unique IDs, got %d", numIDs, len(ids))
	}
}

func TestImposterConfig_JSONSerialization(t *testing.T) {
	config := NewImposterConfig("test-imposter", 3001)

	// Test that all fields are properly tagged for JSON
	// This is more of a compile-time check, but we can verify the struct has the expected shape

	if config.ID == "" {
		t.Error("Config should have ID")
	}
	if config.Name == "" {
		t.Error("Config should have Name")
	}
	if config.Port == 0 {
		t.Error("Config should have Port")
	}
	if config.Status == "" {
		t.Error("Config should have Status")
	}
	if config.CreatedAt.IsZero() {
		t.Error("Config should have CreatedAt")
	}
}
