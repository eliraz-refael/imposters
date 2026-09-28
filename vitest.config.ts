import path from "path"
import { defineConfig } from "vitest/config"

export default defineConfig({
  plugins: [],
  test: {
    setupFiles: [path.join(__dirname, "setupTests.ts")],
    include: ["./test/**/*.test.ts"],
    globals: true
  },
  resolve: {
    alias: [
      { find: /^imposters\/test\/(.*)/, replacement: path.join(__dirname, "test/$1") },
      { find: /^imposters\/(.*)/, replacement: path.join(__dirname, "src/$1") }
    ],
    extensions: [".ts", ".tsx", ".js", ".jsx", ".json"]
  }
})
