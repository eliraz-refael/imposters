import jsonata from "jsonata"
import type { RequestContext } from "./RequestMatcher"

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
 * Evaluate a single JSONata expression against the request context.
 * Returns the result or undefined on error.
 */
export const evaluateExpression = async (expr: string, ctx: RequestContext): Promise<unknown> => {
  try {
    const expression = jsonata(expr)
    const context = { request: ctx }
    return await expression.evaluate(context)
  } catch {
    return undefined
  }
}

/**
 * Process a string, replacing all ${...} patterns with evaluated JSONata results.
 */
const processString = async (str: string, ctx: RequestContext): Promise<unknown> => {
  // Quick check: if no ${, return as-is
  if (!str.includes("${")) return str

  // If the entire string is a single expression, return the raw result (preserving type)
  const singleMatch = extractExpression(str, 0)
  if (singleMatch && singleMatch[1] === str.length) {
    const result = await evaluateExpression(singleMatch[0], ctx)
    if (result === undefined) return str // Preserve raw on failure
    return result
  }

  // Multiple expressions or mixed content: concatenate as string
  let result = ""
  let i = 0
  while (i < str.length) {
    if (str[i] === "$" && i + 1 < str.length && str[i + 1] === "{") {
      const extracted = extractExpression(str, i)
      if (extracted) {
        const [exprContent, endIndex] = extracted
        const evalResult = await evaluateExpression(exprContent, ctx)
        if (evalResult === undefined) {
          // Preserve raw expression on failure
          result += str.slice(i, endIndex)
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
    result += str[i]
    i++
  }
  return result
}

/**
 * Recursively walk data structures, processing ${...} expressions in strings.
 */
export const processExpressions = async (ctx: RequestContext, data: unknown): Promise<unknown> => {
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
