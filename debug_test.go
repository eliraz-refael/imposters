package main

import (
	"fmt"
	"strings"
)

// Copy of our splitPath function to debug
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

func main() {
	testCases := []string{
		"/users/{id}/",
		"/users/123",
		"/users/{id}",
		"/users/123/",
		"/",
		"",
		"/api/v1/users",
		"/api/v1/users/",
	}

	for _, tc := range testCases {
		parts := splitPath(tc)
		fmt.Printf("Path: %-15s -> Parts: %v (len=%d)\n", fmt.Sprintf("%q", tc), parts, len(parts))
	}
}
