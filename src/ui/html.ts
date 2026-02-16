/** Escapes &, <, >, ", ' → HTML entities */
export const escapeHtml = (s: string): string =>
  s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&#39;")

/** Marker class for pre-escaped HTML */
export class SafeHtml {
  constructor(readonly value: string) {}
}

/** Wrap a raw HTML string to skip auto-escaping */
export const raw = (s: string): SafeHtml => new SafeHtml(s)

/** Tagged template: auto-escapes interpolations, passes SafeHtml through */
export const html = (strings: TemplateStringsArray, ...values: Array<unknown>): SafeHtml => {
  let result = ""
  for (let i = 0; i < strings.length; i++) {
    result += strings[i]
    if (i < values.length) {
      const v = values[i]
      if (v instanceof SafeHtml) {
        result += v.value
      } else if (v == null) {
        result += ""
      } else if (typeof v === "string") {
        result += escapeHtml(v)
      } else {
        result += escapeHtml(String(v))
      }
    }
  }
  return new SafeHtml(result)
}
