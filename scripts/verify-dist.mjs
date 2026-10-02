// Loads the built package the way a consumer would, in plain Node: every `exports` entry with an
// `import` condition through `import()`, every `require` / `default` entry through `require()`,
// plus the `bin`. Bundler-only output (extensionless relative imports) passes tsx, vitest and
// esbuild but fails here with ERR_MODULE_NOT_FOUND.
//
// Run after `bun run build`: `bun run verify-dist` (or `node scripts/verify-dist.mjs`).
import { Buffer } from "node:buffer"
import { spawn, spawnSync } from "node:child_process"
import console from "node:console"
import * as fs from "node:fs"
import * as http from "node:http"
import * as net from "node:net"
import * as os from "node:os"
import * as path from "node:path"
import process from "node:process"
import { clearTimeout, setTimeout } from "node:timers"
import { fileURLToPath, URL } from "node:url"

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
  // A module can fail after it loads (the CLI's runMain exits non-zero once its fiber fails)
  const exit = child.status === 0
    ? []
    : [`${label}: loader exited ${child.status} (signal ${child.signal})\n${child.stderr}`]
  return [...failures.map((f) => `${label} ${f.spec}\n    ${f.error.split("\n")[0]}`), ...exit]
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

// A port nothing listens on: bind 0, read it, release it
const sparePort = () =>
  new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address()
      server.close(() => resolve(port))
    })
  })

// A GET on a fresh connection: the status, headers and whole body
const httpGet = (url) =>
  new Promise((resolve, reject) => {
    http.get(url, { agent: false }, (res) => {
      const chunks = []
      res.on("data", (chunk) => chunks.push(chunk))
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }))
      res.on("error", reject)
    }).on("error", reject)
  })

// Starts the bin for real and loads the admin UI and one of its hashed assets, so a bundle that
// lost the compiled-in assets (or the router that serves them) fails here, not for a user.
const smokeCheck = async () => {
  const [binFile] = Object.values(typeof pkg.bin === "string" ? { [pkg.name]: pkg.bin } : (pkg.bin ?? {}))
  if (binFile === undefined) return ["smoke: no bin to start"]
  const port = await sparePort()
  const child = spawn(process.execPath, [path.join(distDir, binFile), "start", "--port", String(port)], {
    cwd: consumer,
    stdio: ["ignore", "pipe", "pipe"]
  })
  let output = ""
  child.stdout.on("data", (chunk) => output += chunk)
  child.stderr.on("data", (chunk) => output += chunk)
  try {
    // The CLI prints this line once the admin port is bound
    const uiUrl = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("did not start within 30 s")), 30_000)
      child.once("exit", (code) => reject(new Error(`exited ${code} before it was ready`)))
      child.stdout.on("data", () => {
        const match = /Admin UI: (\S+)/.exec(output)
        if (match !== null) {
          clearTimeout(timer)
          resolve(match[1])
        }
      })
    })
    const page = await httpGet(uiUrl)
    if (page.status !== 200) return [`smoke: GET /_ui answered ${page.status}`]
    const asset = /href="(\/_ui\/assets\/[^"]+)"/.exec(page.body.toString("utf-8"))?.[1]
    if (asset === undefined) return ["smoke: /_ui links no hashed asset"]
    const resp = await httpGet(new URL(asset, uiUrl))
    const cache = resp.headers["cache-control"] ?? ""
    if (resp.status !== 200 || !cache.includes("immutable") || resp.body.length === 0) {
      return [`smoke: GET ${asset} answered ${resp.status} (cache-control: ${cache})`]
    }
    console.log(`smoke: bin start on :${port} serves /_ui and ${asset}`)
    return []
  } catch (e) {
    return [`smoke: ${e.message}\n${output}`]
  } finally {
    child.kill()
  }
}

const problems = [
  ...missing.map((m) => `missing file: ${m}`),
  ...check("esm import()", "load.mjs", esm),
  ...check("cjs require()", "load.cjs", cjs),
  ...binCheck(),
  ...await smokeCheck()
]
fs.rmSync(consumer, { recursive: true, force: true })

if (problems.length > 0) {
  console.error(`\nverify-dist: ${problems.length} problem(s)\n  ${problems.join("\n  ")}`)
  process.exit(1)
}
console.log("verify-dist: ok")
