// Writes src/ui/assets/generated.ts (see scripts/ui-assets.ts). `bun gen-ui-assets`; the build
// runs it first.
import * as fs from "node:fs"
import * as path from "node:path"
import { generate, generatedPath, rootDir } from "./ui-assets.js"

const source = await generate()
fs.mkdirSync(path.dirname(generatedPath), { recursive: true })
const current = fs.existsSync(generatedPath) ? fs.readFileSync(generatedPath, "utf8") : ""
if (current === source) {
  console.log(`gen-ui-assets: ${path.relative(rootDir, generatedPath)} is up to date`)
} else {
  fs.writeFileSync(generatedPath, source)
  console.log(`gen-ui-assets: wrote ${path.relative(rootDir, generatedPath)} (${source.length} bytes)`)
}
