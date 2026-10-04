import * as Duration from "effect/Duration"
import { ago, count, decimal, millis, ms, NONE, percent, plural, shortDuration } from "imposters/ui/components/format"
import { describe, expect, it } from "vitest"

describe("format", () => {
  it("count groups thousands and rounds", () => {
    expect(count(0)).toBe("0")
    expect(count(999)).toBe("999")
    expect(count(1095)).toBe("1,095")
    expect(count(1234567.6)).toBe("1,234,568")
    expect(count(-2500)).toBe("-2,500")
  })

  it("decimal keeps one decimal only for small fractions", () => {
    expect(decimal(0.27)).toBe("0.3")
    expect(decimal(5.93)).toBe("5.9")
    expect(decimal(7)).toBe("7")
    expect(decimal(73.4)).toBe("73")
    expect(decimal(1250)).toBe("1,250")
  })

  it("percent has one decimal, and a dash when there is nothing to divide by", () => {
    expect(percent(171, 1000)).toBe("17.1%")
    expect(percent(0, 12)).toBe("0.0%")
    expect(percent(3, 3)).toBe("100.0%")
    expect(percent(0, 0)).toBe(NONE)
  })

  it("millis and ms print durations; a whole-ms timer's 0 reads as under a millisecond", () => {
    expect(millis(2004)).toBe("2,004")
    expect(millis(0.75)).toBe("0.8")
    expect(millis(0)).toBe("<1")
    expect(ms(4)).toBe("4 ms")
    expect(ms(2004)).toBe("2,004 ms")
  })

  it("plural picks the noun form by count", () => {
    expect(plural(0, "stub")).toBe("0 stubs")
    expect(plural(1, "stub")).toBe("1 stub")
    expect(plural(1200, "match", "matches")).toBe("1,200 matches")
  })

  it("ago is coarse and never negative", () => {
    const now = 10_000_000
    expect(ago(now, now)).toBe("just now")
    expect(ago(now + 5000, now)).toBe("just now")
    expect(ago(now - 999, now)).toBe("just now")
    expect(ago(now - 42_000, now)).toBe("42s ago")
    expect(ago(now - 3 * 60_000 - 59_000, now)).toBe("3m ago")
    expect(ago(now - 5 * 3_600_000, now)).toBe("5h ago")
    expect(ago(now - 2 * 86_400_000, now)).toBe("2d ago")
  })

  it("shortDuration keeps the two largest whole units of the API's uptime", () => {
    // The admin API formats uptime with Duration.format; pin that shape here
    expect(shortDuration(Duration.format(Duration.millis(4_321_234.5)))).toBe("1h 12m")
    expect(shortDuration(Duration.format(Duration.millis(42_007)))).toBe("42s")
    expect(shortDuration(Duration.format(Duration.millis(90_061_000)))).toBe("1d 1h")
    expect(shortDuration(Duration.format(Duration.millis(0)))).toBe("0s")
    expect(shortDuration(Duration.format(Duration.millis(250)))).toBe("0s")
  })
})
