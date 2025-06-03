package http

import (
	"fmt"
	"net/http"
	"time"

	"github.com/gin-gonic/gin"
	"imposters/internal/domain"
)

// Admin Handlers for route management

// addRouteHandler handles POST /admin/routes
func (s *Server) addRouteHandler() gin.HandlerFunc {
	return func(c *gin.Context) {
		var input domain.Route
		if err := c.ShouldBindJSON(&input); err != nil {
			s.logger.WithError(err).Warn("Invalid route JSON")
			c.JSON(http.StatusBadRequest, gin.H{
				"error": gin.H{
					"code":    "INVALID_JSON",
					"message": "Invalid JSON format",
					"details": gin.H{"error": err.Error()},
				},
			})
			return
		}

		// Parse and validate the route
		route, err := domain.ParseRoute(input)
		if err != nil {
			s.logger.WithError(err).Warn("Invalid route configuration")
			c.JSON(http.StatusBadRequest, gin.H{
				"error": gin.H{
					"code":    "INVALID_ROUTE",
					"message": err.Error(),
				},
			})
			return
		}

		// Check for existing routes with same method/path (potential conflicts)
		existing := s.store.GetByMethodAndPath(route.Method, route.Path)
		if len(existing) > 0 {
			s.logger.WithFields(map[string]interface{}{
				"method": route.Method,
				"path":   route.Path,
				"existing_count": len(existing),
			}).Warn("Route pattern already exists")
			// Note: We allow duplicates but warn about them
		}

		// Store the route
		s.store.Add(route)

		s.logger.WithFields(map[string]interface{}{
			"route_id": route.ID,
			"method":   route.Method,
			"path":     route.Path,
			"status":   route.Response.Status,
		}).Infof("Route added: %s %s -> %d", route.Method, route.Path, route.Response.Status)

		c.JSON(http.StatusCreated, gin.H{
			"id":      route.ID,
			"message": "Route added successfully",
		})
	}
}

// listRoutesHandler handles GET /admin/routes
func (s *Server) listRoutesHandler() gin.HandlerFunc {
	return func(c *gin.Context) {
		routes := s.store.List()

		c.JSON(http.StatusOK, gin.H{
			"routes": routes,
		})
	}
}

// getRouteHandler handles GET /admin/routes/:id
func (s *Server) getRouteHandler() gin.HandlerFunc {
	return func(c *gin.Context) {
		id := c.Param("id")

		route, exists := s.store.Get(id)
		if !exists {
			c.JSON(http.StatusNotFound, gin.H{
				"error": gin.H{
					"code":    "ROUTE_NOT_FOUND",
					"message": "Route not found",
					"details": gin.H{"id": id},
				},
			})
			return
		}

		c.JSON(http.StatusOK, route)
	}
}

// updateRouteHandler handles PUT /admin/routes/:id
func (s *Server) updateRouteHandler() gin.HandlerFunc {
	return func(c *gin.Context) {
		id := c.Param("id")

		// Check if route exists
		if !s.store.Exists(id) {
			c.JSON(http.StatusNotFound, gin.H{
				"error": gin.H{
					"code":    "ROUTE_NOT_FOUND",
					"message": "Route not found",
					"details": gin.H{"id": id},
				},
			})
			return
		}

		var input domain.Route
		if err := c.ShouldBindJSON(&input); err != nil {
			s.logger.WithError(err).Warn("Invalid route JSON for update")
			c.JSON(http.StatusBadRequest, gin.H{
				"error": gin.H{
					"code":    "INVALID_JSON",
					"message": "Invalid JSON format",
					"details": gin.H{"error": err.Error()},
				},
			})
			return
		}

		// Parse and validate the updated route
		input.ID = id // Ensure ID stays the same
		route, err := domain.ParseRoute(input)
		if err != nil {
			s.logger.WithError(err).Warn("Invalid route configuration for update")
			c.JSON(http.StatusBadRequest, gin.H{
				"error": gin.H{
					"code":    "INVALID_ROUTE",
					"message": err.Error(),
				},
			})
			return
		}

		// Update the route
		if updated := s.store.Update(id, route); !updated {
			c.JSON(http.StatusInternalServerError, gin.H{
				"error": gin.H{
					"code":    "UPDATE_FAILED",
					"message": "Failed to update route",
				},
			})
			return
		}

		s.logger.WithFields(map[string]interface{}{
			"route_id": route.ID,
			"method":   route.Method,
			"path":     route.Path,
		}).Info("Route updated")

		c.JSON(http.StatusOK, gin.H{
			"id":      route.ID,
			"message": "Route updated successfully",
		})
	}
}

// deleteRouteHandler handles DELETE /admin/routes/:id
func (s *Server) deleteRouteHandler() gin.HandlerFunc {
	return func(c *gin.Context) {
		id := c.Param("id")

		if removed := s.store.Remove(id); !removed {
			c.JSON(http.StatusNotFound, gin.H{
				"error": gin.H{
					"code":    "ROUTE_NOT_FOUND",
					"message": "Route not found",
					"details": gin.H{"id": id},
				},
			})
			return
		}

		s.logger.WithField("route_id", id).Info("Route deleted")

		c.JSON(http.StatusOK, gin.H{
			"message": "Route deleted successfully",
			"id":      id,
		})
	}
}

// clearRoutesHandler handles DELETE /admin/routes
func (s *Server) clearRoutesHandler() gin.HandlerFunc {
	return func(c *gin.Context) {
		count := s.store.Clear()

		s.logger.WithField("count", count).Info("All routes cleared")

		c.JSON(http.StatusOK, gin.H{
			"message": fmt.Sprintf("All routes cleared successfully (%d deleted)", count),
			"count":   count,
		})
	}
}

// imposterInfoHandler handles GET /admin/info
func (s *Server) imposterInfoHandler() gin.HandlerFunc {
	return func(c *gin.Context) {
		uptime := s.GetUptime()

		c.JSON(http.StatusOK, gin.H{
			"id":         s.config.ID,
			"name":       s.config.Name,
			"port":       s.config.Port,
			"routeCount": s.GetRouteCount(),
			"uptime":     formatUptime(uptime),
		})
	}
}

// Mock Response Handler

// mockResponseHandler handles all non-admin requests for mock responses
func (s *Server) mockResponseHandler() gin.HandlerFunc {
	return func(c *gin.Context) {
		method := c.Request.Method
		path := c.Request.URL.Path

		// Find matching route
		route, params, found := s.store.FindMatch(method, path)
		if !found {
			// No matching route found
			c.JSON(http.StatusNotFound, gin.H{
				"error": gin.H{
					"code":    "NO_ROUTE_MATCH",
					"message": "No matching route found",
					"details": gin.H{
						"method": method,
						"path":   path,
					},
				},
			})
			return
		}

		// Apply delay if configured
		if route.Delay != nil && *route.Delay > 0 {
			time.Sleep(time.Duration(*route.Delay) * time.Millisecond)
		}

		// Substitute parameters in response body
		responseBody := domain.SubstituteParams(route.Response.Body, params)

		// Set custom headers if provided
		if route.Response.Headers != nil {
			for key, value := range route.Response.Headers {
				c.Header(key, value)
			}
		}

		// Send response
		c.JSON(route.Response.Status, responseBody)
	}
}

// Utility functions

// formatUptime formats a duration into a human-readable string
func formatUptime(d time.Duration) string {
	hours := int(d.Hours())
	minutes := int(d.Minutes()) % 60
	seconds := int(d.Seconds()) % 60

	return fmt.Sprintf("%02d:%02d:%02d", hours, minutes, seconds)
}
