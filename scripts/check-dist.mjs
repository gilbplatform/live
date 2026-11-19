// Checks a built `dist` folder before it is packed: every promised file is there, and every source map
// carries its own source and no path from the machine that built it.
// Run: `node scripts/check-dist.mjs [folder]` (default `dist`). Exits 0, or exits 1 and names each problem.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, "..");

/** Every file under `dir`, as forward-slash paths relative to `dir`. */
function listFiles(dir) {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => relative(dir, join(e.parentPath ?? e.path, e.name)).split("\\").join("/"));
}

/** The files a complete build holds, as `dist/...` paths: the two entries, every target of the exports map, and a .js and a .d.ts for each src file. */
function expectedFiles() {
  const want = new Set(["dist/index.js", "dist/index.d.ts", "dist/react/index.js", "dist/react/index.d.ts"]);
  const pkg = JSON.parse(readFileSync(join(pkgRoot, "package.json"), "utf8"));
  for (const target of Object.values(pkg.exports ?? {})) {
    for (const t of typeof target === "string" ? [target] : Object.values(target)) {
      if (typeof t === "string" && t.startsWith("./dist/")) want.add(t.slice(2));
    }
  }
  for (const f of listFiles(join(pkgRoot, "src"))) {
    if (!f.endsWith(".ts")) continue;
    const base = f.slice(0, -3);
    want.add(`dist/${base}.js`);
    want.add(`dist/${base}.d.ts`);
  }
  return [...want].sort();
}

/**
 * Names the promised files that are missing from a list of built files.
 * @param {string[]} files Paths of the built files, each starting `dist/` (for example `dist/index.js`).
 * @returns {string[]} The missing `dist/...` paths, sorted; empty when the build is complete.
 */
export function missingFromDist(files) {
  const have = new Set(files.map((f) => f.split("\\").join("/")));
  return expectedFiles().filter((f) => !have.has(f));
}

/**
 * Finds source maps that would ship badly: no `sourcesContent`, one entry fewer than `sources`, a `null` entry,
 * or a source path that is absolute or names a person's home folder.
 * @param {string} dir The folder to search, recursively, for `.map` files.
 * @returns {string[]} One line per bad map, `<path>: <reason>`; empty when all are good.
 */
export function badMaps(dir) {
  const bad = [];
  for (const rel of listFiles(dir).filter((f) => f.endsWith(".map")).sort()) {
    let map;
    try {
      map = JSON.parse(readFileSync(join(dir, rel), "utf8"));
    } catch {
      bad.push(`${rel}: not valid JSON`);
      continue;
    }
    const sources = Array.isArray(map.sources) ? map.sources : [];
    const content = map.sourcesContent;
    if (!Array.isArray(content)) bad.push(`${rel}: sourcesContent is missing`);
    else if (content.length < sources.length) bad.push(`${rel}: sourcesContent is short (${content.length} of ${sources.length})`);
    else if (content.some((c) => typeof c !== "string")) bad.push(`${rel}: sourcesContent holds a null`);
    for (const s of sources) {
      if (typeof s !== "string" || /^([a-zA-Z]:|\/|file:)/.test(s) || s.includes("/Us" + "ers/")) bad.push(`${rel}: source path is absolute or personal`);
    }
  }
  return bad;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dir = resolve(process.argv[2] ?? "dist");
  if (!existsSync(dir)) {
    console.log(`FAIL: ${dir} does not exist`);
    process.exit(1);
  }
  const problems = [
    ...missingFromDist(listFiles(dir).map((f) => `dist/${f}`)).map((f) => `missing ${f}`),
    ...badMaps(dir),
  ];
  if (problems.length > 0) {
    for (const p of problems) console.log(`FAIL: ${p}`);
    process.exit(1);
  }
  console.log("PASS: dist is complete and its maps are good");
}
