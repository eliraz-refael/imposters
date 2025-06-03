package storage

import (
	"reflect"
	"sync"
	"testing"
	"fmt"

	"imposters/internal/domain"
)

func TestRouteStore_Add(t *testing.T) {
	store := NewRouteStore()
	route := domain.Route{
		ID:     "test-1",
		Path:   "/users/{id}",
		Method: "GET",
	}

	store.Add(route)

	// Verify route was added
	retrieved, exists := store.Get("test-1")
	if !exists {
		t.Error("Route should exist after adding")
	}
	if retrieved.ID != route.ID {
		t.Errorf("Retrieved route ID = %v, want %v", retrieved.ID, route.ID)
	}
}

func TestRouteStore_Get(t *testing.T) {
	store := NewRouteStore()
	route := domain.Route{
		ID:     "test-1",
		Path:   "/users/{id}",
		Method: "GET",
	}

	// Test getting non-existent route
	_, exists := store.Get("non-existent")
	if exists {
		t.Error("Non-existent route should not exist")
	}

	// Add route and test getting it
	store.Add(route)
	retrieved, exists := store.Get("test-1")
	if !exists {
		t.Error("Route should exist after adding")
	}
	if !reflect.DeepEqual(retrieved, route) {
		t.Errorf("Retrieved route = %v, want %v", retrieved, route)
	}
}

func TestRouteStore_Remove(t *testing.T) {
	store := NewRouteStore()
	route := domain.Route{
		ID:     "test-1",
		Path:   "/users/{id}",
		Method: "GET",
	}

	// Test removing non-existent route
	removed := store.Remove("non-existent")
	if removed {
		t.Error("Removing non-existent route should return false")
	}

	// Add route and test removing it
	store.Add(route)
	removed = store.Remove("test-1")
	if !removed {
		t.Error("Removing existing route should return true")
	}

	// Verify route is gone
	_, exists := store.Get("test-1")
	if exists {
		t.Error("Route should not exist after removal")
	}
}

func TestRouteStore_Update(t *testing.T) {
	store := NewRouteStore()
	originalRoute := domain.Route{
		ID:     "test-1",
		Path:   "/users/{id}",
		Method: "GET",
	}

	updatedRoute := domain.Route{
		ID:     "test-1",
		Path:   "/users/{id}",
		Method: "POST", // Changed method
	}

	// Test updating non-existent route
	updated := store.Update("non-existent", updatedRoute)
	if updated {
		t.Error("Updating non-existent route should return false")
	}

	// Add route and test updating it
	store.Add(originalRoute)
	updated = store.Update("test-1", updatedRoute)
	if !updated {
		t.Error("Updating existing route should return true")
	}

	// Verify route was updated
	retrieved, exists := store.Get("test-1")
	if !exists {
		t.Error("Route should still exist after update")
	}
	if retrieved.Method != "POST" {
		t.Errorf("Route method should be updated to POST, got %v", retrieved.Method)
	}
	if retrieved.ID != "test-1" {
		t.Errorf("Route ID should be preserved, got %v", retrieved.ID)
	}
}

func TestRouteStore_List(t *testing.T) {
	store := NewRouteStore()

	// Test empty store
	routes := store.List()
	if len(routes) != 0 {
		t.Errorf("Empty store should return empty list, got %d routes", len(routes))
	}

	// Add some routes
	route1 := domain.Route{ID: "1", Path: "/users", Method: "GET"}
	route2 := domain.Route{ID: "2", Path: "/posts", Method: "GET"}
	route3 := domain.Route{ID: "3", Path: "/users/{id}", Method: "GET"}

	store.Add(route1)
	store.Add(route2)
	store.Add(route3)

	routes = store.List()
	if len(routes) != 3 {
		t.Errorf("Store should contain 3 routes, got %d", len(routes))
	}

	// Verify all routes are present (order may vary)
	foundIDs := make(map[string]bool)
	for _, route := range routes {
		foundIDs[route.ID] = true
	}

	expectedIDs := []string{"1", "2", "3"}
	for _, expectedID := range expectedIDs {
		if !foundIDs[expectedID] {
			t.Errorf("Route ID %v should be in list", expectedID)
		}
	}
}

