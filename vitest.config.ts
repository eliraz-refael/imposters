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
    alias: {
      "imposters/test": path.join(__dirname, "test"),
      "imposters": path.join(__dirname, "src")
    },
    extensions: [".ts", ".tsx", ".js", ".jsx", ".json"]
  }
})
