package domain

import (
	"reflect"
	"testing"
)

func TestMatchPath(t *testing.T) {
	tests := []struct {
		name        string
		pattern     string
		requestPath string
		wantMatch   bool
		wantParams  map[string]string
	}{
		{
			name:        "exact match root",
			pattern:     "/",
			requestPath: "/",
			wantMatch:   true,
			wantParams:  map[string]string{},
		},
		{
			name:        "exact match simple path",
			pattern:     "/users",
			requestPath: "/users",
			wantMatch:   true,
			wantParams:  map[string]string{},
		},
		{
			name:        "single parameter",
			pattern:     "/users/{id}",
			requestPath: "/users/123",
			wantMatch:   true,
			wantParams:  map[string]string{"id": "123"},
		},
		{
			name:        "multiple parameters",
			pattern:     "/posts/{postId}/comments/{commentId}",
			requestPath: "/posts/456/comments/789",
			wantMatch:   true,
			wantParams:  map[string]string{"postId": "456", "commentId": "789"},
		},
		{
			name:        "no match - different length",
			pattern:     "/users/{id}",
			requestPath: "/users",
			wantMatch:   false,
			wantParams:  nil,
		},
		{
			name:        "no match - literal mismatch",
			pattern:     "/users/{id}",
			requestPath: "/posts/123",
			wantMatch:   false,
			wantParams:  nil,
		},
		{
			name:        "no match - extra path segment",
			pattern:     "/users",
			requestPath: "/users/123",
			wantMatch:   false,
			wantParams:  nil,
		},
		{
			name:        "complex path with mixed parameters",
			pattern:     "/api/v1/users/{userId}/posts/{postId}",
			requestPath: "/api/v1/users/john/posts/my-first-post",
			wantMatch:   true,
			wantParams:  map[string]string{"userId": "john", "postId": "my-first-post"},
		},
		{
			name:        "handles trailing slashes in pattern",
			pattern:     "/users/{id}/",
			requestPath: "/users/123",
			wantMatch:   true, // Should match after normalization
			wantParams:  map[string]string{"id": "123"},
		},
		{
			name:        "handles trailing slashes in request",
			pattern:     "/users/{id}",
			requestPath: "/users/123/",
			wantMatch:   true, // Should match after normalization
			wantParams:  map[string]string{"id": "123"},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			gotMatch, gotParams := MatchPath(tt.pattern, tt.requestPath)

			if gotMatch != tt.wantMatch {
				t.Errorf("MatchPath() match = %v, want %v", gotMatch, tt.wantMatch)
			}

			if !reflect.DeepEqual(gotParams, tt.wantParams) {
				t.Errorf("MatchPath() params = %v, want %v", gotParams, tt.wantParams)
			}
		})
	}
}

func TestSplitPath(t *testing.T) {
	tests := []struct {
		name string
		path string
		want []string
	}{
		{
			name: "root path",
			path: "/",
			want: []string{},
		},
		{
			name: "empty path",
			path: "",
			want: []string{},
		},
		{
			name: "simple path",
			path: "/users",
			want: []string{"users"},
		},
		{
			name: "path with multiple segments",
			path: "/api/v1/users",
			want: []string{"api", "v1", "users"},
		},
		{
			name: "path with trailing slash",
			path: "/users/",
			want: []string{"users"},
		},
		{
			name: "path with leading and trailing slashes",
			path: "/api/users/",
			want: []string{"api", "users"},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := splitPath(tt.path)
			if !reflect.DeepEqual(got, tt.want) {
				t.Errorf("splitPath() = %v, want %v", got, tt.want)
			}
		})
	}
}

func TestIsParameter(t *testing.T) {
	tests := []struct {
		name string
		part string
		want bool
	}{
		{
			name: "valid parameter",
			part: "{id}",
			want: true,
		},
		{
			name: "valid parameter with longer name",
			part: "{userId}",
			want: true,
		},
		{
			name: "not a parameter - literal",
			part: "users",
			want: false,
		},
		{
			name: "not a parameter - missing closing brace",
			part: "{id",
			want: false,
		},
		{
			name: "not a parameter - missing opening brace",
			part: "id}",
			want: false,
		},
		{
			name: "empty string",
			part: "",
			want: false,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := isParameter(tt.part)
			if got != tt.want {
				t.Errorf("isParameter() = %v, want %v", got, tt.want)
			}
		})
	}
}

