import { substituteParams } from "../domain/route.js"
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

export const applyTemplates = (ctx: RequestContext, data: unknown): unknown =>
  substituteParams(flattenRequestContext(ctx))(data)
