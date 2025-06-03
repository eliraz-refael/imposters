package domain

import (
	"reflect"
	"testing"
)

func TestParseRoute(t *testing.T) {
	tests := []struct {
		name    string
		input   Route
		want    Route
		wantErr bool
	}{
		{
			name: "minimal valid route",
			input: Route{
				Path: "/users",
			},
			want: Route{
				Path:     "/users",
				Method:   "GET",
				Response: Response{Status: 200},
			},
			wantErr: false,
		},
		{
			name: "complete route with all fields",
			input: Route{
				ID:     "test-123",
				Path:   "/users/{id}",
				Method: "post",
				Response: Response{
					Status: 201,
					Headers: map[string]string{"Content-Type": "application/json"},
					Body:    map[string]any{"message": "created"},
				},
				Delay: intPtr(100),
			},
			want: Route{
				ID:     "test-123",
				Path:   "/users/{id}",
				Method: "POST", // Should be normalized to uppercase
				Response: Response{
					Status:  201,
					Headers: map[string]string{"Content-Type": "application/json"},
					Body:    map[string]interface{}{"message": "created"},
				},
				Delay: intPtr(100),
			},
			wantErr: false,
		},
		{
			name: "empty path should error",
			input: Route{
				Path: "",
			},
			wantErr: true,
		},
		{
			name: "invalid HTTP method",
			input: Route{
				Path:   "/users",
				Method: "INVALID",
			},
			wantErr: true,
		},
		{
			name: "invalid status code - too low",
			input: Route{
				Path:     "/users",
				Response: Response{Status: 99},
			},
			wantErr: true,
		},
		{
			name: "invalid status code - too high",
			input: Route{
				Path:     "/users",
				Response: Response{Status: 600},
			},
			wantErr: true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := ParseRoute(tt.input)

			if (err != nil) != tt.wantErr {
				t.Errorf("ParseRoute() error = %v, wantErr %v", err, tt.wantErr)
				return
			}

			if tt.wantErr {
				return // Don't check the result if we expected an error
			}

			// Check all fields except ID and CreatedAt
			if got.Path != tt.want.Path {
				t.Errorf("ParseRoute() Path = %v, want %v", got.Path, tt.want.Path)
			}
			if got.Method != tt.want.Method {
				t.Errorf("ParseRoute() Method = %v, want %v", got.Method, tt.want.Method)
			}
			if got.Response.Status != tt.want.Response.Status {
				t.Errorf("ParseRoute() Response.Status = %v, want %v", got.Response.Status, tt.want.Response.Status)
			}
			if !reflect.DeepEqual(got.Response.Headers, tt.want.Response.Headers) {
				t.Errorf("ParseRoute() Response.Headers = %v, want %v", got.Response.Headers, tt.want.Response.Headers)
			}
			if !reflect.DeepEqual(got.Response.Body, tt.want.Response.Body) {
				t.Errorf("ParseRoute() Response.Body = %v, want %v", got.Response.Body, tt.want.Response.Body)
			}

			// Check that ID was generated if not provided
			if tt.input.ID == "" && got.ID == "" {
				t.Error("ParseRoute() should generate ID when not provided")
			}
			if tt.input.ID != "" && got.ID != tt.input.ID {
				t.Errorf("ParseRoute() should preserve provided ID, got %v, want %v", got.ID, tt.input.ID)
			}

			// Check that CreatedAt was set
			if got.CreatedAt.IsZero() {
				t.Error("ParseRoute() should set CreatedAt")
			}
		})
	}
}

