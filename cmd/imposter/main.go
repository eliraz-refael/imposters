package main

import (
	"imposters/internal/domain"
	"imposters/internal/http"
	"imposters/internal/logging"
)

func main() {
	// Setup global logger
	logger := logging.NewGlobalLogger()

	config := domain.ImposterConfig{
		ID:   domain.GenerateShortID(),
		Name: "example-imposter",
		Port: 3001,
	}

	server, err := http.NewServer(config)
	if err != nil {
		logger.WithError(err).Fatal("Failed to create server")
	}

	logger.WithFields(map[string]interface{}{
		"name": config.Name,
		"port": config.Port,
		"id":   config.ID,
	}).Info("Starting imposter")

	logger.Infof("Admin endpoints: http://localhost:%d/admin", config.Port)

	if err := server.Start(); err != nil {
		logger.WithError(err).Fatal("Server failed to start")
	}
}
