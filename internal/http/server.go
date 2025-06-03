package http

import (
	"fmt"
	"time"

	"github.com/gin-gonic/gin"
	"imposters/internal/domain"
	"imposters/internal/logging"
	"imposters/internal/storage"
)

// Server represents an individual imposter server
type Server struct {
	config    domain.ImposterConfig
	store     *storage.RouteStore
	logger    *logging.Logger
	engine    *gin.Engine
	startTime time.Time
}

// NewServer creates a new imposter server with the given configuration
func NewServer(config domain.ImposterConfig) (*Server, error) {
	// Initialize components
	store := storage.NewRouteStore()
	logger := logging.NewLogger(config.Name, config.Port)
	startTime := time.Now()

	// Configure Gin
	gin.SetMode(gin.ReleaseMode)
	engine := gin.New()

	// Create server instance
	server := &Server{
		config:    config,
		store:     store,
		logger:    logger,
		engine:    engine,
		startTime: startTime,
	}

	// Setup middleware and routes
	server.setupMiddleware()
	server.setupRoutes()

	// Log server startup
	server.logger.WithFields(map[string]interface{}{
		"id":   config.ID,
		"name": config.Name,
		"port": config.Port,
	}).Infof("Started imposter (id: %s)", config.ID)

	return server, nil
}

// setupMiddleware configures Gin middleware
func (s *Server) setupMiddleware() {
	// Custom recovery middleware
	s.engine.Use(gin.CustomRecovery(func(c *gin.Context, recovered interface{}) {
		s.logger.WithFields(map[string]interface{}{
			"error": recovered,
			"path":  c.Request.URL.Path,
			"method": c.Request.Method,
		}).Error("Panic recovered")
		c.JSON(500, gin.H{"error": "Internal server error"})
	}))

	// Request logging middleware
	s.engine.Use(s.requestLoggingMiddleware())
}

// requestLoggingMiddleware logs incoming requests and responses
func (s *Server) requestLoggingMiddleware() gin.HandlerFunc {
	return func(c *gin.Context) {
		start := time.Now()

		// Log incoming request
		s.logger.InfoRequest(c.Request.Method, c.Request.URL.Path, c.ClientIP())

		// Process request
		c.Next()

		// Log response
		duration := time.Since(start)
		status := c.Writer.Status()
		size := c.Writer.Size()

		if status == 404 && !isAdminPath(c.Request.URL.Path) {
			// Log 404s for non-admin paths as warnings
			s.logger.WarnNoRoute(c.Request.Method, c.Request.URL.Path, duration.String())
		} else {
			s.logger.InfoResponse(status, c.Request.Method, c.Request.URL.Path, int64(size), duration.String())
		}
	}
}

// isAdminPath checks if a path is an admin endpoint
func isAdminPath(path string) bool {
	return len(path) >= 6 && path[:6] == "/admin"
}

// setupRoutes configures all server routes
func (s *Server) setupRoutes() {
	// Admin endpoints group
	admin := s.engine.Group("/admin")
	{
		admin.POST("/routes", s.addRouteHandler())
		admin.GET("/routes", s.listRoutesHandler())
		admin.GET("/routes/:id", s.getRouteHandler())
		admin.PUT("/routes/:id", s.updateRouteHandler())
		admin.DELETE("/routes/:id", s.deleteRouteHandler())
		admin.DELETE("/routes", s.clearRoutesHandler())
		admin.GET("/info", s.imposterInfoHandler())
	}

	// Catch-all for mock responses
	s.engine.NoRoute(s.mockResponseHandler())
}

// Start begins listening on the configured port
func (s *Server) Start() error {
	addr := fmt.Sprintf(":%d", s.config.Port)
	s.logger.Infof("Listening on %s", addr)
	return s.engine.Run(addr)
}

// Stop gracefully shuts down the server (placeholder for future implementation)
func (s *Server) Stop() error {
	s.logger.Info("Shutting down imposter")
	return nil
}

// GetConfig returns the server configuration
func (s *Server) GetConfig() domain.ImposterConfig {
	return s.config
}

// GetRouteCount returns the current number of configured routes
func (s *Server) GetRouteCount() int {
	return s.store.Count()
}

// GetUptime returns how long the server has been running
func (s *Server) GetUptime() time.Duration {
	return time.Since(s.startTime)
}

// Health check endpoint (could be useful for monitoring)
func (s *Server) healthHandler() gin.HandlerFunc {
	return func(c *gin.Context) {
		c.JSON(200, gin.H{
			"status": "healthy",
			"uptime": s.GetUptime().String(),
			"routes": s.GetRouteCount(),
		})
	}
}
