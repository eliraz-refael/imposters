// A tiny JSON highlighter for the landing page's hand-built code windows (the docs use Expressive Code)

const escapeHtml = (text: string): string =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll("\"", "&quot;")

const TOKEN = /("(?:[^"\\]|\\.)*")(\s*:)?|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|\b(true|false|null)\b/g

/** JSON source to HTML with `tok-key`, `tok-str`, `tok-num` and `tok-lit` spans */
export const highlightJson = (source: string): string => {
  let html = ""
  let last = 0
  for (const match of source.matchAll(TOKEN)) {
    const index = match.index ?? 0
    html += escapeHtml(source.slice(last, index))
    const [whole, str, colon, num, lit] = match
    if (str !== undefined) {
      html += colon !== undefined
        ? `<span class="tok-key">${escapeHtml(str)}</span>${escapeHtml(colon)}`
        : `<span class="tok-str">${escapeHtml(str)}</span>`
    } else if (num !== undefined) {
      html += `<span class="tok-num">${escapeHtml(num)}</span>`
    } else if (lit !== undefined) {
      html += `<span class="tok-lit">${escapeHtml(lit)}</span>`
    }
    last = index + whole.length
  }
  return html + escapeHtml(source.slice(last))
}
