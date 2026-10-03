import * as Option from "effect/Option"
import * as Schema from "effect/Schema"

// The browser runtime (ui-assets/ui.ts) writes this cookie on /_ui and on /_admin. Cookies
// ignore the port, so one choice covers the admin UI and every imposter, and the path keeps
// it out of stub traffic.
export const THEME_COOKIE = "imposters-theme"

export const Theme = Schema.Literals(["dark", "light"])
export type Theme = typeof Theme.Type

const decodeTheme = Schema.decodeUnknownOption(Theme)

/** The theme a `Cookie` header asks for, or null (no cookie, or not a theme): follow the system */
export const themeFromCookie = (cookieHeader: string | null | undefined): Theme | null => {
  if (cookieHeader === null || cookieHeader === undefined) return null
  for (const pair of cookieHeader.split(";")) {
    const eq = pair.indexOf("=")
    if (eq < 0 || pair.slice(0, eq).trim() !== THEME_COOKIE) continue
    const theme = decodeTheme(pair.slice(eq + 1).trim())
    if (Option.isSome(theme)) return theme.value
  }
  return null
}
