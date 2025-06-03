package domain

import (
	"time"

	"github.com/google/uuid"
)

// ImposterConfig holds the configuration for an individual imposter server
type ImposterConfig struct {
	ID        string    `json:"id"`
	Name      string    `json:"name"`
	Port      int       `json:"port"`
	Status    string    `json:"status,omitempty"`
	CreatedAt time.Time `json:"createdAt,omitempty"`
}

// GenerateShortID creates a short UUID for imposter identification
func GenerateShortID() string {
	return uuid.New().String()[:8]
}

// NewImposterConfig creates a new imposter configuration with defaults
func NewImposterConfig(name string, port int) ImposterConfig {
	id := GenerateShortID()

	// If no name provided, use the ID
	if name == "" {
		name = id
	}

	return ImposterConfig{
		ID:        id,
		Name:      name,
		Port:      port,
		Status:    "running",
		CreatedAt: time.Now(),
	}
}
