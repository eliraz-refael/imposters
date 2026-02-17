# Imposters - Project Context for Claude

## Project Overview

**Imposters** is a service virtualization tool (similar to Mountebank) being built with TypeScript and the [Effect](https://effect.website) library. It allows developers to create mock HTTP services for testing and development purposes.

## Current Status

The project is in the **early development phase** - currently porting the architecture to TypeScript with Effect. The domain models and schemas are being established following Effect's best practices.

### What's Been Implemented

#### 1. Domain Models (`src/domain/`)

**Imposter Management** (`imposter.ts`)
- Core domain types: `ImposterConfig`, `ImposterRef`, `CreateImposterRequest`
- Tagged errors: `ImposterError`, `PortInUseError`, `ImposterNotFoundError`
- Functions for creating, updating, and managing imposters
- Status management: `running`, `stopped`, `starting`, `stopping`
- Uptime calculation using Effect's `Duration`
- UUID service integration for ID generation

**Routes** (`route.ts`)
- Route creation with validation
- Parameter substitution in responses (e.g., `{{userId}}` in response bodies)
- Support for custom headers, delays, and status codes
- HTTP methods: GET, POST, PUT, DELETE, PATCH, HEAD, OPTIONS
- Path validation and schema-based validation
- Pure functional updates preserving creation metadata

**Mock Endpoints** (`endpoint.ts`)
- Integration with `@effect/platform`'s `HttpApiEndpoint`
- Mock endpoint creation with configurable responses
- Delay support using Effect's `Duration`
- Custom headers and status codes
- Endpoint metadata tracking

#### 2. Schema Definitions (`src/schemas/`)

**Common Schemas** (`common.ts`)
- Branded types: `NonEmptyString`, `PortNumber`, `PositiveInteger`
- Enums: `ImposterStatus`, `Protocol` (HTTP, GRPC)
- Pagination: `PaginationQuery`, `PaginationMeta`
- Error handling: `ErrorCode`, `ErrorDetails`, `ErrorResponse`
- DateTime utilities using Effect's `DateTime`

**API Schemas** (`ImposterSchema.ts`)
- Complete request/response schemas for the REST API:
  - `CreateImposterRequest` - POST /imposters
  - `UpdateImposterRequest` - PATCH /imposters/{id}
  - `ListImpostersQuery` - GET /imposters (with pagination & filtering)
  - `ImposterResponse` - Full imposter details
  - `DeleteImposterResponse`
  - `HealthResponse` - GET /health
  - `ServerInfoResponse` - GET /info
- Statistics and system monitoring schemas
- Helper functions for creating responses

#### 3. Services (`src/services/`)

**UUID Service** (`Uuid.ts`)
- Effect Context service for UUID generation
- Two methods: `generate` (full UUID), `generateShort` (short UUID)
- Used throughout domain models for ID generation

## Architecture Patterns

The codebase follows Effect best practices:

1. **Tagged Types** - Using `Data.tagged` for all domain types (`_tag` discriminator)
2. **Branded Types** - Schema validation with brands for type safety (`PortNumber`, `NonEmptyString`)
3. **Tagged Errors** - All errors are tagged for precise error handling
4. **Effect Workflows** - All operations return `Effect` types for composability
5. **Schema Validation** - Effect Schema for runtime validation and type inference
6. **Pure Functions** - Domain logic is pure and composable
7. **Service Pattern** - Context-based dependency injection (e.g., `UuidService`)

## Project Structure

```
imposters/
├── src/
│   ├── Program.ts              # Entry point (currently just "Hello World")
│   ├── domain/                 # Domain models and business logic
│   │   ├── imposter.ts         # Imposter domain model
│   │   ├── route.ts            # Route domain model
│   │   ├── endpoint.ts         # Mock endpoint model
│   │   └── isValidPath.ts      # (empty placeholder)
│   ├── schemas/                # API schemas and validation
│   │   ├── common.ts           # Shared schemas and utilities
│   │   └── ImposterSchema.ts   # Complete API schemas
│   └── services/               # Services and infrastructure
│       └── Uuid.ts             # UUID generation service
├── test/                       # Test files
├── package.json                # Dependencies (Effect, @effect/platform, uuid)
└── README.md                   # Generic Effect template README
```

## Dependencies

Key dependencies:
- `effect` (latest) - Core Effect library
- `@effect/platform` (^0.84.11) - Platform abstractions including HTTP
- `uuid` (^11.1.0) - UUID generation
- `vitest` (^2.1.9) - Testing framework
- `@effect/vitest` (latest) - Effect integration for Vitest

## What's NOT Implemented Yet

- [ ] Actual HTTP server implementation
- [ ] Port allocation service
- [ ] Imposter repository/storage
- [ ] Route repository/storage
- [ ] Request matching logic
- [ ] Response generation with parameter substitution
- [ ] Statistics collection
- [ ] Admin API endpoints
- [ ] Client libraries
- [ ] OpenAPI generation
- [ ] Persistence layer
- [ ] Clustering support
- [ ] Authentication
- [ ] Tests (only placeholder test exists)

## Next Steps

The logical next steps for development would be:

1. **Service Implementations**
   - Implement UUID service with actual uuid library
   - Create port allocation service
   - Build in-memory repositories for imposters and routes

2. **HTTP Layer**
   - Set up HTTP server using `@effect/platform`
   - Implement admin API endpoints
   - Build request matching and response generation

3. **Testing**
   - Write comprehensive tests for domain models
   - Test schema validation
   - Integration tests for API endpoints

4. **Storage**
   - Decide on persistence strategy (in-memory, file-based, database)
   - Implement repository pattern with Effect

## Development Commands

```bash
# Type check
bun check

# Build
bun build

# Run tests (vitest)
bun run test

# Run with tsx
bun tsx src/Program.ts

# Lint
bun lint
```

## Design Decisions

1. **Effect over traditional Promise-based code** - For better composition, error handling, and testability
2. **Tagged types everywhere** - For runtime type discrimination and better error messages
3. **Schema-first API design** - All request/response types derived from Effect schemas
4. **Pure domain models** - Business logic separated from infrastructure
5. **Branded types for validation** - Compile-time guarantees about validated data

## Notes for AI Assistants

- This project uses **Effect 3.x** syntax (latest)
- Follow Effect best practices: prefer `Effect.gen`, use `pipe` for composition
- All domain types should be tagged with `Data.tagged`
- All errors should be tagged errors
- Use Effect Schema for all validation
- Services should use `Context.GenericTag` or `Context.Tag`
- Prefer immutable updates over mutation
- Use Effect's `Duration` for time-related operations
- Use branded types from schemas for validated data