func TestRouteStore_Clear(t *testing.T) {
	store := NewRouteStore()

	// Test clearing empty store
	count := store.Clear()
	if count != 0 {
		t.Errorf("Clearing empty store should return 0, got %d", count)
	}

	// Add some routes and clear
	route1 := domain.Route{ID: "1", Path: "/users", Method: "GET"}
	route2 := domain.Route{ID: "2", Path: "/posts", Method: "GET"}

	store.Add(route1)
	store.Add(route2)

	count = store.Clear()
	if count != 2 {
		t.Errorf("Clearing store with 2 routes should return 2, got %d", count)
	}

	// Verify store is empty
	routes := store.List()
	if len(routes) != 0 {
		t.Errorf("Store should be empty after clear, got %d routes", len(routes))
	}
}

func TestRouteStore_Count(t *testing.T) {
	store := NewRouteStore()

	// Test empty store
	if store.Count() != 0 {
		t.Errorf("Empty store should have count 0, got %d", store.Count())
	}

	// Add routes and test count
	route1 := domain.Route{ID: "1", Path: "/users", Method: "GET"}
	route2 := domain.Route{ID: "2", Path: "/posts", Method: "GET"}

	store.Add(route1)
	if store.Count() != 1 {
		t.Errorf("Store should have count 1, got %d", store.Count())
	}

	store.Add(route2)
	if store.Count() != 2 {
		t.Errorf("Store should have count 2, got %d", store.Count())
	}

	store.Remove("1")
	if store.Count() != 1 {
		t.Errorf("Store should have count 1 after removal, got %d", store.Count())
	}
}

func TestRouteStore_Exists(t *testing.T) {
	store := NewRouteStore()
	route := domain.Route{ID: "test-1", Path: "/users", Method: "GET"}

	// Test non-existent route
	if store.Exists("test-1") {
		t.Error("Route should not exist initially")
	}

	// Add route and test existence
	store.Add(route)
	if !store.Exists("test-1") {
		t.Error("Route should exist after adding")
	}

	// Remove route and test non-existence
	store.Remove("test-1")
	if store.Exists("test-1") {
		t.Error("Route should not exist after removal")
	}
}

func TestRouteStore_FindMatch(t *testing.T) {
	store := NewRouteStore()

	// Add test routes
	routes := []domain.Route{
		{ID: "1", Method: "GET", Path: "/users"},
		{ID: "2", Method: "GET", Path: "/users/{id}"},
		{ID: "3", Method: "POST", Path: "/users"},
		{ID: "4", Method: "GET", Path: "/posts/{id}"},
	}

	for _, route := range routes {
		store.Add(route)
	}

	tests := []struct {
		name        string
		method      string
		path        string
		wantFound   bool
		wantRouteID string
		wantParams  map[string]string
	}{
		{
			name:        "exact match",
			method:      "GET",
			path:        "/users",
			wantFound:   true,
			wantRouteID: "1",
			wantParams:  map[string]string{},
		},
		{
			name:        "parameterized match",
			method:      "GET",
			path:        "/users/123",
			wantFound:   true,
			wantRouteID: "2",
			wantParams:  map[string]string{"id": "123"},
		},
		{
			name:        "method and path match",
			method:      "POST",
			path:        "/users",
			wantFound:   true,
			wantRouteID: "3",
			wantParams:  map[string]string{},
		},
		{
			name:        "different endpoint with parameter",
			method:      "GET",
			path:        "/posts/456",
			wantFound:   true,
			wantRouteID: "4",
			wantParams:  map[string]string{"id": "456"},
		},
		{
			name:       "no match - wrong method",
			method:     "DELETE",
			path:       "/users",
			wantFound:  false,
			wantParams: nil,
		},
		{
			name:       "no match - wrong path",
			method:     "GET",
			path:       "/nonexistent",
			wantFound:  false,
			wantParams: nil,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			gotRoute, gotParams, gotFound := store.FindMatch(tt.method, tt.path)

			if gotFound != tt.wantFound {
				t.Errorf("FindMatch() found = %v, want %v", gotFound, tt.wantFound)
			}

			if gotFound && gotRoute.ID != tt.wantRouteID {
				t.Errorf("FindMatch() route ID = %v, want %v", gotRoute.ID, tt.wantRouteID)
			}

			if !reflect.DeepEqual(gotParams, tt.wantParams) {
				t.Errorf("FindMatch() params = %v, want %v", gotParams, tt.wantParams)
			}
		})
	}
}

