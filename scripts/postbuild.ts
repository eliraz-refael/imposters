import * as fs from "node:fs"
import * as path from "node:path"

const distDir = path.resolve(import.meta.dir, "..", "dist")
const rootDir = path.resolve(import.meta.dir, "..")

// Version is set to 0.0.0 as placeholder — CI patches it from the git tag
const PLATFORM_PACKAGES = [
  "@imposters/linux-x64",
  "@imposters/linux-arm64",
  "@imposters/darwin-x64",
  "@imposters/darwin-arm64"
] as const

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
const version = distPkg.version || "0.0.0"
distPkg.optionalDependencies = Object.fromEntries(
  PLATFORM_PACKAGES.map((pkg) => [pkg, version])
)

fs.writeFileSync(distPkgPath, JSON.stringify(distPkg, null, 2) + "\n")

// 3. Copy .npmrc → dist/.npmrc
fs.copyFileSync(
  path.join(rootDir, ".npmrc"),
  path.join(distDir, ".npmrc")
)

console.log("postbuild: patched dist/package.json with bin and optionalDependencies")
console.log("postbuild: copied bin/imposters → dist/bin/imposters")
console.log("postbuild: copied .npmrc → dist/.npmrc")
