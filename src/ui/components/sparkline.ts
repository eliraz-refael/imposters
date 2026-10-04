/**
 * Trend lines: a pure `points()` and the inline SVG that draws it.
 */
import { html, type SafeHtml } from "../html.js"

// A 2px margin top and bottom keeps the 1.5px stroke inside the box at the extremes
const MARGIN = 2

const fixed = (n: number): string => n.toFixed(1)

/**
 * The `points` of an SVG polyline that draws `values` left to right across a `width` × `height`
 * box: the largest value touches the top margin and zero the bottom one. Pure.
 *
 * All zeros (or nothing at all) is a flat line along the bottom, which is how "no traffic" reads.
 */
export const points = (values: ReadonlyArray<number>, width: number, height: number): string => {
  const floor = height - MARGIN
  if (values.length < 2) return `0,${fixed(floor)} ${fixed(width)},${fixed(floor)}`
  const max = Math.max(...values)
  const scale = max > 0 ? (height - 2 * MARGIN) / max : 0
  const step = width / (values.length - 1)
  return values.map((v, i) => `${fixed(i * step)},${fixed(floor - Math.max(0, v) * scale)}`).join(" ")
}

// on: traffic; warn: traffic with a high 5xx rate; off: a stopped imposter
export type SparkTone = "on" | "warn" | "off"

const toneClass: Record<SparkTone, string> = { on: "spark", warn: "spark spark-warn", off: "spark spark-off" }

export interface SparklineOpts {
  readonly values: ReadonlyArray<number>
  readonly width: number
  readonly height: number
  readonly tone?: SparkTone
}

/** A decorative trend line; the numbers beside it carry the meaning, so it is hidden from screen readers */
export const sparkline = (opts: SparklineOpts): SafeHtml =>
  html`<svg class="sparkline" width="${opts.width}" height="${opts.height}" viewBox="0 0 ${opts.width} ${opts.height}" aria-hidden="true"><polyline class="${
    toneClass[opts.tone ?? "on"]
  }" points="${points(opts.values, opts.width, opts.height)}"></polyline></svg>`
