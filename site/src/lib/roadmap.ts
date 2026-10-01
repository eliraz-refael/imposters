/**
 * Turns the repo-root ROADMAP.md into the roadmap page's model, at build time.
 *
 * `## Now`, `## Next` and `## Later` sections become columns, and each bullet in them a card:
 * `- **Title**: description ([#12](https://github.com/.../issues/12))` gives the card a title,
 * a description and an issue badge. Anything else in the file (other sections, prose, tables,
 * bullets without a bold title) is rendered as ordinary markdown, so any ROADMAP.md reads sensibly.
 */
import { Marked, type Token, type Tokens } from "marked"

// GitHub-style heading ids, so in-file links such as [Phase 6](#phase-6-advanced-features) keep working
const slug = (text: string): string =>
  text.toLowerCase().trim().replace(/<[^>]*>/g, "").replace(/[^\p{L}\p{N}\s_-]/gu, "").replace(/\s/g, "-")

const marked = new Marked({
  renderer: {
    heading({ depth, text, tokens }) {
      return `<h${depth} id="${slug(text)}">${this.parser.parseInline(tokens)}</h${depth}>\n`
    }
  }
})

export type LaneKey = "now" | "next" | "later"

export interface Issue {
  readonly label: string
  readonly href: string
}

export interface Card {
  readonly title: string | undefined
  readonly html: string
  readonly issues: ReadonlyArray<Issue>
}

export interface Lane {
  readonly key: LaneKey
  readonly title: string
  readonly introHtml: string
  readonly cards: ReadonlyArray<Card>
}

export interface Roadmap {
  readonly title: string | undefined
  readonly introHtml: string
  readonly lanes: ReadonlyArray<Lane>
  readonly restHtml: string
}

const LANE_ORDER: ReadonlyArray<LaneKey> = ["now", "next", "later"]

const laneOf = (heading: string): LaneKey | undefined => {
  const word = heading.toLowerCase().replace(/[^a-z]/g, "")
  return LANE_ORDER.find((key) => key === word)
}

const ISSUE_LINK = /\(?\[(#\d+)\]\(([^)\s]+)\)\)?/g
// "([#14](...), [#15](...))": one parenthesised group of issue links
const ISSUE_GROUP = /\s*\((?:\s*\[#\d+\]\([^)\s]+\)\s*,?)+\s*\)/g
const TITLED = /^\*\*(.+?)\*\*\s*[:–—-]?\s*([\s\S]*)$/

// ROADMAP.md links relative to the repo (README.md, src/...) point at GitHub on the site
const REPO_BLOB = "https://github.com/eliraz-refael/imposters/blob/master/"
const absolutize = (html: string): string =>
  html.replace(/(href|src)="(?![a-z][a-z0-9+.-]*:|#|\/)([^"]+)"/gi, (_, attr: string, path: string) =>
    `${attr}="${REPO_BLOB}${path.replace(/^\.\//, "")}"`)

const render = (tokens: Array<Token>): string => absolutize(marked.parser(tokens))
const parseBlock = (text: string): string => absolutize(marked.parse(text, { async: false }))
const parseInline = (text: string): string => absolutize(marked.parseInline(text, { async: false }))

const toCard = (item: Tokens.ListItem): Card => {
  const text = item.text.trim()
  const issues = Array.from(text.matchAll(ISSUE_LINK), ([, label = "", href = ""]) => ({ label, href }))
  // "desc ([#12](...))." leaves "desc ." behind: drop the gap before a trailing full stop
  const withoutIssues = text.replace(ISSUE_GROUP, "").replace(ISSUE_LINK, "").replace(/\s+([.,;]?)\s*$/, "$1").trim()
  const titled = TITLED.exec(withoutIssues)
  if (titled === null) {
    return { title: undefined, html: parseBlock(withoutIssues), issues }
  }
  const [, title = "", rest = ""] = titled
  return {
    title: parseInline(title),
    html: rest.trim().length > 0 ? parseBlock(rest.trim()) : "",
    issues
  }
}

export const parseRoadmap = (source: string): Roadmap => {
  const tokens = marked.lexer(source)

  let title: string | undefined
  const intro: Array<Token> = []
  const lanes = new Map<LaneKey, { title: string; intro: Array<Token>; cards: Array<Card> }>()
  const rest: Array<Token> = []

  let section: { kind: "intro" } | { kind: "lane"; key: LaneKey } | { kind: "rest" } = { kind: "intro" }

  for (const token of tokens) {
    if (token.type === "heading" && token.depth === 1 && title === undefined && section.kind === "intro") {
      title = token.text
      continue
    }
    if (token.type === "heading" && token.depth === 2) {
      const key = laneOf(token.text)
      if (key !== undefined && !lanes.has(key)) {
        lanes.set(key, { title: token.text, intro: [], cards: [] })
        section = { kind: "lane", key }
        continue
      }
      section = { kind: "rest" }
      rest.push(token)
      continue
    }
    if (section.kind === "intro") {
      intro.push(token)
    } else if (section.kind === "rest") {
      rest.push(token)
    } else {
      const lane = lanes.get(section.key)
      if (lane === undefined) continue
      if (token.type === "list") {
        for (const item of (token as Tokens.List).items) lane.cards.push(toCard(item))
      } else {
        lane.intro.push(token)
      }
    }
  }

  // marked.parser needs the link definitions the lexer collected
  const withLinks = (list: Array<Token>): Array<Token> => Object.assign(list, { links: tokens.links })

  return {
    title,
    introHtml: render(withLinks(intro)),
    lanes: LANE_ORDER.flatMap((key) => {
      const lane = lanes.get(key)
      return lane === undefined
        ? []
        : [{ key, title: lane.title, introHtml: render(withLinks(lane.intro)), cards: lane.cards }]
    }),
    restHtml: render(withLinks(rest))
  }
}