func TestSubstituteParams(t *testing.T) {
	tests := []struct {
		name   string
		body   interface{}
		params map[string]string
		want   interface{}
	}{
		{
			name: "substitute single parameter",
			body: map[string]interface{}{
				"id":   "{{id}}",
				"name": "John",
			},
			params: map[string]string{"id": "123"},
			want: map[string]interface{}{
				"id":   "123",
				"name": "John",
			},
		},
		{
			name: "substitute multiple parameters",
			body: map[string]interface{}{
				"userId": "{{userId}}",
				"postId": "{{postId}}",
				"title":  "Post {{postId}} by user {{userId}}",
			},
			params: map[string]string{
				"userId": "john",
				"postId": "456",
			},
			want: map[string]interface{}{
				"userId": "john",
				"postId": "456",
				"title":  "Post 456 by user john",
			},
		},
		{
			name: "no parameters to substitute",
			body: map[string]interface{}{
				"message": "Hello, World!",
			},
			params: map[string]string{},
			want: map[string]interface{}{
				"message": "Hello, World!",
			},
		},
		{
			name:   "string body with parameters",
			body:   "User ID: {{id}}",
			params: map[string]string{"id": "789"},
			want:   "User ID: 789",
		},
		{
			name:   "parameter not found - no substitution",
			body:   "User ID: {{id}}",
			params: map[string]string{"otherId": "123"},
			want:   "User ID: {{id}}",
		},
		{
			name: "nested object with parameters",
			body: map[string]interface{}{
				"user": map[string]interface{}{
					"id":   "{{userId}}",
					"name": "{{userName}}",
				},
				"meta": map[string]interface{}{
					"requestId": "{{requestId}}",
				},
			},
			params: map[string]string{
				"userId":    "123",
				"userName":  "Alice",
				"requestId": "req-456",
			},
			want: map[string]interface{}{
				"user": map[string]interface{}{
					"id":   "123",
					"name": "Alice",
				},
				"meta": map[string]interface{}{
					"requestId": "req-456",
				},
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := SubstituteParams(tt.body, tt.params)
			if !reflect.DeepEqual(got, tt.want) {
				t.Errorf("SubstituteParams() = %v, want %v", got, tt.want)
			}
		})
	}
}

func TestValidateRoute(t *testing.T) {
	tests := []struct {
		name    string
		route   Route
		wantErr bool
	}{
		{
			name: "valid route",
			route: Route{
				Path:     "/users/{id}",
				Method:   "GET",
				Response: Response{Status: 200},
			},
			wantErr: false,
		},
		{
			name: "valid route with delay",
			route: Route{
				Path:     "/users",
				Method:   "POST",
				Response: Response{Status: 201},
				Delay:    intPtr(100),
			},
			wantErr: false,
		},
		{
			name: "empty path",
			route: Route{
				Path:     "",
				Method:   "GET",
				Response: Response{Status: 200},
			},
			wantErr: true,
		},
		{
			name: "empty method",
			route: Route{
				Path:     "/users",
				Method:   "",
				Response: Response{Status: 200},
			},
			wantErr: true,
		},
		{
			name: "zero status",
			route: Route{
				Path:     "/users",
				Method:   "GET",
				Response: Response{Status: 0},
			},
			wantErr: true,
		},
		{
			name: "negative delay",
			route: Route{
				Path:     "/users",
				Method:   "GET",
				Response: Response{Status: 200},
				Delay:    intPtr(-10),
			},
			wantErr: true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := ValidateRoute(tt.route)
			if (err != nil) != tt.wantErr {
				t.Errorf("ValidateRoute() error = %v, wantErr %v", err, tt.wantErr)
			}
		})
	}
}

func TestGenerateShortID(t *testing.T) {
	// Test that it generates non-empty IDs
	id1 := GenerateShortID()
	if id1 == "" {
		t.Error("GenerateShortID() should not return empty string")
	}

	// Test that it generates different IDs
	id2 := GenerateShortID()
	if id1 == id2 {
		t.Error("GenerateShortID() should generate unique IDs")
	}

	// Test that it generates 8-character IDs
	if len(id1) != 8 {
		t.Errorf("GenerateShortID() should generate 8-character IDs, got %d characters", len(id1))
	}
}

// Helper function to create int pointers for tests
func intPtr(i int) *int {
	return &i
}
