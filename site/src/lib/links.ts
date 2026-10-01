/** A site path under the configured base: withBase("/docs/") is "/imposters/docs/" */
export const withBase = (path: string): string => {
  const base = import.meta.env.BASE_URL.replace(/\/$/, "")
  return `${base}/${path.replace(/^\//, "")}`
}

export const links = {
  home: withBase("/"),
  docs: withBase("/docs/"),
  gettingStarted: withBase("/docs/getting-started/"),
  configFile: withBase("/docs/config-file/"),
  stubs: withBase("/docs/stubs/"),
  responses: withBase("/docs/responses/"),
  s3: withBase("/docs/s3/"),
  roadmap: withBase("/roadmap/"),
  github: "https://github.com/eliraz-refael/imposters",
  npm: "https://www.npmjs.com/package/imposters",
  mountebank: "https://github.com/mountebank-testing/mountebank"
} as const
