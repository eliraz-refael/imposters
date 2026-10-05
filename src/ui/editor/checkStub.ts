import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { stubIssueMessages } from "../../schemas/IssueMessages.js"
import { CreateStubRequest } from "../../schemas/StubSchema.js"
import { locate, parseDraftText, type SyntaxProblem, type TextPosition } from "./draftText.js"

/**
 * The stub editor's text, checked on the server: the JSON (with its syntax error's line and
 * column), then the stub schema (with plain-English messages, each placed in the text). The
 * preview and every write from the editor go through here.
 */

/** A schema problem, at the line and column of the value it is about when the text has one */
export interface LocatedProblem {
  readonly message: string
  readonly at?: TextPosition
}

export type StubCheck = Data.TaggedEnum<{
  Valid: { readonly stub: CreateStubRequest }
  Syntax: { readonly problem: SyntaxProblem }
  Invalid: { readonly problems: ReadonlyArray<LocatedProblem> }
}>

export const StubCheck = Data.taggedEnum<StubCheck>()

// Every problem at once, so the user can fix them in one go
const decodeStub = Schema.decodeUnknownEffect(CreateStubRequest, { errors: "all" })

export const checkStubText = (text: string): Effect.Effect<StubCheck> => {
  const parsed = parseDraftText(text)
  if (!parsed.ok) return Effect.succeed(StubCheck.Syntax({ problem: parsed.problem }))
  return decodeStub(parsed.draft).pipe(
    Effect.map((stub) => StubCheck.Valid({ stub })),
    Effect.catch((error) =>
      Effect.succeed(StubCheck.Invalid({
        problems: stubIssueMessages(error, parsed.draft).map(({ message, path }) => {
          const at = locate(parsed, text, path)
          return at === undefined ? { message } : { message, at }
        })
      }))
    )
  )
}

/** A check's problems as lines of text: "line 3, column 9: responses[0].status must be …" */
export const problemLines = (check: StubCheck): ReadonlyArray<string> => {
  switch (check._tag) {
    case "Valid":
      return []
    case "Syntax":
      return [`line ${String(check.problem.line)}, column ${String(check.problem.column)}: ${check.problem.message}`]
    case "Invalid":
      return check.problems.map(({ at, message }) => at === undefined ? message : `line ${String(at.line)}: ${message}`)
  }
}
