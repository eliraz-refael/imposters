# Makefile for Imposter Mock Server

.PHONY: build test test-verbose test-coverage clean run help

# Default target
help:
	@echo "Available targets:"
	@echo "  build        - Build the imposter binary"
	@echo "  run          - Run the imposter server"
	@echo "  test         - Run all unit tests"
	@echo "  test-verbose - Run tests with verbose output"
	@echo "  test-rapid   - Run property-based tests with rapid"
	@echo "  test-rapid-long - Run extended property tests"
	@echo "  test-coverage- Run tests with coverage report"
	@echo "  clean        - Remove build artifacts"
	@echo "  help         - Show this help message"

# Build the binary
build:
	@echo "Building imposter..."
	go build -o bin/imposter cmd/imposter/main.go
	@echo "Build complete: bin/imposter"

# Run the server
run:
	@echo "Starting imposter server..."
	go run cmd/imposter/main.go

# Run all tests
test:
	@echo "Running unit tests..."
	go test ./...

# Run tests with verbose output
test-verbose:
	@echo "Running unit tests (verbose)..."
	go test -v ./...

# Run property-based tests with rapid
test-rapid:
	@echo "Running property-based tests with rapid..."
	go test -rapid.checks=1000 ./internal/domain -run "TestMatch|TestParse|TestSubstitute|TestFind"

# Run extended rapid tests
test-rapid-long:
	@echo "Running extended property-based tests..."
	go test -rapid.checks=10000 ./internal/domain -run "TestMatch|TestParse|TestSubstitute"

# Create semantic version tag
tag:
	@echo "Current version: $(VERSION)"
	@echo "To create a new release:"
	@echo "  git tag v0.1.0    # Create tag"
	@echo "  git push origin v0.1.0  # Push tag to trigger release"
	@echo ""
	@echo "Version scheme:"
	@echo "  v0.1.0 - Initial release"
	@echo "  v0.1.1 - Patch release (bug fixes)"
	@echo "  v0.2.0 - Minor release (new features)"
	@echo "  v1.0.0 - Major release (breaking changes)"

# Run tests with coverage
test-coverage:
	@echo "Running tests with coverage..."
	go test -cover ./...
	@echo ""
	@echo "Detailed coverage report:"
	go test -coverprofile=coverage.out ./...
	go tool cover -html=coverage.out -o coverage.html
	@echo "Coverage report generated: coverage.html"

# Run specific package tests
test-domain:
	@echo "Testing domain package..."
	go test -v ./internal/domain

test-storage:
	@echo "Testing storage package..."
	go test -v ./internal/storage

# Clean build artifacts
clean:
	@echo "Cleaning build artifacts..."
	rm -rf bin/
	rm -f coverage.out coverage.html
	go clean

# Install dependencies
deps:
	@echo "Installing dependencies..."
	go mod tidy
	go mod download

# Format code
fmt:
	@echo "Formatting code..."
	go fmt ./...
	@if which golangci-lint > /dev/null 2>&1; then \
		echo "Running gofumpt..."; \
		golangci-lint fmt; \
	else \
		echo "golangci-lint not found, skipping. Run 'make install-tools' to install."; \
	fi

# Install development tools
install-tools:
	@echo "Installing development tools..."
	go install github.com/golangci/golangci-lint/cmd/golangci-lint@latest

# Lint code (basic checks)
lint:
	@echo "Running basic linters..."
	@which golangci-lint > /dev/null || (echo "golangci-lint not found. Run 'make install-tools' first." && exit 1)
	golangci-lint run

# Lint code (strict - enable all linters)
lint-strict:
	@echo "Running strict linters..."
	@which golangci-lint > /dev/null || (echo "golangci-lint not found. Run 'make install-tools' first." && exit 1)
	golangci-lint run --enable-all --disable=gochecknoglobals,gochecknoinits,testpackage

# Run all checks (test, fmt, lint)
check: fmt test lint
	@echo "All checks passed!"

# Development workflow
dev: deps fmt test build
	@echo "Development build complete!"
