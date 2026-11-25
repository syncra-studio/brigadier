import { Fragment, type ReactNode } from "react";

import { sentAt } from "../components/thread/message";
import { cx } from "../components/cx";
import { baseName, plural, type Tone } from "../panel/words";
import { Counts } from "./hunks";
import { captured, type FileFlag, type LastRun, type NoTurn, type Review, type ReviewFile } from "./types";

/**
 * Review's brief (D1188): what changed, which files want a look first, and the session's last test or build run, as
 * facts, never verdicts: "exited 0", never "tests pass". Rust sends the structure, these write the words (D65), and
 * the card uses the same ones, so the two never disagree (D1199). A `name` in backticks is drawn as
 * code by `Ticks`.
 */

export type BriefLine = { text: string; tone: Tone };

/** "a test file lost 12 lines", "touches `package.json`, `Cargo.lock`". */
export function flagWords(files: readonly ReviewFile[]): BriefLine[] {
  const flagged = files.filter((file) => file.flag);
  const lost = flagged.filter((file) => file.flag?.kind === "test" && !file.flag.deleted);
  const gone = flagged.filter((file) => file.flag?.deleted && file.flag.kind === "test");
  const touched = flagged.filter((file) => file.flag?.kind !== "test");
  const lines: BriefLine[] = [];
  if (gone.length > 0) lines.push({ text: gone.length === 1 ? "a test file was deleted" : `${gone.length} test files were deleted`, tone: "warn" });
  if (lost.length > 0) {
    const removed = plural(lost.reduce((sum, file) => sum + (file.flag?.removed ?? 0), 0), "line");
    lines.push({ text: lost.length === 1 ? `a test file lost ${removed}` : `${lost.length} test files lost ${removed}`, tone: "warn" });
  }
  if (touched.length > 0) {
    const names = touched.slice(0, 3).map((file) => `\`${baseName(file.path)}\``);
    const more = touched.length > 3 ? ` and ${touched.length - 3} more` : "";
    lines.push({ text: `touches ${names.join(", ")}${more}`, tone: "warn" });
  }
  return lines;
}

/** A flagged file's own fact, beside its name: "lost 12 lines", "lock file". */
export function fileFact(flag: FileFlag): string {
  if (flag.kind === "test") return flag.deleted ? "test deleted" : `test lost ${plural(flag.removed, "line")}`;
  return { lock: "lock file", manifest: "dependency manifest", build: "CI or build config", migration: "migration" }[flag.kind];
}

/** A run's result and what changed after it, as Review says it (D1199). */
function runFacts(run: LastRun): { result: string; since: string } {
  return { result: run.exit === null ? "result unreported" : `exited ${run.exit}`, since: run.changed ? "changed since" : "changed since: unknown" };
}

/** "last run `cargo test`, exited 0, ran 9:02 AM · changed since: unknown" (D1188, D1192). */
export function runWords(run: LastRun | null, now = Date.now()): BriefLine {
  if (!run) return { text: "No test or build run this session", tone: "quiet" };
  const { result, since } = runFacts(run);
  return { text: `last run \`${run.command}\`, ${result}, ran ${sentAt(run.at, now)} · ${since}`, tone: run.exit || run.changed ? "warn" : "quiet" };
}

/** Last turn or a night with nothing to compare: Rust's reason in words (D30). */
export function noTurnWords(why: NoTurn): string {
  return {
    noNight: "This night's start or end wasn't captured, so there's nothing to compare.",
    noProject: "This chat has no project folder, so there's no turn's files to show.",
    notGit: "This folder isn't a git checkout, so Review can't show the last turn.",
    noTurn: "No turn yet. What the next one changes shows here.",
    midTurn: "The last message was sent while a turn ran, so it has no capture of its own.",
    noSnapshot: "The last turn's start wasn't captured, so there's nothing to compare.",
  }[why];
}

/** What Last turn's or a night's diff doesn't cover, and how it was taken (D1192). */
export function turnWords(review: Review): BriefLine[] {
  const lines: BriefLine[] = [];
  const turn = review.turn;
  if (turn?.live) lines.push({ text: "The turn is still running: its start against now", tone: "quiet" });
  if (turn?.missed) lines.push({ text: "The turn's end wasn't captured: its start against now", tone: "warn" });
  if (review.shared) lines.push({ text: "Another session works in this folder: its changes may be in this diff", tone: "warn" });
  if (turn) {
    const out = turn.excluded.slice(0, 3).map((path) => `\`${baseName(path)}\``);
    const more = turn.excluded.length > 3 ? ` and ${turn.excluded.length - 3} more` : "";
    lines.push({
      text: out.length > 0 ? `Not covered: ${out.join(", ")}${more} (large files or nested repos), and files the project ignores` : "Not covered: files the project ignores",
      tone: "quiet",
    });
  }
  return lines;
}

/** Words with `name`s drawn as code. */
export function Ticks({ text }: { text: string }) {
  return text.split("`").map((part, index) => (index % 2 === 1 ? <code key={index} className="font-mono">{part}</code> : <Fragment key={index}>{part}</Fragment>));
}

const TONE: Record<Tone, string> = { quiet: "", good: "text-success", warn: "text-warning", bad: "text-destructive" };

/**
 * The strip at the top of the Review tab (D1188), as w67's summary drew it: one fact a line. Its loading, error and
 * disconnected states are the tab's (D30).
 */
export function BriefStrip({ review }: { review: Review }) {
  const line = (key: string, tone: Tone, children: ReactNode) => (
    <span key={key} className={cx("flex min-w-0 items-center gap-1.5", TONE[tone])}>
      {children}
    </span>
  );
  const facts = [...flagWords(review.files), ...(review.run === undefined ? [] : [runWords(review.run)]), ...(captured(review.scope) ? turnWords(review) : [])];
  return (
    <div data-slot="review-brief" className="flex shrink-0 flex-col gap-1 border-b border-divider bg-fill-faint px-3 py-2.5 text-xs text-muted-foreground">
      {line(
        "size",
        "quiet",
        <>
          {plural(review.files.length, "file")} · <Counts insertions={review.insertions} deletions={review.deletions} />
        </>,
      )}
      {facts.map((fact, index) => line(String(index), fact.tone, <span className="truncate"><Ticks text={fact.text} /></span>))}
    </div>
  );
}