func TestExtractParameterName(t *testing.T) {
	tests := []struct {
		name string
		part string
		want string
	}{
		{
			name: "valid parameter",
			part: "{id}",
			want: "id",
		},
		{
			name: "valid parameter with longer name",
			part: "{userId}",
			want: "userId",
		},
		{
			name: "not a parameter",
			part: "users",
			want: "",
		},
		{
			name: "empty parameter",
			part: "{}",
			want: "",
		},
		{
			name: "parameter with space - invalid",
			part: "{user id}",
			want: "",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := extractParameterName(tt.part)
			if got != tt.want {
				t.Errorf("extractParameterName() = %v, want %v", got, tt.want)
			}
		})
	}
}

func TestMatchRoute(t *testing.T) {
	route := Route{
		Method: "GET",
		Path:   "/users/{id}",
	}

	tests := []struct {
		name        string
		method      string
		path        string
		wantMatch   bool
		wantParams  map[string]string
	}{
		{
			name:       "exact match",
			method:     "GET",
			path:       "/users/123",
			wantMatch:  true,
			wantParams: map[string]string{"id": "123"},
		},
		{
			name:       "case insensitive method",
			method:     "get",
			path:       "/users/123",
			wantMatch:  true,
			wantParams: map[string]string{"id": "123"},
		},
		{
			name:       "wrong method",
			method:     "POST",
			path:       "/users/123",
			wantMatch:  false,
			wantParams: nil,
		},
		{
			name:       "wrong path",
			method:     "GET",
			path:       "/posts/123",
			wantMatch:  false,
			wantParams: nil,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			gotMatch, gotParams := MatchRoute(route, tt.method, tt.path)

			if gotMatch != tt.wantMatch {
				t.Errorf("MatchRoute() match = %v, want %v", gotMatch, tt.wantMatch)
			}

			if !reflect.DeepEqual(gotParams, tt.wantParams) {
				t.Errorf("MatchRoute() params = %v, want %v", gotParams, tt.wantParams)
			}
		})
	}
}

func TestFindBestMatch(t *testing.T) {
	routes := []Route{
		{ID: "1", Method: "GET", Path: "/users"},
		{ID: "2", Method: "GET", Path: "/users/{id}"},
		{ID: "3", Method: "POST", Path: "/users"},
		{ID: "4", Method: "GET", Path: "/posts/{id}"},
	}

	tests := []struct {
		name       string
		method     string
		path       string
		wantFound  bool
		wantRouteID string
		wantParams map[string]string
	}{
		{
			name:        "find exact match",
			method:      "GET",
			path:        "/users",
			wantFound:   true,
			wantRouteID: "1",
			wantParams:  map[string]string{},
		},
		{
			name:        "find parameterized match",
			method:      "GET",
			path:        "/users/123",
			wantFound:   true,
			wantRouteID: "2",
			wantParams:  map[string]string{"id": "123"},
		},
		{
			name:        "find by method and path",
			method:      "POST",
			path:        "/users",
			wantFound:   true,
			wantRouteID: "3",
			wantParams:  map[string]string{},
		},
		{
			name:       "no match found",
			method:     "DELETE",
			path:       "/users/123",
			wantFound:  false,
			wantParams: nil,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			gotRoute, gotParams, gotFound := FindBestMatch(routes, tt.method, tt.path)

			if gotFound != tt.wantFound {
				t.Errorf("FindBestMatch() found = %v, want %v", gotFound, tt.wantFound)
			}

			if gotFound && gotRoute.ID != tt.wantRouteID {
				t.Errorf("FindBestMatch() route ID = %v, want %v", gotRoute.ID, tt.wantRouteID)
			}

			if !reflect.DeepEqual(gotParams, tt.wantParams) {
				t.Errorf("FindBestMatch() params = %v, want %v", gotParams, tt.wantParams)
			}
		})
	}
}
