package domain

import (
	"fmt"
	"strings"
	"testing"

	"pgregory.net/rapid"
)

// Property: Path matching should be symmetric
func TestMatchPathSymmetry(t *testing.T) {
	rapid.Check(t, func(t *rapid.T) {
		// Generate a simple pattern with 1-3 segments
		numSegments := rapid.IntRange(1, 3).Draw(t, "numSegments")
		segments := make([]string, numSegments)
		params := make(map[string]string)

		for i := range numSegments {
			if rapid.Bool().Draw(t, fmt.Sprintf("isParam_%d", i)) {
				// Create a parameter
				paramName := rapid.StringMatching(`[a-z]+`).Draw(t, fmt.Sprintf("paramName_%d", i))
				paramValue := rapid.StringMatching(`[a-zA-Z0-9]+`).Draw(t, fmt.Sprintf("paramValue_%d", i))
				segments[i] = "{" + paramName + "}"
				params[paramName] = paramValue
			} else {
				// Create a literal segment
				segments[i] = rapid.StringMatching(`[a-z]+`).Draw(t, fmt.Sprintf("literal_%d", i))
			}
		}

		pattern := "/" + strings.Join(segments, "/")

		// Build the matching path
		pathSegments := make([]string, numSegments)
		for i, segment := range segments {
			if isParameter(segment) {
				paramName := extractParameterName(segment)
				pathSegments[i] = params[paramName]
			} else {
				pathSegments[i] = segment
			}
		}
		path := "/" + strings.Join(pathSegments, "/")

		// Test the property
		matches, extractedParams := MatchPath(pattern, path)

		if !matches {
			t.Fatalf("Pattern %q should match constructed path %q", pattern, path)
		}

		// Verify parameter extraction
		for paramName, expectedValue := range params {
			if extractedValue, exists := extractedParams[paramName]; !exists {
				t.Fatalf("Parameter %q should be extracted", paramName)
			} else if extractedValue != expectedValue {
				t.Fatalf("Parameter %q: expected %q, got %q", paramName, expectedValue, extractedValue)
			}
		}
	})
}

// Property: Path matching should be deterministic
func TestMatchPathDeterministic(t *testing.T) {
	rapid.Check(t, func(t *rapid.T) {
		// Generate simple pattern and path
		pattern := "/" + rapid.StringMatching(`[a-z]+`).Draw(t, "segment1")
		if rapid.Bool().Draw(t, "hasParam") {
			paramName := rapid.StringMatching(`[a-z]+`).Draw(t, "paramName")
			pattern += "/{" + paramName + "}"
		}

		// Generate matching path
		segments := strings.Split(strings.Trim(pattern, "/"), "/")
		pathSegments := make([]string, len(segments))
		for i, segment := range segments {
			if isParameter(segment) {
				pathSegments[i] = rapid.StringMatching(`[a-zA-Z0-9]+`).Draw(t, fmt.Sprintf("paramValue_%d", i))
			} else {
				pathSegments[i] = segment
			}
		}
		path := "/" + strings.Join(pathSegments, "/")

		// Match twice - should get identical results
		matches1, params1 := MatchPath(pattern, path)
		matches2, params2 := MatchPath(pattern, path)

		if matches1 != matches2 {
			t.Fatalf("MatchPath should be deterministic: %v != %v", matches1, matches2)
		}

		if len(params1) != len(params2) {
			t.Fatalf("MatchPath should return same params: %v != %v", params1, params2)
		}

		for k, v1 := range params1 {
			if v2, exists := params2[k]; !exists || v1 != v2 {
				t.Fatalf("Parameter %q differs: %q != %q", k, v1, v2)
			}
		}
	})
}

// Property: Route parsing should be idempotent for valid routes
func TestParseRouteIdempotent(t *testing.T) {
	rapid.Check(t, func(t *rapid.T) {
		// Generate a potentially valid route
		path := "/" + rapid.StringMatching(`[a-z]+`).Draw(t, "path")
		method := rapid.SampledFrom([]string{"GET", "POST", "PUT", "DELETE"}).Draw(t, "method")
		status := rapid.IntRange(200, 599).Draw(t, "status")

		inputRoute := Route{
			Path:   path,
			Method: method,
			Response: Response{
				Status: status,
			},
		}

		// First parse
		parsed1, err1 := ParseRoute(inputRoute)
		if err1 != nil {
			t.Skip("Invalid route generated") // Skip invalid routes
		}

		// Second parse of the result
		parsed2, err2 := ParseRoute(parsed1)
		if err2 != nil {
			t.Fatalf("Re-parsing valid route should not fail: %v", err2)
		}

		// Property: Key fields should be identical after re-parsing
		if parsed1.Path != parsed2.Path {
			t.Fatalf("Path should be stable: %q != %q", parsed1.Path, parsed2.Path)
		}
		if parsed1.Method != parsed2.Method {
			t.Fatalf("Method should be stable: %q != %q", parsed1.Method, parsed2.Method)
		}
		if parsed1.Response.Status != parsed2.Response.Status {
			t.Fatalf("Status should be stable: %d != %d", parsed1.Response.Status, parsed2.Response.Status)
		}
	})
}

// Property: Parameter substitution should never leave placeholders when params are provided
func TestSubstituteParamsComplete(t *testing.T) {
	rapid.Check(t, func(t *rapid.T) {
		// Generate parameter names and values
		paramName := rapid.StringMatching(`[a-z]+`).Draw(t, "paramName")
		paramValue := rapid.StringMatching(`[a-zA-Z0-9]+`).Draw(t, "paramValue")

		params := map[string]string{paramName: paramValue}

		// Create a JSON template with this parameter
		template := map[string]interface{}{
			"id":      "{{" + paramName + "}}",
			"literal": rapid.StringMatching(`[a-zA-Z ]+`).Draw(t, "literal"),
		}

		result := SubstituteParams(template, params)

		// Property: Result should not contain the placeholder we provided a value for
		resultStr := fmt.Sprintf("%v", result)
		placeholder := "{{" + paramName + "}}"
		if strings.Contains(resultStr, placeholder) {
			t.Fatalf("Result should not contain placeholder %q after substitution", placeholder)
		}

		// Property: Result should contain the parameter value
		if !strings.Contains(resultStr, paramValue) {
			t.Fatalf("Result should contain parameter value %q", paramValue)
		}
	})
}

// Property: Route matching should respect method case-insensitivity
func TestMatchRouteCaseInsensitive(t *testing.T) {
	rapid.Check(t, func(t *rapid.T) {
		method := rapid.SampledFrom([]string{"GET", "POST", "PUT", "DELETE"}).Draw(t, "method")
		path := "/" + rapid.StringMatching(`[a-z]+`).Draw(t, "path")

		route := Route{
			Method: method,
			Path:   path,
		}

		// Test with various case combinations
		methods := []string{
			strings.ToUpper(method),
			strings.ToLower(method),
			strings.Title(method),
		}

		var results []bool

		for _, testMethod := range methods {
			matches, _ := MatchRoute(route, testMethod, path)
			results = append(results, matches)
		}

		// Property: All case variations should give same result
		for i := 1; i < len(results); i++ {
			if results[0] != results[i] {
				t.Fatalf("Method matching should be case-insensitive: %v != %v for methods %v",
					results[0], results[i], methods)
			}
		}
	})
}
