// A vitest suite that mocks a users API with an imposter. Copy it into a project that has
// `imposters`, `effect` and `vitest` installed, then run `npx vitest run`. The admin API runs
// in-process (no admin port); the imposter itself listens on the port it is given.
import { Effect } from "effect"
import { makeTestServer, withImposter } from "imposters/client/testing"
import { afterAll, describe, expect, it } from "vitest"

// The code under test: anything that talks HTTP to a base URL
const fetchUser = async (baseUrl: string, id: string): Promise<unknown> => {
  const res = await fetch(`${baseUrl}/users/${id}`)
  if (!res.ok) throw new Error(`users API answered ${res.status}`)
  return res.json()
}

const { clientLayer, dispose } = makeTestServer()
afterAll(() => dispose())

describe("fetchUser", () => {
  it("reads a user, then fails when the API answers 503", () =>
    withImposter(
      {
        port: 4101,
        stubs: [{
          predicates: [
            { field: "method", operator: "equals", value: "GET" },
            { field: "path", operator: "matches", value: "^/users/\\d+$" }
          ],
          // Sequential: 200, then 503, then 200 again, and so on
          responses: [
            { body: { id: "${$substringAfter(request.path, '/users/')}", name: "Alice" } },
            { status: 503, body: { error: "service_unavailable" } }
          ]
        }]
      },
      (ctx) =>
        Effect.promise(async () => {
          const baseUrl = `http://localhost:${ctx.port}`
          expect(await fetchUser(baseUrl, "42")).toEqual({ id: "42", name: "Alice" })
          await expect(fetchUser(baseUrl, "42")).rejects.toThrow("users API answered 503")
        })
    ).pipe(Effect.provide(clientLayer), Effect.runPromise))
})
