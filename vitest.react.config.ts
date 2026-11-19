import { defineConfig } from "vitest/config";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
// The React test tools are dev dependencies of this package. The folder holding them is, in order: REACT_ENV if set; this
// package folder when `npm install` has put react in its own node_modules; otherwise the separate monorepo folder
// `../../.scratch/react-env` (a link to an existing install).
const own = existsSync(resolve(here, "node_modules/react")) ? here : undefined;
const envDir = process.env.REACT_ENV ?? own ?? resolve(here, "../../.scratch/react-env");
const modules = resolve(envDir, "node_modules");
const present = existsSync(resolve(modules, "react")) && existsSync(resolve(modules, "react-dom"))
  && existsSync(resolve(modules, "@testing-library/react")) && existsSync(resolve(modules, "jsdom"));

if (!present) {
  console.log(`UNPROVEN: react (no React test environment at ${envDir}; the React tests were skipped)`);
}

const pick = (names: string[]): Record<string, string> =>
  Object.fromEntries(names.map((n) => [n, resolve(modules, n)]));

export default defineConfig({
  root: here,
  test: {
    // With no environment there is nothing to run: an empty include is reported once above, not as a failure.
    include: present ? ["test/react/**/*.test.ts"] : [],
    passWithNoTests: !present,
    environment: "node",
    setupFiles: present ? ["./test/react/setup.ts"] : [],
  },
  resolve: {
    alias: present
      ? pick([
        "react/jsx-runtime", "react-dom/client", "react-dom/test-utils", "react", "react-dom",
        "@testing-library/react", "@testing-library/dom", "jsdom",
      ])
      : {},
  },
});
