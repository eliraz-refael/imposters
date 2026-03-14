import * as fs from "node:fs"
import * as path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const distDir = path.resolve(__dirname, "..", "dist")
const rootDir = path.resolve(__dirname, "..")

// 1. Copy bin/imposters → dist/bin/imposters
const distBinDir = path.join(distDir, "bin")
fs.mkdirSync(distBinDir, { recursive: true })
fs.copyFileSync(
  path.join(rootDir, "bin", "imposters"),
  path.join(distBinDir, "imposters")
)
fs.chmodSync(path.join(distBinDir, "imposters"), 0o755)

// 2. Patch dist/package.json — add bin entry
const distPkgPath = path.join(distDir, "package.json")
const distPkg = JSON.parse(fs.readFileSync(distPkgPath, "utf-8"))

distPkg.bin = { imposters: "./bin/imposters" }

fs.writeFileSync(distPkgPath, JSON.stringify(distPkg, null, 2) + "\n")

// 3. Copy .npmrc → dist/.npmrc
fs.copyFileSync(
  path.join(rootDir, ".npmrc"),
  path.join(distDir, ".npmrc")
)

console.log("postbuild: patched dist/package.json with bin")
console.log("postbuild: copied bin/imposters → dist/bin/imposters")
console.log("postbuild: copied .npmrc → dist/.npmrc")
