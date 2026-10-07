import { substituteParams } from "../domain/route.js"
import type { CallbackResult } from "./CallbackRules.js"
import { processExpressions } from "./ExpressionEvaluator.js"
import type { RequestContext } from "./RequestMatcher.js"

// What a response's templates see: the request, and the results of the `before` callbacks that
// ran (absent when the response has none, so a template without callbacks renders as it always has)
export interface TemplateContext {
  readonly request: RequestContext
  readonly callbacks?: Readonly<Record<string, CallbackResult>>
}

// A template context holding only the request
export const requestOnly = (request: RequestContext): TemplateContext => ({ request })

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

// The `{{key}}` values: request.* as flattenRequestContext gives them, and callbacks.<name>.*
export const flattenTemplateContext = (tctx: TemplateContext): Record<string, string> => {
  const result = flattenRequestContext(tctx.request)
  if (tctx.callbacks !== undefined) {
    for (const [name, callback] of Object.entries(tctx.callbacks)) {
      flattenObject(callback, `callbacks.${name}`, result)
    }
  }
  return result
}

export const applyTemplates = async (tctx: TemplateContext, data: unknown): Promise<unknown> => {
  // Step 1: Apply {{key}} substitution
  const substituted = substituteParams(flattenTemplateContext(tctx))(data)
  // Step 2: Apply ${expr} JSONata evaluation
  return processExpressions(tctx, substituted)
}
