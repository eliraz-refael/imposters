import { substituteParams } from "../domain/route.js"
import { processExpressions } from "./ExpressionEvaluator.js"
import type { RequestContext } from "./RequestMatcher.js"

const flattenObject = (obj: unknown, prefix: string, result: Record<string, string>): void => {
  if (obj === null || obj === undefined) return
  if (typeof obj === "string") {
    result[prefix] = obj
    return
  }
  if (typeof obj === "number" || typeof obj === "boolean") {
    result[prefix] = String(obj)
    return
  }
  if (Array.isArray(obj)) {
    result[prefix] = JSON.stringify(obj)
    obj.forEach((item, i) => flattenObject(item, `${prefix}.${i}`, result))
    return
  }
  if (typeof obj === "object") {
    result[prefix] = JSON.stringify(obj)
    for (const [key, val] of Object.entries(obj as Record<string, unknown>)) {
      flattenObject(val, `${prefix}.${key}`, result)
    }
  }
}

export const flattenRequestContext = (ctx: RequestContext): Record<string, string> => {
  const result: Record<string, string> = {
    "request.method": ctx.method,
    "request.path": ctx.path
  }

  for (const [key, val] of Object.entries(ctx.headers)) {
    result[`request.headers.${key}`] = val
  }

  for (const [key, val] of Object.entries(ctx.query)) {
    result[`request.query.${key}`] = val
  }

  if (ctx.body !== undefined && ctx.body !== null) {
    flattenObject(ctx.body, "request.body", result)
  }

  return result
}

export const applyTemplates = async (ctx: RequestContext, data: unknown): Promise<unknown> => {
  // Step 1: Apply {{key}} substitution
  const substituted = substituteParams(flattenRequestContext(ctx))(data)
  // Step 2: Apply ${expr} JSONata evaluation
  return processExpressions(ctx, substituted)
}
