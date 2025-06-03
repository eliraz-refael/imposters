# Imposter - Mock Server

A simple, powerful mock server for API testing and development.

## Quick Start

### 1. Install Dependencies
```bash
go mod tidy
```

### 2. Run the Server
```bash
go run cmd/imposter/main.go
```

The server will start on port 3001 with admin endpoints available at:
- http://localhost:3001/admin

### 3. Configure Routes

Add a mock route:
```bash
curl -X POST http://localhost:3001/admin/routes \
  -H "Content-Type: application/json" \
  -d '{
    "path": "/users/{id}",
    "method": "GET",
    "response": {
      "status": 200,
      "headers": {
        "Content-Type": "application/json"
      },
      "body": {
        "id": "{{id}}",
        "name": "John Doe",
        "email": "john@example.com"
      }
    },
    "delay": 100
  }'
```

### 4. Test Your Mock
```bash
curl http://localhost:3001/users/123
```

Response:
```json
{
  "id": "123",
  "name": "John Doe", 
  "email": "john@example.com"
}
```

## Admin API

### Routes Management
- `POST /admin/routes` - Add new route
- `GET /admin/routes` - List all routes
- `GET /admin/routes/{id}` - Get specific route
- `PUT /admin/routes/{id}` - Update route
- `DELETE /admin/routes/{id}` - Delete route
- `DELETE /admin/routes` - Clear all routes

### Server Info
- `GET /admin/info` - Get server information

## Features

- ✅ Path parameters (`/users/{id}`)
- ✅ Parameter substitution in responses (`{{id}}`)
- ✅ Custom response headers
- ✅ Response delays for latency simulation
- ✅ Structured logging
- ✅ Thread-safe route storage
- ✅ RESTful admin API

## Project Structure

```
imposter/
├── cmd/imposter/main.go         # Entry point
├── internal/
│   ├── domain/                  # Core business logic
│   │   ├── imposter.go         # Imposter configuration
│   │   ├── route.go            # Route types and functions
│   │   └── matching.go         # Path matching logic
│   ├── storage/
│   │   └── memory.go           # In-memory storage
│   ├── http/
│   │   ├── server.go           # HTTP server setup
│   │   └── handlers.go         # Request handlers
│   └── logging/
│       └── logger.go           # Logging functionality
├── go.mod
└── README.md
```

## Configuration

Currently configured via code in `main.go`. Future versions will support:
- Command line flags
- Environment variables
- Configuration files

## Building

```bash
go build -o imposter cmd/imposter/main.go
./imposter
```

## Testing

The server logs all requests and responses:
```
[example-imposter:3001] 2025-06-03T10:30:00Z info Started imposter (id: abc12345)
[example-imposter:3001] 2025-06-03T10:30:15Z info Route added: GET /users/{id} -> 200
[example-imposter:3001] 2025-06-03T10:30:30Z info <- GET /users/123 from 127.0.0.1
[example-imposter:3001] 2025-06-03T10:30:30Z info -> 200 GET /users/123 (45 bytes, 12ms)
```
