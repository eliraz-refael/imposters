import path from "path"
import { defineConfig } from "vitest/config"

export default defineConfig({
  plugins: [],
  test: {
    setupFiles: [path.join(__dirname, "setupTests.ts")],
    include: ["./test/**/*.test.ts"],
    globals: true,
    // Test files run one at a time. The e2e suites bind fixed ports and their
    // imposter lifecycle is not actually synchronised: ServerFactory.create()
    // calls server.listen() without awaiting 'listening', and stop() calls
    // server.close() without awaiting 'close'. The suites paper over that with
    // fixed setTimeout sleeps, which stop being long enough once vitest runs
    // several files concurrently — producing ECONNREFUSED and responses served
    // by a previous test's server that had not finished closing.
    //
    // vitest 2 happened to schedule lightly enough to stay under that
    // threshold; vitest 3 does not. Serialising costs ~26s on the full suite.
    // Remove this once ServerFactory awaits listen/close properly.
    fileParallelism: false
  },
  resolve: {
    alias: [
      { find: /^imposters\/test\/(.*)/, replacement: path.join(__dirname, "test/$1") },
      { find: /^imposters\/(.*)/, replacement: path.join(__dirname, "src/$1") }
    ],
    extensions: [".ts", ".tsx", ".js", ".jsx", ".json"]
  }
})
