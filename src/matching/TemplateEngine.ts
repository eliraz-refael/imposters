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

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

// A node as a `{{key}}` gives it: text as is, a number or boolean as text, an object or array
// as JSON; null and undefined give nothing (the key stays literal)
const ownValue = (value: unknown): string | undefined => {
  if (typeof value === "string") return value
  if (typeof value === "number" || typeof value === "boolean") return String(value)
  if (typeof value === "object" && value !== null) return JSON.stringify(value)
  return undefined
}

const ARRAY_INDEX = /^(0|[1-9]\d*)$/

// The children of `node` a dotted `path` can start with, in the node's own key order, each with
// the rest of the path (undefined when the child is the path's end). A key may hold dots itself,
// so `a.b` can be the child `a.b`, or `b` under `a`.
const candidates = (node: unknown, path: string): ReadonlyArray<readonly [unknown, string | undefined]> => {
  if (Array.isArray(node)) {
    const dot = path.indexOf(".")
    const head = dot === -1 ? path : path.slice(0, dot)
    if (!ARRAY_INDEX.test(head) || Number(head) >= node.length) return []
    const child: unknown = node[Number(head)]
    return [[child, dot === -1 ? undefined : path.slice(dot + 1)]]
  }
  if (!isRecord(node)) return []
  // No dot: the path is one key (the usual last step, and cheap however many keys the node has)
  if (!path.includes(".")) return Object.hasOwn(node, path) ? [[node[path], undefined]] : []
  // Else every key the path can start with, in key order. The cost follows the node's keys,
  // never the path's length, so a long path down a deep answer stays linear.
  const found: Array<readonly [unknown, string | undefined]> = []
  for (const key of Object.keys(node)) {
    if (path === key) found.push([node[key], undefined])
    else if (path.startsWith(key) && path[key.length] === ".") found.push([node[key], path.slice(key.length + 1)])
  }
  return found
}

// The value at a dotted path below `node`, as flattening the whole tree would have left it:
// where two readings of the path both have a value, the one later in key order wins
const childValue = (node: unknown, path: string): string | undefined => {
  let current = node
  let remaining = path
  // Walks down while the path has one reading (the usual case), so a long path cannot overflow
  // the stack; only a key with dots in it branches
  for (;;) {
    const found = candidates(current, remaining)
    const [only] = found
    if (only === undefined) return undefined
    if (found.length > 1) break
    const [child, rest] = only
    if (rest === undefined) return ownValue(child)
    current = child
    remaining = rest
  }
  let value: string | undefined
  for (const [child, rest] of candidates(current, remaining)) {
    const found = rest === undefined ? ownValue(child) : childValue(child, rest)
    if (found !== undefined) value = found
  }
  return value
}

const flatValue = (record: Readonly<Record<string, string>>, key: string): string | undefined =>
  Object.hasOwn(record, key) ? record[key] : undefined

// What `{{key}}` gives in this context, or undefined when the key names nothing. Resolved on
// demand: only the value used is ever stringified, so a large callback answer costs nothing
// unless a template names it whole.
export const resolveTemplateKey = (tctx: TemplateContext, key: string): string | undefined => {
  const { request } = tctx
  if (key === "request.method") return request.method
  if (key === "request.path") return request.path
  if (key.startsWith("request.headers.")) return flatValue(request.headers, key.slice("request.headers.".length))
  if (key.startsWith("request.query.")) return flatValue(request.query, key.slice("request.query.".length))
  if (key === "request.body") return ownValue(request.body)
  if (key.startsWith("request.body.")) return childValue(request.body, key.slice("request.body.".length))
  if (key.startsWith("callbacks.") && tctx.callbacks !== undefined) {
    return childValue(tctx.callbacks, key.slice("callbacks.".length))
  }
  return undefined
}

// Every `{{key}}` in `str` that names something, replaced by its value; the rest left as written.
// An inserted value is never scanned again.
const substituteInString = (tctx: TemplateContext, str: string): string => {
  if (!str.includes("{{")) return str
  let out = ""
  let at = 0
  // The first `}}` at or after the current `{{` plus two, kept while it still is, so a run of
  // `{{` with no key does not search the rest of the string once per brace
  let close = -1
  for (;;) {
    const open = str.indexOf("{{", at)
    if (open === -1) break
    if (close < open + 2) close = str.indexOf("}}", open + 2)
    if (close === -1) break
    let value: string | undefined
    let end = close
    // Every key starts `request.` or `callbacks.`; anything else is text, and is not sliced
    if (str.startsWith("request.", open + 2) || str.startsWith("callbacks.", open + 2)) {
      // A key may hold `}` itself (a body key `a}` in `{{request.body.a}}}`), so a later `}}`
      // before the next `{{` can close it too; the first that names something wins
      const nextOpen = str.indexOf("{{", open + 1)
      const limit = nextOpen === -1 ? str.length : nextOpen
      for (let c = close; c !== -1 && (c === close || c < limit); c = str.indexOf("}}", c + 1)) {
        value = resolveTemplateKey(tctx, str.slice(open + 2, c))
        if (value !== undefined) {
          end = c
          break
        }
      }
    }
    if (value === undefined) {
      // Not a key: keep one brace and look again from the next, so `{{{a}}` still finds `{{a}}`
      out += str.slice(at, open + 1)
      at = open + 1
    } else {
      out += str.slice(at, open) + value
      at = end + 2
    }
  }
  return out + str.slice(at)
}

/** `{{key}}` substitution through strings, arrays and objects */
export const substituteTemplateKeys = (tctx: TemplateContext, data: unknown): unknown => {
  if (typeof data === "string") return substituteInString(tctx, data)
  if (Array.isArray(data)) return data.map((item) => substituteTemplateKeys(tctx, item))
  if (isRecord(data)) {
    return Object.fromEntries(Object.entries(data).map(([k, v]) => [k, substituteTemplateKeys(tctx, v)]))
  }
  return data
}

// The request's `{{key}}` values as one map, every nested level stringified. Kept for the
// published API; templating resolves keys on demand instead (resolveTemplateKey).
const flattenObject = (obj: unknown, prefix: string, result: Record<string, string>): void => {
  const own = ownValue(obj)
  if (own === undefined) return
  result[prefix] = own
  if (Array.isArray(obj)) {
    obj.forEach((item, i) => flattenObject(item, `${prefix}.${i}`, result))
  } else if (isRecord(obj)) {
    for (const [key, val] of Object.entries(obj)) flattenObject(val, `${prefix}.${key}`, result)
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
  flattenObject(ctx.body, "request.body", result)
  return result
}

export const applyTemplates = async (tctx: TemplateContext, data: unknown): Promise<unknown> => {
  // Step 1: Apply {{key}} substitution
  const substituted = substituteTemplateKeys(tctx, data)
  // Step 2: Apply ${expr} JSONata evaluation
  return processExpressions(tctx, substituted)
}
