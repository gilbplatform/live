import { defineConfig } from "vitest/config";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
export default defineConfig({
  root: dirname(fileURLToPath(import.meta.url)),
  // The React tests need a page and the React tools; they have their own config (vitest.react.config.ts).
  test: { include: ["test/**/*.test.ts"], exclude: ["test/react/**", "node_modules/**"], environment: "node" },
});
