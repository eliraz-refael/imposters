// Loads the built package the way a consumer would, in plain Node: every `exports` entry with an
// `import` condition through `import()`, every `require` / `default` entry through `require()`,
// plus the `bin`. Bundler-only output (extensionless relative imports) passes tsx, vitest and
// esbuild but fails here with ERR_MODULE_NOT_FOUND.
//
// Run after `bun run build`: `bun run verify-dist` (or `node scripts/verify-dist.mjs`).
import { spawnSync } from "node:child_process"
import console from "node:console"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import process from "node:process"
import { fileURLToPath } from "node:url"

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const distDir = path.join(rootDir, "dist")
const pkg = JSON.parse(fs.readFileSync(path.join(distDir, "package.json"), "utf-8"))
const RESULT = "VERIFY_DIST_RESULT:"

const specifier = (subpath) => subpath === "." ? pkg.name : `${pkg.name}/${subpath.slice(2)}`

const esm = []
const cjs = []
const missing = []
for (const [subpath, target] of Object.entries(pkg.exports)) {
  if (typeof target !== "object" || target === null) continue
  for (const [condition, file] of Object.entries(target)) {
    if (!fs.existsSync(path.join(distDir, file))) missing.push(`${subpath} [${condition}] -> ${file}`)
  }
  if (target.import) esm.push(specifier(subpath))
  if (target.require ?? target.default) cjs.push(specifier(subpath))
}

// A consumer project whose node_modules/<name> is dist/, so specifiers go through `exports`.
const consumer = fs.mkdtempSync(path.join(os.tmpdir(), "imposters-verify-dist-"))
fs.mkdirSync(path.join(consumer, "node_modules"))
fs.symlinkSync(distDir, path.join(consumer, "node_modules", pkg.name), "dir")
fs.writeFileSync(path.join(consumer, "package.json"), JSON.stringify({ name: "consumer", private: true }))

// `./Program` and `./cli/Commands` run the CLI at module scope, and it parses process.argv:
// give it `--version` so it prints and succeeds instead of reading this child's arguments.
const loader = (load) => `
process.argv = [process.argv[0], "imposters", "--version"]
const failures = []
for (const spec of JSON.parse(process.env.VERIFY_SPECS)) {
  try { ${load} } catch (e) { failures.push({ spec, error: String(e && e.code ? e.code + ": " + e.message : e) }) }
}
console.log(${JSON.stringify(RESULT)} + JSON.stringify(failures))
`
fs.writeFileSync(path.join(consumer, "load.mjs"), loader("await import(spec)"))
fs.writeFileSync(path.join(consumer, "load.cjs"), loader("require(spec)"))

const run = (args, env = {}) =>
  spawnSync(process.execPath, args, {
    cwd: consumer,
    encoding: "utf-8",
    env: { ...process.env, ...env },
    timeout: 60_000
  })

const check = (label, file, specs) => {
  const child = run([file], { VERIFY_SPECS: JSON.stringify(specs) })
  const line = (child.stdout ?? "").split("\n").find((l) => l.startsWith(RESULT))
  if (line === undefined) {
    return [`${label}: loader did not finish (status ${child.status}, signal ${child.signal})\n${child.stderr}`]
  }
  const failures = JSON.parse(line.slice(RESULT.length))
  console.log(`${label}: ${specs.length - failures.length}/${specs.length} entries load`)
  return failures.map((f) => `${label} ${f.spec}\n    ${f.error.split("\n")[0]}`)
}

const binCheck = () => {
  const bins = typeof pkg.bin === "string" ? { [pkg.name]: pkg.bin } : (pkg.bin ?? {})
  return Object.entries(bins).flatMap(([name, file]) => {
    const child = run([path.join(distDir, file), "--version"])
    if (child.status === 0) {
      console.log(`bin ${name}: --version -> ${child.stdout.trim()}`)
      return []
    }
    return [`bin ${name} (${file}) exited ${child.status}\n${child.stderr}`]
  })
}

const problems = [
  ...missing.map((m) => `missing file: ${m}`),
  ...check("esm import()", "load.mjs", esm),
  ...check("cjs require()", "load.cjs", cjs),
  ...binCheck()
]
fs.rmSync(consumer, { recursive: true, force: true })

if (problems.length > 0) {
  console.error(`\nverify-dist: ${problems.length} problem(s)\n  ${problems.join("\n  ")}`)
  process.exit(1)
}
console.log("verify-dist: ok")
