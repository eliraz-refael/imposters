import { points, sparkline } from "imposters/ui/components/sparkline"
import { describe, expect, it } from "vitest"

const parse = (pts: string): Array<readonly [number, number]> =>
  pts.split(" ").map((pair): readonly [number, number] => {
    const [x, y] = pair.split(",").map(Number)
    return [x ?? Number.NaN, y ?? Number.NaN]
  })

describe("sparkline.points", () => {
  it("spans the width left to right, one point per value", () => {
    const xy = parse(points([1, 2, 3, 4, 5], 120, 32))
    expect(xy.map(([x]) => x)).toEqual([0, 30, 60, 90, 120])
  })

  it("puts the largest value on the top margin and zero on the bottom one", () => {
    const xy = parse(points([0, 5, 10], 100, 32))
    expect(xy.map(([, y]) => y)).toEqual([30, 16, 2])
  })

  it("scales to the largest value, not to a fixed ceiling", () => {
    expect(points([2, 4], 10, 32)).toBe(points([200, 400], 10, 32))
  })

  it("draws all zeros, one value or none as a flat line along the bottom", () => {
    expect(points([0, 0, 0], 150, 28)).toBe("0.0,26.0 75.0,26.0 150.0,26.0")
    expect(points([7], 150, 28)).toBe("0,26.0 150.0,26.0")
    expect(points([], 150, 28)).toBe("0,26.0 150.0,26.0")
  })

  it("never draws below the floor", () => {
    expect(parse(points([-3, 3], 10, 20)).map(([, y]) => y)).toEqual([18, 2])
  })
})

describe("sparkline", () => {
  it("is a decorative SVG with the tone's class", () => {
    const svg = sparkline({ values: [1, 2], width: 150, height: 28, tone: "warn" }).value
    expect(svg).toContain("aria-hidden=\"true\"")
    expect(svg).toContain("viewBox=\"0 0 150 28\"")
    expect(svg).toContain("class=\"spark spark-warn\"")
    expect(sparkline({ values: [], width: 10, height: 10 }).value).toContain("class=\"spark\"")
    expect(sparkline({ values: [], width: 10, height: 10, tone: "off" }).value).toContain("spark-off")
  })
})
