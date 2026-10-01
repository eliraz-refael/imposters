// Prints the roadmap model for a markdown file: bun scripts/roadmap-preview.ts ../ROADMAP.md
import { readFileSync } from "node:fs"
import { parseRoadmap } from "../src/lib/roadmap"

const file = process.argv[2] ?? "../ROADMAP.md"
console.log(JSON.stringify(parseRoadmap(readFileSync(file, "utf8")), null, 2))