func TestRouteStore_GetByMethodAndPath(t *testing.T) {
	store := NewRouteStore()

	// Add test routes including duplicates
	routes := []domain.Route{
		{ID: "1", Method: "GET", Path: "/users"},
		{ID: "2", Method: "GET", Path: "/users/{id}"},
		{ID: "3", Method: "POST", Path: "/users"},
		{ID: "4", Method: "GET", Path: "/users"}, // Duplicate of route 1
	}

	for _, route := range routes {
		store.Add(route)
	}

	tests := []struct {
		name       string
		method     string
		path       string
		wantCount  int
		wantRouteIDs []string
	}{
		{
			name:         "single match",
			method:       "POST",
			path:         "/users",
			wantCount:    1,
			wantRouteIDs: []string{"3"},
		},
		{
			name:         "multiple matches (duplicates)",
			method:       "GET",
			path:         "/users",
			wantCount:    2,
			wantRouteIDs: []string{"1", "4"}, // Order may vary
		},
		{
			name:         "no matches",
			method:       "DELETE",
			path:         "/users",
			wantCount:    0,
			wantRouteIDs: []string{},
		},
		{
			name:         "parameterized path - single match",
			method:       "GET",
			path:         "/users/{id}",
			wantCount:    1,
			wantRouteIDs: []string{"2"},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			gotRoutes := store.GetByMethodAndPath(tt.method, tt.path)

			if len(gotRoutes) != tt.wantCount {
				t.Errorf("GetByMethodAndPath() count = %v, want %v", len(gotRoutes), tt.wantCount)
			}

			if tt.wantCount > 0 {
				gotIDs := make([]string, len(gotRoutes))
				for i, route := range gotRoutes {
					gotIDs[i] = route.ID
				}

				// Check that all expected IDs are present
				for _, expectedID := range tt.wantRouteIDs {
					found := false
					for _, gotID := range gotIDs {
						if gotID == expectedID {
							found = true
							break
						}
					}
					if !found {
						t.Errorf("Expected route ID %v not found in results", expectedID)
					}
				}
			}
		})
	}
}

// TestRouteStore_Concurrency tests thread safety
func TestRouteStore_Concurrency(t *testing.T) {
	store := NewRouteStore()
	const numGoroutines = 10
	const numOperations = 100

	var wg sync.WaitGroup

	// Start multiple goroutines performing concurrent operations
	for i := 0; i < numGoroutines; i++ {
		wg.Add(1)
		go func(routineID int) {
			defer wg.Done()

			for j := 0; j < numOperations; j++ {
				routeID := fmt.Sprintf("route-%d-%d", routineID, j)
				route := domain.Route{
					ID:     routeID,
					Path:   fmt.Sprintf("/test/%d/%d", routineID, j),
					Method: "GET",
				}

				// Add route
				store.Add(route)

				// Read operations
				store.Get(routeID)
				store.Exists(routeID)
				store.List()
				store.Count()
				store.FindMatch("GET", route.Path)

				// Update route
				route.Method = "POST"
				store.Update(routeID, route)

				// Remove route
				store.Remove(routeID)
			}
		}(i)
	}

	wg.Wait()

	// Verify store is in a consistent state
	count := store.Count()
	routes := store.List()
	if len(routes) != count {
		t.Errorf("Inconsistent state: Count() = %d, len(List()) = %d", count, len(routes))
	}
}
