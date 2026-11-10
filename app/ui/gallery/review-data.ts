// The Review tab's fake data, standing in for Rust: a few changed files as runs of unchanged lines and changes, read
// in each scope, with the changes staged or reverted so far.
import type { FileContents, Review, ReviewFile, ReviewHunk, ReviewScope } from "../src/review/types";

/** Unchanged lines, or a change (old lines, then new ones). */
type Seg = string[] | { del: string[]; add: string[] };
type Line = { kind: "ctx" | "del" | "add"; text: string; old: number; new: number; change: number };

/** What the user has done so far, each change named `path:index`. */
export type Done = { staged: ReadonlySet<string>; reverted: ReadonlySet<string> };
export const NOTHING_DONE: Done = { staged: new Set(), reverted: new Set() };

/** Both sides of the changes `shown` picks (the rest read as unchanged, new where `applied`), cut into git's hunks. */
function build(path: string, segs: Seg[], shown: (change: number) => boolean, applied: (change: number) => boolean, staged: (change: number) => boolean) {
  const rows: Line[] = [];
  let old = 0;
  let neu = 0;
  let change = -1;
  for (const seg of segs) {
    if (Array.isArray(seg)) {
      for (const text of seg) rows.push({ kind: "ctx", text, old: ++old, new: ++neu, change: -1 });
      continue;
    }
    change++;
    if (!shown(change)) {
      for (const text of applied(change) ? seg.add : seg.del) rows.push({ kind: "ctx", text, old: ++old, new: ++neu, change: -1 });
      continue;
    }
    for (const text of seg.del) rows.push({ kind: "del", text, old: ++old, new: neu, change });
    for (const text of seg.add) rows.push({ kind: "add", text, old, new: ++neu, change });
  }
  const near = rows.map((_, index) => rows.slice(Math.max(0, index - 3), index + 4).some((row) => row.kind !== "ctx"));
  const runs: Line[][] = [];
  rows.forEach((row, index) => {
    if (!near[index]) return;
    if (index > 0 && near[index - 1]) runs.at(-1)!.push(row);
    else runs.push([row]);
  });
  const changes = new Map<string, string[]>();
  const hunks = runs.map((run): ReviewHunk => {
    const first = run[0]!;
    const added = run.filter((row) => row.kind === "add");
    const deleted = run.filter((row) => row.kind === "del");
    const own = [...new Set(run.filter((row) => row.change >= 0).map((row) => row.change))];
    const id = `${path}:${own.join(",")}`;
    changes.set(id, own.map((at) => `${path}:${at}`));
    const oldStart = first.kind === "add" ? first.old + 1 : first.old;
    const newStart = first.kind === "del" ? first.new + 1 : first.new;
    const counted = added.length ? added.map((row) => row.new) : deleted.map((row) => row.old);
    return {
      id,
      header: `@@ -${oldStart},${run.length - added.length} +${newStart},${run.length - deleted.length} @@`,
      insertions: added.length,
      deletions: deleted.length,
      staged: own.every(staged),
      newStart,
      leading: run.findIndex((row) => row.kind !== "ctx"),
      side: added.length ? "additions" : "deletions",
      start: Math.min(...counted),
      end: Math.max(...counted),
    };
  });
  const side = (kind: "add" | "del") => rows.filter((row) => row.kind !== kind).map((row) => `${row.text}\n`).join("");
  const contents: FileContents = { before: side("add"), after: side("del"), hunks };
  return { contents, changes, insertions: rows.filter((row) => row.kind === "add").length, deletions: rows.filter((row) => row.kind === "del").length };
}

