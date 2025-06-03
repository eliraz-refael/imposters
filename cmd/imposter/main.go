package main

import (
	"flag"
	"fmt"
	"os"

	"imposters/internal/domain"
	"imposters/internal/http"
	"imposters/internal/logging"
)

// Version information (set by build)
var (
	version   = "dev"
	buildTime = "unknown"
	gitCommit = "unknown"
)

func main() {
	// Command line flags
	var (
		showVersion = flag.Bool("version", false, "Show version information")
		port        = flag.Int("port", 3001, "Port to listen on")
		name        = flag.String("name", "example-imposter", "Imposter name")
	)
	flag.Parse()

	// Show version and exit
	if *showVersion {
		fmt.Printf("Imposter Mock Server\n")
		fmt.Printf("Version: %s\n", version)
		fmt.Printf("Build Time: %s\n", buildTime)
		fmt.Printf("Git Commit: %s\n", gitCommit)
		os.Exit(0)
	}

	// Setup global logger
	logger := logging.NewGlobalLogger()

	config := domain.ImposterConfig{
		ID:   domain.GenerateShortID(),
		Name: *name,
		Port: *port,
	}

	server, err := http.NewServer(config)
	if err != nil {
		logger.WithError(err).Fatal("Failed to create server")
	}

	logger.WithFields(map[string]interface{}{
		"name":    config.Name,
		"port":    config.Port,
		"id":      config.ID,
		"version": version,
	}).Info("Starting imposter")

	logger.Infof("Admin endpoints: http://localhost:%d/admin", config.Port)

	if err := server.Start(); err != nil {
		logger.WithError(err).Fatal("Server failed to start")
	}
}
