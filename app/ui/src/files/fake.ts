// Fake data for Files, the viewer and Search until step 2.17 wires them to Rust; it goes then. What Rust will work out
// (marks, filename search, content search, Replace all) is faked here, never in the views.
import { fuzzyMatch } from "../components/composer/menus";
import { baseName } from "./tree";
import type { ChangeMarks, FileList, FolderEntry, ReplaceOutcome, SearchFile, SearchQuery, SearchResults } from "./types";

const SOURCES: Record<string, string> = {
  "src/upload/retry.ts": `import { sleep } from "../lib/time";

/** Retries an upload with backoff. */
export async function retry<T>(run: () => Promise<T>, attempts = 3): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await run();
    } catch (error) {
      lastError = error;
      await sleep(2 ** attempt * 250);
    }
  }
  throw lastError;
}
`,
  "src/upload/client.ts": `import { retry } from "./retry";

export class UploadClient {
  constructor(private readonly endpoint: string) {}

  async upload(file: Blob): Promise<string> {
    return retry(async () => {
      const response = await fetch(this.endpoint, { method: "POST", body: file });
      if (!response.ok) throw new Error(\`upload failed: \${response.status}\`);
      return response.text();
    });
  }
}
`,
  "src/lib/time.ts": `export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));\n`,
  "README.md": "# Uploader\n\nUploads files with retry and a progress tray.\n",
};

/** A long file: about 3,000 lines of TypeScript, the same every time. */
export const LONG_FILE = Array.from({ length: 300 }, (_, block) =>
  [
    `/** Step ${block + 1} of the pipeline: reads, checks and hands on a batch. */`,
    `export async function step${block + 1}(batch: Batch, retry = 3): Promise<Batch> {`,
    `  const started = performance.now();`,
    `  const items = batch.items.filter((item) => item.size > 0 && !item.skipped);`,
    `  if (items.length === 0) return { ...batch, done: true };`,
    `  for (const item of items) await upload(item, { attempts: retry, label: "step${block + 1}" });`,
    `  log(\`step${block + 1} took \${Math.round(performance.now() - started)} ms\`);`,
    `  return { ...batch, items, done: false };`,
    `}`,
    ``,
  ].join("\n"),
).join("\n");

export const FILES: FileList = {
  files: [
    ".gitignore",
    "Cargo.toml",
    "README.md",
    "package.json",
    "pnpm-lock.yaml",
    "tsconfig.json",
    "docs/upload.md",
    "src/main.tsx",
    "src/pipeline.ts",
    "src/lib/time.ts",
    "src/lib/format.ts",
    "src/tray/Progress.tsx",
    "src/tray/tray.css",
    "src/upload/client.ts",
    "src/upload/retry.ts",
    "src/upload/retry.test.ts",
    "src-tauri/src/main.rs",
    "assets/logo.svg",
    "assets/splash.png",
  ],
  truncated: false,
  ignored: [".env", "node_modules/", "dist/"],
};

/** What Rust works out from git status: each file's mark, and each folder's most severe one. */
export const MARKS: ChangeMarks = {
  files: { "src/upload/retry.ts": "modified", "src/upload/client.ts": "modified", "src/tray/Progress.tsx": "added", "src/upload/retry.test.ts": "untracked", "src/old.ts": "deleted", "docs/upload.md": "conflicted" },
  folders: { src: "deleted", "src/upload": "modified", "src/tray": "added", docs: "conflicted" },
};

/** What the ignored folders hold, read from disk once opened. */
export const IGNORED: Record<string, FolderEntry[]> = {
  node_modules: [
    { name: "react", folder: true },
    { name: "virtua", folder: true },
    { name: ".package-lock.json", folder: false },
  ],
  dist: [{ name: "index.html", folder: false }, { name: "assets", folder: true }],
};

/** A listing too big to show whole. */
export const CAPPED: FileList = { files: FILES.files, truncated: true, ignored: [] };

/** The files whose name (first) or path matches `query`, best first, as Rust's filename search will answer. */
export function findFiles(list: FileList, query: string): string[] {
  return list.files
    .flatMap((path) => {
      const byName = fuzzyMatch(baseName(path), query);
      const match = byName ?? fuzzyMatch(path, query);
      return match ? [{ path, rank: match.rank + (byName ? 0 : 3) }] : [];
    })
    .toSorted((a, b) => a.rank - b.rank || a.path.length - b.path.length)
    .slice(0, 100)
    .map((result) => result.path);
}

/** A file's text in the fake checkout. */
export const fakeText = (path: string) => SOURCES[path] ?? (path === "src/pipeline.ts" ? LONG_FILE : `// ${path}\n`);

const literal = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Searches the fake checkout as Rust's content search will (step 2.17). */
export function searchFake(query: SearchQuery, dismissed: ReadonlySet<string> = new Set()): SearchResults {
  let pattern: RegExp;
  try {
    const source = query.regex ? query.text : literal(query.text);
    pattern = new RegExp(query.wholeWord ? `\\b(?:${source})\\b` : source, query.matchCase ? "g" : "gi");
  } catch (error) {
    return { query, files: [], done: null, error: `The search isn't a valid regular expression: ${(error as Error).message}`, filteredFiles: 0 };
  }
  const files: SearchFile[] = [];
  let filtered = 0;
  for (const path of [...Object.keys(SOURCES), "src/pipeline.ts"]) {
    if (query.include && !query.include.split(",").some((glob) => path.includes(glob.trim().replace(/\*+/g, "")))) continue;
    if (query.exclude && query.exclude.split(",").some((glob) => glob.trim() && path.includes(glob.trim().replace(/\*+/g, "")))) continue;
    const lines = fakeText(path)
      .split("\n")
      .flatMap((preview, index) => {
        const ranges = [...preview.matchAll(pattern)].filter((found) => found[0]).map((found) => ({ start: found.index, end: found.index + found[0].length }));
        return ranges.length ? [{ line: index + 1, preview, ranges }] : [];
      });
    if (!lines.length) continue;
    if (dismissed.has(path)) filtered++;
    else files.push({ path, matches: lines.reduce((sum, line) => sum + line.ranges.length, 0), hash: path, lines });
  }
  return { query, files, done: { capped: false }, error: null, filteredFiles: filtered };
}

/** Replace all on the fake checkout: it reports what it would have changed, after a moment. */
export function replaceFake(results: SearchResults, file?: string): Promise<ReplaceOutcome> {
  const files = results.files.filter((each) => !file || each.path === file);
  return new Promise((resolve) => setTimeout(() => resolve({ files: files.length, matches: files.reduce((sum, each) => sum + each.matches, 0), skipped: [], unrestored: [] }), 600));
}
