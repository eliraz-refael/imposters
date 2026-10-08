// @ts-check
import starlight from "@astrojs/starlight"
import { ExpressiveCodeTheme } from "@astrojs/starlight/expressive-code"
import { defineConfig } from "astro/config"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

const site = "https://eliraz-refael.github.io"
const base = "/imposters"

// The repo root: the playground imports the real matcher from ../src, and the roadmap page reads ../ROADMAP.md
const repoRoot = fileURLToPath(new URL("..", import.meta.url))

const codeTheme = (name) =>
  ExpressiveCodeTheme.fromJSONString(readFileSync(new URL(`./src/styles/code-themes/${name}.json`, import.meta.url), "utf8"))

export default defineConfig({
  site,
  base,
  trailingSlash: "ignore",
  integrations: [
    starlight({
      title: "Imposters",
      description: "Mock the HTTP APIs and the S3 your code talks to, from a server you program over REST or a JSON file.",
      logo: { dark: "./src/assets/mark-dark.svg", light: "./src/assets/mark-light.svg", alt: "" },
      favicon: "/favicon.svg",
      head: [
        { tag: "link", attrs: { rel: "icon", href: `${base}/favicon-32.png`, sizes: "32x32", type: "image/png" } },
        { tag: "link", attrs: { rel: "apple-touch-icon", href: `${base}/apple-touch-icon.png` } },
        { tag: "meta", attrs: { property: "og:image", content: `${site}${base}/og.png` } },
        { tag: "meta", attrs: { property: "og:image:width", content: "1200" } },
        { tag: "meta", attrs: { property: "og:image:height", content: "630" } },
        { tag: "meta", attrs: { name: "twitter:card", content: "summary_large_image" } }
      ],
      social: [
        { icon: "github", label: "GitHub", href: "https://github.com/eliraz-refael/imposters" }
      ],
      editLink: { baseUrl: "https://github.com/eliraz-refael/imposters/edit/master/site/" },
      // The site's own 404 page (src/pages/404.astro) replaces Starlight's
      disable404Route: true,
      customCss: ["./src/styles/theme.css", "./src/styles/docs.css"],
      expressiveCode: {
        themes: [codeTheme("disguise-dark"), codeTheme("disguise-light")],
        useStarlightDarkModeSwitch: true,
        useStarlightUiThemeColors: false,
        styleOverrides: {
          borderRadius: "10px",
          borderColor: ({ theme }) => (theme.type === "dark" ? "#2a3a2e" : "#d5dfd1"),
          codeFontFamily: "var(--im-font-mono)",
          uiFontFamily: "var(--im-font-mono)",
          codeFontSize: "0.8125rem",
          codeLineHeight: "1.75",
          frames: {
            shadowColor: "transparent",
            editorActiveTabIndicatorTopColor: ({ theme }) => (theme.type === "dark" ? "#c6ff4d" : "#2f7a12"),
            terminalTitlebarDotsForeground: ({ theme }) => (theme.type === "dark" ? "#2f4033" : "#bfcdbb"),
            inlineButtonBackground: ({ theme }) => (theme.type === "dark" ? "#c6ff4d" : "#2f7a12"),
            tooltipSuccessBackground: "#c6ff4d",
            tooltipSuccessForeground: "#0a0d0b"
          }
        }
      },
      sidebar: [
        { label: "Overview", slug: "docs" },
        {
          label: "Start here",
          items: [
            { label: "Getting started", slug: "docs/getting-started" },
            { label: "CLI", slug: "docs/cli" },
            { label: "Config file", slug: "docs/config-file" }
          ]
        },
        {
          label: "Mocking",
          items: [
            { label: "Stubs and predicates", slug: "docs/stubs" },
            { label: "Responses", slug: "docs/responses" },
            { label: "Proxy and record", slug: "docs/proxy" },
            { label: "Callbacks", slug: "docs/callbacks" },
            { label: "S3 emulator", slug: "docs/s3" }
          ]
        },
        {
          label: "Inspecting",
          items: [
            { label: "Request log and stats", slug: "docs/requests-and-stats" },
            { label: "Web UIs", slug: "docs/web-ui" }
          ]
        },
        {
          label: "Reference",
          items: [
            { label: "TypeScript client and test helpers", slug: "docs/client" },
            { label: "Admin API", slug: "docs/admin-api" }
          ]
        },
        { label: "Roadmap", link: "/roadmap/" }
      ]
    })
  ],
  vite: {
    resolve: {
      // The playground's imports from ../src resolve their packages from site/node_modules,
      // so the site builds without the library's own install
      dedupe: ["effect", "jsonata"]
    },
    server: { fs: { allow: [repoRoot] } }
  }
})
