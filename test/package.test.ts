import { describe, expect, test } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import * as api from "../src/index.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const FILES = ["dist", "README.md", "LICENSE", "CHANGELOG.md"];
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as Record<string, unknown>;

describe("package shape", () => {
  // Spec: Kit.Client, Package: the manifest is the agreed one (LiveWire step, check Package.Manifest)
  test("PK1 package.json", () => {
    expect(pkg.name).toBe("@gilbplatform/live");
    expect("private" in pkg).toBe(false);
    expect(pkg.version).toBe("0.1.0");
    expect(pkg.license).toBe("MIT");
    expect(pkg.author).toBe("Kai Gilb");
    expect(pkg.repository).toEqual({ type: "git", url: "git+https://github.com/gilbplatform/live.git" });
    expect(pkg.homepage).toBe("https://github.com/gilbplatform/live#readme");
    expect((pkg.bugs as { url: string }).url).toBe("https://github.com/gilbplatform/live/issues");
    expect(pkg.publishConfig).toEqual({ access: "public" });
    expect(pkg.type).toBe("module");
    expect(pkg.sideEffects).toBe(false);
    expect("dependencies" in pkg).toBe(false);
    // React is an optional peer, reached only through the "./react" subpath; the core needs nothing.
    expect(pkg.peerDependencies).toEqual({ react: "^18.2.0 || ^19.0.0" });
    expect(pkg.peerDependenciesMeta).toEqual({ react: { optional: true } });
    const exportsMap = pkg.exports as Record<string, { types: string; default: string }>;
    expect(Object.keys(exportsMap)).toEqual([".", "./react", "./package.json"]);
    // The manifest itself is exported, as a plain path, so a tool can read the installed version.
    expect((exportsMap as Record<string, unknown>)["./package.json"]).toBe("./package.json");
    const dot = exportsMap["."];
    expect(dot?.types.startsWith("./dist/")).toBe(true);
    expect(dot?.default.startsWith("./dist/")).toBe(true);
    expect(exportsMap["./react"]?.types.startsWith("./dist/react/")).toBe(true);
    expect(exportsMap["./react"]?.default.startsWith("./dist/react/")).toBe(true);
    expect(pkg.files).toEqual(FILES);
    expect((pkg.engines as { node: string }).node).toBe(">=22");
    for (const k of ["gilbplatform", "live", "real-time", "sse", "server-sent-events", "change-feed", "dashboard", "store"]) {
      expect(pkg.keywords as string[]).toContain(k);
    }
    const scripts = pkg.scripts as Record<string, string>;
    for (const k of ["prepack", "build", "clean", "test:react"]) expect(typeof scripts[k], `scripts.${k}`).toBe("string");
    const dev = pkg.devDependencies as Record<string, string>;
    expect(Object.keys(dev).sort()).toEqual([
      "@testing-library/dom", "@testing-library/react", "@types/node", "@types/react", "@types/react-dom",
      "jsdom", "react", "react-dom", "typescript", "vitest",
    ]);
    // The React test tools are pinned exactly: these are the versions the React tests run against.
    expect({
      "@types/react": dev["@types/react"], "@types/react-dom": dev["@types/react-dom"], react: dev.react, "react-dom": dev["react-dom"],
      "@testing-library/react": dev["@testing-library/react"], "@testing-library/dom": dev["@testing-library/dom"], jsdom: dev.jsdom,
    }).toEqual({
      "@types/react": "19.2.17", "@types/react-dom": "19.2.3", react: "19.2.7", "react-dom": "19.2.7",
      "@testing-library/react": "16.3.2", "@testing-library/dom": "10.4.1", jsdom: "29.1.1",
    });
  });

  // Spec: Kit.Client, Package: the manifest is exported and the published file list is unchanged (@gilbplatform/live/package.json resolves)
  test("PK7 package.json is exported and the files list is unchanged", () => {
    const exportsMap = pkg.exports as Record<string, unknown>;
    expect("./package.json" in exportsMap).toBe(true);
    expect(typeof exportsMap["./package.json"]).toBe("string");
    expect(exportsMap["./package.json"]).toBe("./package.json");
    // The target must be a file the package really ships: package.json is always packed, and it is this very file.
    expect(existsSync(join(root, exportsMap["./package.json"] as string))).toBe(true);
    expect(pkg.files).toEqual(FILES);
  });

  // Spec: Kit.Client, Package: licence and README are present and findable (check Package.Findable)
  test("PK2 licence and files", () => {
    const licence = readFileSync(join(root, "LICENSE"), "utf8");
    expect(licence.startsWith("MIT License")).toBe(true);
    expect(licence).toContain("Copyright (c) 2026 Kai Gilb");
    const readme = readFileSync(join(root, "README.md"), "utf8");
    const head = readme.slice(0, 600);
    expect(head).toContain("npm install @gilbplatform/live");
    for (const banned of ["not published", "private: true", "To be confirmed", "L17", "@gilb" + "/live"]) expect(readme.includes(banned), banned).toBe(false);
    const changelog = readFileSync(join(root, "CHANGELOG.md"), "utf8");
    expect(changelog.startsWith("# Changelog")).toBe(true);
    expect(changelog).toContain("## 0.1.0");
    expect(head).toContain("GilbPlatform");
    expect(head).toContain("live dashboard");
    expect(head).toContain("server-sent events");
    for (const rel of readdirSync(root, { recursive: true, encoding: "utf8" })) {
      if (rel.startsWith("dist") || rel.startsWith("node_modules")) continue;
      // Standalone dev writes package-lock.json; it is git-ignored and never packed, so its size is not checked.
      if (rel === "package-lock.json") continue;
      const st = statSync(join(root, rel));
      if (st.isFile()) expect(st.size, rel).toBeLessThanOrEqual(100 * 1024);
    }
  });

  // Spec: Kit.Client, Package: no lock file; no nested install inside the monorepo (check Package.NoInstall)
  test("PK3 inside GilbPlatform: no lock file and no nested install", () => {
    const parent = join(root, "../../package.json");
    const inMonorepo = existsSync(parent) && (JSON.parse(readFileSync(parent, "utf8")) as { name?: string }).name === "gilbplatform";
    if (!inMonorepo) {
      console.log("PK3: standalone, a lock file and an install of its own are allowed");
      return;
    }
    for (const f of ["package-lock.json", "pnpm-lock.yaml", "yarn.lock"]) {
      expect(existsSync(join(root, f)), f).toBe(false);
    }
    // Vitest, run with this folder as its root, keeps its own cache in node_modules/.vite; that is not an install.
    // Anything else in there (an installed package) is a nested install.
    const nm = join(root, "node_modules");
    const entries = existsSync(nm) ? readdirSync(nm) : [];
    expect(entries.filter((e) => e !== ".vite" && e !== ".vite-temp")).toEqual([]);
  });

  // Spec: Kit.Client, Package: a clone stays clean after npm install (the lock and the install folder are git-ignored)
  test("PK8 a clone stays clean after npm install", () => {
    const lines = readFileSync(join(root, ".gitignore"), "utf8").split(/\r?\n/).map((l) => l.trim());
    for (const want of ["node_modules/", "dist/", "*.tgz", "package-lock.json"]) expect(lines, want).toContain(want);
  });

  // Spec: Kit.Client, Package: the dev tools carry open licences (check Package.Licences)
  test("PK4 licences of the dev tools", () => {
    const allowed = ["MIT", "Apache-2.0", "ISC", "BSD-2-Clause", "BSD-3-Clause"];
    const dev = Object.keys(pkg.devDependencies as object);
    // Find a tool's package.json the way Node does: each node_modules from this folder upwards.
    // In the monorepo the React tools sit in a separate folder, so that one is searched last.
    const places: string[] = [];
    for (let d = root; ; d = dirname(d)) {
      places.push(join(d, "node_modules"));
      if (dirname(d) === d) break;
    }
    places.push(resolve(root, "../../.scratch/react-env/node_modules"));
    const seen: Record<string, string> = {};
    for (const name of dev) {
      const hit = places.map((p) => join(p, name, "package.json")).find((f) => existsSync(f));
      if (!hit) {
        seen[name] = "UNPROVEN (not installed here)";
        continue;
      }
      const p = JSON.parse(readFileSync(hit, "utf8")) as { license?: string };
      seen[name] = String(p.license);
      expect(allowed, name).toContain(p.license);
    }
    console.log("dev tool licences:", JSON.stringify(seen));
    for (const [n, v] of Object.entries(seen)) if (v.startsWith("UNPROVEN")) console.log(`UNPROVEN: licence of ${n}`);
  });

  // Spec: Kit.Client, Package: the public surface is exactly the agreed names (check Package.Surface)
  test("PK5 exports surface", () => {
    expect(Object.keys(api).sort()).toEqual([
      "BACKOFF_BASE_MS",
      "BACKOFF_CAP_MS",
      "CANNOT_DRAW_TEXT",
      "CHECK_FAILED_TEXT",
      "DEFAULT_COALESCE_MS",
      "DEFAULT_HEARTBEAT_WINDOW_MS",
      "DEFAULT_HIDDEN_CLOSE_MS",
      "DEFAULT_HOLD_MS",
      "DEFAULT_MAX_PARALLEL_READS",
      "DEFAULT_OFFLINE_AFTER_MS",
      "DEFAULT_POLL_WINDOW_MS",
      "DEFAULT_READ_BATCH_SIZE",
      "DEFAULT_STATE_MAX_AGE_MS",
      "DEFAULT_STATE_MAX_ROWS",
      "LIMITS_ORDER_TEXT",
      "MAX_COALESCE_MS",
      "MAX_HOLD_MS",
      "MAX_READ_BATCH_SIZE",
      "MAX_TOMBSTONES",
      "NOT_SET_TEXT",
      "NO_DATA_TEXT",
      "NO_LIMITS_TEXT",
      "NO_STATUS_TEXT",
      "RETRY_AFTER_DEFAULT_MS",
      "RETRY_AFTER_MAX_MS",
      "RETRY_AFTER_MIN_MS",
      "STATE_CACHE_VERSION",
      "SseTooLargeError",
      "TRACE_ATTR",
      "UNNAMED_TEXT",
      "buildPlanValueRow",
      "clampRetryHintMs",
      "computeDot",
      "createCoalescer",
      "createConfirmationClock",
      "createDotMachine",
      "createKitLiveSource",
      "createLiveClient",
      "createLiveSession",
      "createLiveStore",
      "createLiveTransport",
      "createMemoryCache",
      "createSseParser",
      "createStateCache",
      "feedUrl",
      "isCursor",
      "liveUrl",
      "nextBackoffMs",
      "normalizeOrigin",
      "notificationsFromFeed",
      "parseFeedPage",
      "parseLiveNotification",
      "planValueDrawable",
      "planValueSentence",
      "planValueWords",
      "readTraceAttrs",
      "retryAfterMs",
      "scanTrace",
      "toLiveStatusInfo",
      "traceAttrs",
      "watchVisibility",
    ]);
    expect([api.DEFAULT_HOLD_MS, api.DEFAULT_MAX_PARALLEL_READS, api.MAX_HOLD_MS, api.MAX_TOMBSTONES]).toEqual([250, 4, 500, 10000]);
  });

  // Spec: Kit.React, ZeroDependency: the core never imports react; only src/react does (check PK6)
  test("PK6 the core imports no react; src/react imports react or the core only", () => {
    const srcRoot = join(root, "src");
    const files = readdirSync(srcRoot, { recursive: true, encoding: "utf8" }).filter((f) => f.endsWith(".ts"));
    const specs = (body: string): string[] => [...body.matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']/g)].map((m) => m[1] as string);
    const core = files.filter((f) => !f.startsWith("react/"));
    expect(core).toContain("index.ts");
    for (const f of core) {
      const body = readFileSync(join(srcRoot, f), "utf8");
      for (const s of specs(body)) expect(/^react(\/|$)|react-dom|\.\/react/.test(s), `${f} imports ${s}`).toBe(false);
      expect(/require\(\s*["']react/.test(body), f).toBe(false);
    }
    for (const f of files.filter((x) => x.startsWith("react/"))) {
      for (const s of specs(readFileSync(join(srcRoot, f), "utf8"))) {
        expect(s === "react" || s.startsWith("./") || s.startsWith("../"), `${f} imports ${s}`).toBe(true);
      }
    }
    // The built core, when there is one, must not mention react either.
    const built = join(root, "dist", "index.js");
    if (existsSync(built)) {
      for (const f of readdirSync(join(root, "dist"), { encoding: "utf8" }).filter((x) => x.endsWith(".js"))) {
        for (const s of specs(readFileSync(join(root, "dist", f), "utf8"))) expect(s.includes("react"), `dist/${f} imports ${s}`).toBe(false);
      }
    }
  });
});
