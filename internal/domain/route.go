package domain

import (
	"encoding/json"
	"fmt"
	"strings"
	"time"
)

// Route represents a mock API route configuration
type Route struct {
	ID        string            `json:"id,omitempty"`
	Path      string            `json:"path"`
	Method    string            `json:"method"`
	Response  Response          `json:"response"`
	Delay     *int              `json:"delay,omitempty"`
	CreatedAt time.Time         `json:"createdAt,omitempty"`
}

// Response represents the mock response configuration
type Response struct {
	Status  int                    `json:"status"`
	Headers map[string]string      `json:"headers,omitempty"`
	Body    interface{}            `json:"body"`
}

// ParseRoute validates and normalizes a route with defaults
func ParseRoute(input Route) (Route, error) {
	if input.Path == "" {
		return Route{}, fmt.Errorf("path is required")
	}

	// Generate ID if not provided
	if input.ID == "" {
		input.ID = GenerateShortID()
	}

	// Default method to GET
	if input.Method == "" {
		input.Method = "GET"
	}

	// Normalize method to uppercase
	input.Method = strings.ToUpper(input.Method)

	// Default status to 200
	if input.Response.Status == 0 {
		input.Response.Status = 200
	}

	// Set creation time
	if input.CreatedAt.IsZero() {
		input.CreatedAt = time.Now()
	}

	// Validate HTTP method
	validMethods := map[string]bool{
		"GET": true, "POST": true, "PUT": true, "DELETE": true,
		"PATCH": true, "HEAD": true, "OPTIONS": true,
	}

	if !validMethods[input.Method] {
		return Route{}, fmt.Errorf("invalid HTTP method: %s", input.Method)
	}

	// Validate status code
	if input.Response.Status < 100 || input.Response.Status > 599 {
		return Route{}, fmt.Errorf("invalid HTTP status code: %d", input.Response.Status)
	}

	return input, nil
}

// SubstituteParams replaces path parameters in the response body
// For example: {"id": "{{id}}"} with params {"id": "123"} becomes {"id": "123"}
func SubstituteParams(body interface{}, params map[string]string) interface{} {
	// Convert body to JSON string for parameter substitution
	bodyBytes, err := json.Marshal(body)
	if err != nil {
		return body
	}

	bodyStr := string(bodyBytes)

	// Replace all parameter placeholders
	for key, value := range params {
		placeholder := fmt.Sprintf("{{%s}}", key)
		bodyStr = strings.ReplaceAll(bodyStr, placeholder, value)
	}

	// Try to parse back to structured data
	var result interface{}
	if err := json.Unmarshal([]byte(bodyStr), &result); err != nil {
		// If parsing fails, return as string
		return bodyStr
	}

	return result
}

// ValidateRoute performs additional validation on a complete route
func ValidateRoute(route Route) error {
	if route.Path == "" {
		return fmt.Errorf("path cannot be empty")
	}

	if route.Method == "" {
		return fmt.Errorf("method cannot be empty")
	}

	if route.Response.Status == 0 {
		return fmt.Errorf("response status cannot be zero")
	}

	// Validate delay if provided
	if route.Delay != nil && *route.Delay < 0 {
		return fmt.Errorf("delay cannot be negative")
	}

	return nil
}
