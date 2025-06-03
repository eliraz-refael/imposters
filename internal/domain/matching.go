package domain

import "strings"

// MatchPath determines if a request path matches a route pattern and extracts parameters
// Pattern examples: "/users/{id}", "/posts/{postId}/comments/{commentId}", "/"
// Returns: (matches bool, parameters map[string]string)
func MatchPath(pattern, requestPath string) (bool, map[string]string) {
	// Handle root path special case
	if pattern == "/" && requestPath == "/" {
		return true, make(map[string]string)
	}

	// Clean and split paths
	patternParts := splitPath(pattern)
	pathParts := splitPath(requestPath)

	// Must have same number of parts to match
	if len(patternParts) != len(pathParts) {
		return false, nil
	}

	params := make(map[string]string)

	// Check each part
	for i, patternPart := range patternParts {
		if isParameter(patternPart) {
			// Extract parameter name and store value
			paramName := extractParameterName(patternPart)
			if paramName == "" {
				return false, nil // Invalid parameter format
			}
			params[paramName] = pathParts[i]
		} else {
			// Must match exactly for literal parts
			if patternPart != pathParts[i] {
				return false, nil
			}
		}
	}

	return true, params
}

// splitPath splits a path into parts, handling empty paths and extra slashes
func splitPath(path string) []string {
	// Handle empty or root path
	if path == "" || path == "/" {
		return []string{}
	}

	// Remove leading and trailing slashes, then split
	cleanPath := strings.Trim(path, "/")
	if cleanPath == "" {
		return []string{}
	}

	return strings.Split(cleanPath, "/")
}

// isParameter checks if a path part is a parameter (wrapped in curly braces)
func isParameter(part string) bool {
	return strings.HasPrefix(part, "{") && strings.HasSuffix(part, "}")
}

// extractParameterName extracts the parameter name from a parameter part
// Example: "{id}" -> "id", "{userId}" -> "userId"
func extractParameterName(part string) string {
	if !isParameter(part) {
		return ""
	}

	// Remove curly braces
	paramName := part[1 : len(part)-1]

	// Validate parameter name (not empty, no special chars)
	if paramName == "" || strings.Contains(paramName, " ") {
		return ""
	}

	return paramName
}

// MatchRoute checks if a request matches a route (method + path)
func MatchRoute(route Route, method, path string) (bool, map[string]string) {
	// Method must match exactly (case-insensitive)
	if !strings.EqualFold(route.Method, method) {
		return false, nil
	}

	// Check path pattern
	return MatchPath(route.Path, path)
}

// FindBestMatch finds the best matching route from a list of routes
// Returns the route, parameters, and whether a match was found
func FindBestMatch(routes []Route, method, path string) (Route, map[string]string, bool) {
	for _, route := range routes {
		if matches, params := MatchRoute(route, method, path); matches {
			return route, params, true
		}
	}

	return Route{}, nil, false
}
