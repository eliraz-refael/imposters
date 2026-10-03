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

// build-utils pack-v2 copies author and homepage but drops these npm fields
const rootPkg = JSON.parse(fs.readFileSync(path.join(rootDir, "package.json"), "utf-8"))
for (const key of ["keywords", "bugs"]) {
  if (rootPkg[key] !== undefined) distPkg[key] = rootPkg[key]
}

fs.writeFileSync(distPkgPath, JSON.stringify(distPkg, null, 2) + "\n")

// 3. Copy .npmrc → dist/.npmrc
fs.copyFileSync(
  path.join(rootDir, ".npmrc"),
  path.join(distDir, ".npmrc")
)

// 4. The UI's fonts (compiled into src/ui/assets/generated.ts) are OFL-1.1: ship their licenses
const distLicensesDir = path.join(distDir, "licenses")
fs.mkdirSync(distLicensesDir, { recursive: true })
const fontLicenses = ["martian-mono", "geist"].map((font) => {
  const target = `${font}-OFL-1.1.txt`
  fs.copyFileSync(
    path.join(rootDir, "node_modules", "@fontsource-variable", font, "LICENSE"),
    path.join(distLicensesDir, target)
  )
  return target
})

// 5. Drop the source copy of the generated assets: nothing loads it, and the fonts' base64 would
// ship a fourth time (the ESM, CJS and CLI builds each carry their own)
const generatedSource = path.join(distDir, "src", "ui", "assets", "generated.ts")
fs.rmSync(generatedSource, { force: true })

console.log("postbuild: patched dist/package.json with bin")
console.log("postbuild: copied bin/imposters → dist/bin/imposters")
console.log("postbuild: copied .npmrc → dist/.npmrc")
console.log(`postbuild: copied font licenses → dist/licenses/{${fontLicenses.join(",")}}`)
console.log("postbuild: removed dist/src/ui/assets/generated.ts")
