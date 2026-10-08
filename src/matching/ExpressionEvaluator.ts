import jsonata from "jsonata"
import type { TemplateContext } from "./TemplateEngine.js"

const MAX_OUTPUT_SIZE = 1_048_576 // 1MB

/**
 * Extract expression content from a ${...} pattern using brace-depth counting.
 * Returns [expressionContent, endIndex] or null if no valid expression found.
 */
const extractExpression = (str: string, startIndex: number): [string, number] | null => {
  // startIndex should point to the '$' of '${'
  if (str[startIndex] !== "$" || str[startIndex + 1] !== "{") return null
  let depth = 1
  let i = startIndex + 2
  while (i < str.length && depth > 0) {
    if (str[i] === "{") depth++
    else if (str[i] === "}") depth--
    i++
  }
  if (depth !== 0) return null
  const content = str.slice(startIndex + 2, i - 1)
  return [content, i]
}

/**
 * Evaluate a single JSONata expression against `{ request }`, plus `callbacks` when the template
 * context has them. Returns the result or undefined on error.
 */
export const evaluateExpression = async (expr: string, ctx: TemplateContext): Promise<unknown> => {
  try {
    const expression = jsonata(expr)
    const context = ctx.callbacks === undefined
      ? { request: ctx.request }
      : { request: ctx.request, callbacks: ctx.callbacks }
    return await expression.evaluate(context)
  } catch {
    return undefined
  }
}

// A template string cut at its `{{key}}`s: the text as written, and each key's value. A value
// is data: it is never scanned for `${…}`, and it neither opens nor closes an expression.
export type TemplatePiece =
  | { readonly _tag: "Text"; readonly text: string }
  // `written` is the `{{key}}` as the template wrote it, which an expression around it sees
  | { readonly _tag: "Value"; readonly value: string; readonly written: string }

// The pieces as one string, each value inserted
export const joinPieces = (pieces: ReadonlyArray<TemplatePiece>): string =>
  pieces.map((piece) => piece._tag === "Text" ? piece.text : piece.value).join("")

// Stands for a value in the skeleton: any character but `$`, `{` and `}` will do, since the
// value at an index is looked up by position, never by this character
const VALUE_MARK = "\u0000"

// A template string's pieces rendered: each ${...} in its text replaced by its JSONata result
export const renderPieces = async (pieces: ReadonlyArray<TemplatePiece>, ctx: TemplateContext): Promise<unknown> => {
  // The skeleton: the text as written, each value one VALUE_MARK. Expressions are found and
  // delimited in it, so a value can never start, end or join one.
  let skeleton = ""
  const values = new Map<number, Extract<TemplatePiece, { _tag: "Value" }>>()
  for (const piece of pieces) {
    if (piece._tag === "Text") {
      skeleton += piece.text
    } else {
      values.set(skeleton.length, piece)
      skeleton += VALUE_MARK
    }
  }
  // Quick check: if no ${, return as-is
  if (!skeleton.includes("${")) return joinPieces(pieces)

  // The skeleton from `from` to `to`, each value as the template wrote it (inside an expression)
  // or as its value (outside one)
  const span = (from: number, to: number, asWritten: boolean): string => {
    if (values.size === 0) return skeleton.slice(from, to)
    let out = ""
    for (let k = from; k < to; k++) {
      const value = values.get(k)
      out += value === undefined ? skeleton.charAt(k) : asWritten ? value.written : value.value
    }
    return out
  }

  // If the entire string is a single expression, return the raw result (preserving type)
  const singleMatch = extractExpression(skeleton, 0)
  if (singleMatch && singleMatch[1] === skeleton.length) {
    const result = await evaluateExpression(span(2, skeleton.length - 1, true), ctx)
    if (result === undefined) return span(0, skeleton.length, true) // Preserve raw on failure
    return result
  }

  // Multiple expressions or mixed content: concatenate as string
  let result = ""
  let i = 0
  while (i < skeleton.length) {
    if (skeleton[i] === "$" && i + 1 < skeleton.length && skeleton[i + 1] === "{") {
      const extracted = extractExpression(skeleton, i)
      if (extracted) {
        const [, endIndex] = extracted
        const evalResult = await evaluateExpression(span(i + 2, endIndex - 1, true), ctx)
        if (evalResult === undefined) {
          // Preserve raw expression on failure
          result += span(i, endIndex, true)
        } else if (typeof evalResult === "object" && evalResult !== null) {
          const jsonStr = JSON.stringify(evalResult)
          result += jsonStr
        } else {
          result += String(evalResult)
        }
        i = endIndex
        if (result.length > MAX_OUTPUT_SIZE) {
          return result.slice(0, MAX_OUTPUT_SIZE)
        }
        continue
      }
    }
    result += values.get(i)?.value ?? skeleton.charAt(i)
    i++
  }
  return result
}

// A string with no `{{key}}`s: all of it is text
const processString = (str: string, ctx: TemplateContext): Promise<unknown> =>
  renderPieces([{ _tag: "Text", text: str }], ctx)

/**
 * Recursively walk data structures, processing ${...} expressions in strings.
 */
export const processExpressions = async (ctx: TemplateContext, data: unknown): Promise<unknown> => {
  if (typeof data === "string") return processString(data, ctx)
  if (Array.isArray(data)) {
    const results = await Promise.all(data.map((item) => processExpressions(ctx, item)))
    return results
  }
  if (data !== null && typeof data === "object") {
    const entries = Object.entries(data as Record<string, unknown>)
    const resolved = await Promise.all(
      entries.map(async ([k, v]) => [k, await processExpressions(ctx, v)] as const)
    )
    return Object.fromEntries(resolved)
  }
  return data
}