const SOURCES: { file: Omit<ReviewFile, "staged">; segs: Seg[] }[] = [
  {
    file: { path: "src/upload/retry.ts", from: null, status: "modified", insertions: 0, deletions: 0, binary: false, large: false },
    segs: [
      ['import { log } from "../log";', 'import type { Upload } from "./client";', "", "const BASE_DELAY_MS = 500;", "const TRIES = 3;"],
      { del: [], add: ["const MAX_DELAY_MS = 8_000;"] },
      ["", "export type RetryOptions = {", "  tries?: number;", "  onRetry?: (attempt: number, error: unknown) => void;", "};", "", "function sleep(ms: number): Promise<void> {", "  return new Promise((resolve) => setTimeout(resolve, ms));", "}", "", "/** Waits longer after each failed try. */", "function backoff(attempt: number): number {"],
      { del: ["  return BASE_DELAY_MS * attempt;"], add: ["  return Math.min(BASE_DELAY_MS * 2 ** attempt, MAX_DELAY_MS);"] },
      ["}", "", "export async function retry<T>(run: () => Promise<T>, options: RetryOptions = {}): Promise<T> {", "  const tries = options.tries ?? TRIES;", "  let last: unknown;", "  for (let attempt = 1; attempt <= tries; attempt++) {", "    try {", "      return await run();", "    } catch (error) {"],
      { del: [], add: ["      if (!retryable(error)) throw error;"] },
      ["      last = error;"],
      { del: [], add: ['      log.warn("upload failed, retrying", { attempt, error });'] },
      ["      options.onRetry?.(attempt, error);", "      await sleep(backoff(attempt));", "    }", "  }", "  throw last;", "}", "", "export function retryUpload(upload: Upload): Promise<void> {"],
      { del: ["  return retry(() => upload.send());"], add: ["  return retry(() => upload.send(), { onRetry: (n) => log.info(`try ${n + 1}`) });"] },
      ["}"],
      { del: [], add: ["", "/** A 4xx won't get better by trying again. */", "function retryable(error: unknown): boolean {", "  return !(error instanceof Response && error.status < 500);", "}"] },
    ],
  },
  {
    file: { path: "src/upload/client.ts", from: null, status: "modified", insertions: 0, deletions: 0, binary: false, large: false },
    segs: [
      { del: ['import { request } from "../http";'], add: ['import { request, type Options } from "../http";'] },
      ["", "export type Upload = { id: string; send: () => Promise<void> };", "", "export function upload(file: File): Upload {", "  const id = crypto.randomUUID();"],
      { del: ["  return { id, send: () => request(`/upload/${id}`, { body: file }) };"], add: ["  const options: Options = { body: file, timeoutMs: 30_000 };", "  return { id, send: () => request(`/upload/${id}`, options) };"] },
      ["}"],
    ],
  },
  {
    file: { path: "src/upload/queue.ts", from: "src/queue.ts", status: "renamed", insertions: 0, deletions: 0, binary: false, large: false },
    segs: [["export class Queue<T> {", "  #items: T[] = [];", "  push(item: T): void {", "    this.#items.push(item);", "  }"], { del: [], add: ["  get size(): number {", "    return this.#items.length;", "  }"] }, ["}"]],
  },
  {
    file: { path: "src/upload/limits.ts", from: null, status: "added", insertions: 0, deletions: 0, binary: false, large: false },
    segs: [{ del: [], add: ["/** The largest file an upload takes, in bytes. */", "export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;"] }],
  },
  {
    file: { path: "src/generated/schema.ts", from: null, status: "modified", insertions: 0, deletions: 0, binary: false, large: true },
    segs: [
      ["// Generated from schema.json. Don't edit by hand."],
      {
        del: Array.from({ length: 420 }, (_, at) => `export const field${at} = { name: "field${at}", type: "string" } as const;`),
        add: Array.from({ length: 640 }, (_, at) => `export const field${at} = { name: "field${at}", type: "${at % 3 ? "string" : "number"}", optional: ${at % 2 === 0} } as const;`),
      },
    ],
  },
];

const BINARY: ReviewFile = { path: "assets/upload-icon.png", from: null, status: "added", insertions: 0, deletions: 0, binary: true, staged: false, large: false };

/** What Rust would send for `scope`: the list, each file's contents, and which changes each hunk holds. */
export function read(scope: ReviewScope, done: Done) {
  const files: ReviewFile[] = [];
  const contents = new Map<string, FileContents>();
  const changes = new Map<string, string[]>();
  for (const { file, segs } of SOURCES) {
    const key = (change: number) => `${file.path}:${change}`;
    const live = (change: number) => !done.reverted.has(key(change));
    const staged = (change: number) => done.staged.has(key(change));
    const shown = scope === "staged" ? (c: number) => live(c) && staged(c) : scope === "unstaged" ? (c: number) => live(c) && !staged(c) : live;
    // Unstaged reads over the index: what's staged there reads as unchanged, already new.
    const made = build(file.path, segs, shown, (c) => scope === "unstaged" && live(c) && staged(c), staged);
    if (made.contents.hunks.length === 0) continue;
    files.push({ ...file, insertions: made.insertions, deletions: made.deletions, staged: made.contents.hunks.every((hunk) => hunk.staged) });
    contents.set(file.path, made.contents);
    for (const [id, own] of made.changes) changes.set(id, own);
  }
  // The binary file is one change: it shows in the scope its staging puts it in.
  const binaryStaged = done.staged.has(BINARY.path);
  if (!done.reverted.has(BINARY.path) && (scope === "staged" ? binaryStaged : scope !== "unstaged" || !binaryStaged)) files.push({ ...BINARY, staged: binaryStaged });
  const review: Review = {
    scope,
    base: "main",
    files,
    insertions: files.reduce((sum, entry) => sum + entry.insertions, 0),
    deletions: files.reduce((sum, entry) => sum + entry.deletions, 0),
  };
  return { review, contents, changes };
}

/** retry.ts's first change already staged, as the round 4 mock showed it. */
export const FIRST_STAGED: Done = { staged: new Set(["src/upload/retry.ts:0"]), reverted: new Set() };
