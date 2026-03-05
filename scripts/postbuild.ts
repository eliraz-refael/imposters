import * as fs from "node:fs"
import * as path from "node:path"

const distDir = path.resolve(import.meta.dir, "..", "dist")
const rootDir = path.resolve(import.meta.dir, "..")

const PLATFORM_PACKAGES = {
  "@imposters/linux-x64": "0.2.1",
  "@imposters/linux-arm64": "0.2.1",
  "@imposters/darwin-x64": "0.2.1",
  "@imposters/darwin-arm64": "0.2.1"
} as const

// 1. Copy bin/imposters → dist/bin/imposters
const distBinDir = path.join(distDir, "bin")
fs.mkdirSync(distBinDir, { recursive: true })
fs.copyFileSync(
  path.join(rootDir, "bin", "imposters"),
  path.join(distBinDir, "imposters")
)
fs.chmodSync(path.join(distBinDir, "imposters"), 0o755)

// 2. Patch dist/package.json
const distPkgPath = path.join(distDir, "package.json")
const distPkg = JSON.parse(fs.readFileSync(distPkgPath, "utf-8"))

distPkg.bin = { imposters: "./bin/imposters" }
distPkg.optionalDependencies = { ...PLATFORM_PACKAGES }

fs.writeFileSync(distPkgPath, JSON.stringify(distPkg, null, 2) + "\n")

// 3. Copy .npmrc → dist/.npmrc
fs.copyFileSync(
  path.join(rootDir, ".npmrc"),
  path.join(distDir, ".npmrc")
)

console.log("postbuild: patched dist/package.json with bin and optionalDependencies")
console.log("postbuild: copied bin/imposters → dist/bin/imposters")
console.log("postbuild: copied .npmrc → dist/.npmrc")
