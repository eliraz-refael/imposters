package storage

import (
	"sync"

	"imposters/internal/domain"
)

// RouteStore provides thread-safe in-memory storage for routes
type RouteStore struct {
	routes map[string]domain.Route
	mu     sync.RWMutex
}

// NewRouteStore creates a new empty route store
func NewRouteStore() *RouteStore {
	return &RouteStore{
		routes: make(map[string]domain.Route),
	}
}

// Add stores a route in the store
func (s *RouteStore) Add(route domain.Route) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.routes[route.ID] = route
}

// Remove deletes a route by ID and returns whether it existed
func (s *RouteStore) Remove(id string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()

	if _, exists := s.routes[id]; exists {
		delete(s.routes, id)
		return true
	}
	return false
}

// Get retrieves a route by ID
func (s *RouteStore) Get(id string) (domain.Route, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	route, exists := s.routes[id]
	return route, exists
}

// Update modifies an existing route
func (s *RouteStore) Update(id string, route domain.Route) bool {
	s.mu.Lock()
	defer s.mu.Unlock()

	if _, exists := s.routes[id]; exists {
		// Ensure the ID stays the same
		route.ID = id
		s.routes[id] = route
		return true
	}
	return false
}

// List returns all routes as a slice
func (s *RouteStore) List() []domain.Route {
	s.mu.RLock()
	defer s.mu.RUnlock()

	routes := make([]domain.Route, 0, len(s.routes))
	for _, route := range s.routes {
		routes = append(routes, route)
	}
	return routes
}

// Clear removes all routes and returns the count of deleted routes
func (s *RouteStore) Clear() int {
	s.mu.Lock()
	defer s.mu.Unlock()

	count := len(s.routes)
	s.routes = make(map[string]domain.Route)
	return count
}

// Count returns the number of routes stored
func (s *RouteStore) Count() int {
	s.mu.RLock()
	defer s.mu.RUnlock()

	return len(s.routes)
}

// FindMatch searches for a route that matches the given method and path
// Returns the matching route, extracted parameters, and whether a match was found
func (s *RouteStore) FindMatch(method, path string) (domain.Route, map[string]string, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	// Convert routes map to slice for domain.FindBestMatch
	routes := make([]domain.Route, 0, len(s.routes))
	for _, route := range s.routes {
		routes = append(routes, route)
	}

	return domain.FindBestMatch(routes, method, path)
}

// Exists checks if a route with the given ID exists
func (s *RouteStore) Exists(id string) bool {
	s.mu.RLock()
	defer s.mu.RUnlock()

	_, exists := s.routes[id]
	return exists
}

// GetByMethodAndPath finds all routes that match a specific method and exact path
// This is useful for detecting route conflicts
func (s *RouteStore) GetByMethodAndPath(method, path string) []domain.Route {
	s.mu.RLock()
	defer s.mu.RUnlock()

	var matches []domain.Route
	for _, route := range s.routes {
		if route.Method == method && route.Path == path {
			matches = append(matches, route)
		}
	}
	return matches
}
