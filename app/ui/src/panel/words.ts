import type { Blocked, Flag, LastRun, PanelHint, Pr, PrWatch, SourceFile, SourceState, Step } from "./types";

/* The right panel's words, written from what Rust sends [D65]. */

export const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

export function baseName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

export function dirName(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash < 0 ? "" : path.slice(0, slash);
}

/** "5 minutes ago", "2 hours ago", "3 days ago" (the old BranchPicker's). */
export function ago(atMs: number, nowMs: number): string {
  const minutes = Math.floor(Math.max(0, nowMs - atMs) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${plural(minutes, "minute")} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${plural(hours, "hour")} ago`;
  const days = Math.floor(hours / 24);
  return days < 30 ? `${plural(days, "day")} ago` : days < 365 ? `${plural(Math.floor(days / 30), "month")} ago` : `${plural(Math.floor(days / 365), "year")} ago`;
}

/** The toggle's tip [D1025]. */
export function hintWords(hint: PanelHint | null): string {
  if (!hint) return "Right sidebar";
  switch (hint.tone) {
    case "changes":
      return `Right sidebar · ${plural(hint.count, "change")} in Source`;
    case "ready":
      return `Right sidebar · Ready to merge into ${hint.base}`;
    case "conflict":
      return `Right sidebar · Would conflict with ${hint.base}`;
    case "failed":
      return `Right sidebar · ${hint.why === "checks" ? "Checks failed" : "Changes asked"} on #${hint.pr}`;
  }
}

export type Tone = "quiet" | "good" | "warn" | "bad";

const names = (paths: string[]) => paths.map(baseName).join(", ");

/** Why the base can't take a landing now, on Merge's line [D1047, D1161]. */
function blockedWords(base: string, blocked: Blocked): string {
  switch (blocked.why) {
    case "busy":
      return `${base} is checked out in ${baseName(blocked.folder)} with changes to ${names(blocked.files)}`;
    case "midway":
      return `${base} is in the middle of a merge or rebase in ${baseName(blocked.folder)}`;
    case "remote":
      return `${base} is a remote branch · open a PR instead`;
    case "commit":
      return `${base} isn't a branch · open a PR instead`;
    case "shared":
      return `Landing stays with ${blocked.with}`;
  }
}

/** Merge #N's line: what it waits for, or that it's ready. Nothing the host didn't say is taken as passed [D74, D1019]. */
function mergePrWords(step: Extract<Step, { kind: "mergePr" }>): { line: string; off: boolean } {
  const { pr, checks } = step;
  // Cancelled isn't failed, and checks that couldn't be read aren't passed [D74, D1188].
  if (checks.blocked) return { line: (checks.cancelled ?? 0) > 0 ? `Checks cancelled on #${pr}` : `Check state unknown on #${pr}`, off: true };
  if (checks.running !== null && checks.running > 0) return { line: `#${pr} · ${plural(checks.running, "check")} still running`, off: true };
  if (step.mergeable === null) return { line: `#${pr} · the host is still checking whether it merges`, off: true };
  if (checks.approved === false) return { line: `#${pr} · waiting for a review`, off: true };
  const passed = checks.passed === null ? null : checks.passed > 0 ? "checks passed" : "no checks";
  return { line: [`#${pr}`, checks.approved && "approved", passed, "merges cleanly"].filter(Boolean).join(" · "), off: false };
}

/**
 * The action button's label, and its pre-check line: what clicking does and whether it will work [D1015]. `off`:
 * the button can't be clicked now, `why` its tip.
 */
export function stepWords(step: Step, nowMs: number): { label: string; line: string; tone: Tone; off?: boolean; why?: string } {
  const words = landWords(step, nowMs);
  const first = "commit" in step && typeof step.commit === "number" ? step.commit : 0;
  // The button commits first, then lands, and its line says so [D1203, D1207].
  return first > 0 && step.kind !== "commit" && !words.off ? { ...words, line: `${plural(first, "file")} will be committed · ${thenWords(step, words.line)}` } : words;
}

/** What follows "6 files will be committed ·": the move's own line, shortened. */
function thenWords(step: Step, line: string): string {
  switch (step.kind) {
    case "merge":
      return step.moved > 0 ? `${step.base} moved ${plural(step.moved, "commit")} · still merges cleanly` : "merges cleanly";
    case "pushPr":
      return `then pushed to #${step.pr}`;
    case "sync":
      return step.behind > 0 ? `then ${step.behind} to pull, ${step.ahead + 1} to push` : "then pushed";
    case "publish":
      return `then published to ${step.remote}`;
    default:
      return line;
  }
}

function landWords(step: Step, nowMs: number): { label: string; line: string; tone: Tone; off?: boolean; why?: string } {
  switch (step.kind) {
    case "commit": {
      const lands = step.clean ? `merges cleanly into ${step.base}` : `would conflict with ${step.base}`;
      const line = step.waiting === 0 ? `Then 1 commit · ${lands}` : `${plural(step.waiting, "commit")} waiting + this one · ${lands}`;
      return { label: "Commit", line, tone: "quiet" };
    }
    case "merge":
      return {
        label: `Merge into ${step.base}`,
        line: step.blocked
          ? blockedWords(step.base, step.blocked)
          : step.moved > 0
            ? `${step.base} moved ${plural(step.moved, "commit")} · still merges cleanly`
            : `${plural(step.ready, "commit")} ready · merges cleanly into ${step.base}`,
        tone: "quiet",
        off: step.blocked !== null,
      };
    case "catchUp":
      return { label: `Catch up with ${step.base}`, line: `Would conflict in ${names(step.conflicts)}`, tone: "warn" };
    case "continue":
      // While conflicts are left the button hands them to the agent; once none are, it continues [D1015, D1093].
      return step.left > 0
        ? { label: "Resolve with agent", line: `Catching up with ${step.base} · ${plural(step.left, "conflict")} left`, tone: "warn" }
        : { label: "Continue", line: `Catching up with ${step.base} · conflicts resolved`, tone: "quiet" };
    // After landing the button stays, off, saying when [D1206].
    case "landed":
      return { label: `Merge into ${step.base}`, line: step.atMs === null ? `Already in ${step.base}` : `Merged into ${step.base} ${ago(step.atMs, nowMs)}`, tone: "quiet", off: true };
    case "pushPr":
      return { label: `Push to #${step.pr}`, line: `${plural(step.ahead, "commit")} not on ${step.host ?? "the remote"} yet`, tone: "quiet" };
    // The hero names the failure; the line says what the button does (proposed words) [D1201].
    case "fixPr":
      return {
        label: "Fix with agent",
        line: `Adds the ${step.why === "checks" ? "failing checks" : step.why === "conflicts" ? "conflicts" : "comments"} to your next message`,
        tone: step.why === "checks" ? "bad" : "warn",
      };
    case "mergePr": {
      const { line, off } = mergePrWords(step);
      return { label: `Merge #${step.pr}`, line, tone: off ? "quiet" : "good", off };
    }
    case "folderCommit":
      return {
        label: "Commit",
        line: step.behind + step.ahead === 0 ? `On ${step.branch}` : `On ${step.branch} · ${step.behind} to pull, ${step.ahead + 1} to push after this`,
        tone: "quiet",
      };
    case "sync":
      return {
        label: "Sync Changes",
        line: step.behind > 0 ? `${step.remote} has ${plural(step.behind, "commit")} this branch doesn't` : `${plural(step.ahead, "commit")} to push to ${step.remote}`,
        tone: "quiet",
      };
    case "publish":
      return { label: "Publish Branch", line: `${step.branch} isn't on ${step.remote} yet`, tone: "quiet" };
  }
}

/** While a step runs: the button's label and its line, at once [D30]; first the commit, when it makes one [D1203]. */
export function runningWords(step: Step): { label: string; line: string } {
  const words = movingWords(step);
  const first = "commit" in step && typeof step.commit === "number" ? step.commit : 0;
  if (first === 0 || step.kind === "commit") return words;
  const then = words.line.charAt(0).toLowerCase() + words.line.slice(1);
  return { ...words, line: `Committing ${plural(first, "file")}, then ${then}` };
}

function movingWords(step: Step): { label: string; line: string } {
  switch (step.kind) {
    case "merge":
      return { label: "Merging…", line: step.ready > 0 ? `Merging ${plural(step.ready, "commit")} into ${step.base}` : `Merging into ${step.base}` };
    case "catchUp":
      return { label: "Catching up…", line: `Merging ${step.base} into this branch` };
    case "mergePr":
      return { label: "Merging…", line: `Merging #${step.pr}` };
    case "landed":
      return { label: "Merging…", line: `Merging into ${step.base}` };
    case "pushPr":
      return { label: "Pushing…", line: `Pushing to #${step.pr}` };
    case "sync":
      return { label: "Syncing…", line: `Pulling, then pushing ${step.branch}` };
    case "publish":
      return { label: "Publishing…", line: `Publishing ${step.branch} to ${step.remote}` };
    // Resolve with agent and Fix with agent hand the work to the agent [D1019, D1044].
    case "continue":
      return step.left > 0
        ? { label: "Handing it to the agent…", line: `Handing ${plural(step.left, "conflict")} to the agent` }
        : { label: "Continuing…", line: `Finishing the catch-up with ${step.base}` };
    case "fixPr":
      return { label: "Handing it to the agent…", line: `Handing #${step.pr} to the agent` };
    default:
      return { label: "Committing…", line: "Committing" };
  }
}

/** A step whose click comes with a later step of the plan: the button stays off and says so (proposed words) [D1143]. */
export function laterWords(kind: Step["kind"]): string | null {
  const later: Partial<Record<Step["kind"], string>> = { catchUp: "2.23", continue: "2.23", fixPr: "2.27", mergePr: "2.27" };
  return later[kind] ? `Not wired yet · comes with step ${later[kind]}` : null;
}

/** What a step that failed says on the line: "Couldn't merge: …". */
export function errorWords(kind: Step["kind"], reason: string): string {
  const verb = { merge: "merge", mergePr: "merge", catchUp: "catch up", continue: "continue", pushPr: "push", sync: "sync", publish: "publish" }[kind as string] ?? "commit";
  return `Couldn't ${verb}: ${reason}`;
}

/** What discarding `file` throws away, in plain words (the old SourcePanel's discardWords). `other`: it has changes on the other side too. */
export function discardWords(scope: "staged" | "unstaged", file: SourceFile, other: boolean): string {
  if (scope === "unstaged") {
    return file.status === "untracked"
      ? `${file.path} is deleted. Git doesn't track it, so it can't be brought back.`
      : `The changes to ${file.path} that aren't staged are lost.${other ? " Its staged changes stay." : ""}`;
  }
  const back =
    file.status === "added"
      ? `${file.path} is new, so it's deleted.`
      : file.status === "renamed"
        ? `${file.path} goes back to ${file.oldPath ?? "its old name"} as it was last committed.`
        : `${file.path} goes back to how it was last committed.`;
  return other ? `${back} Its changes that aren't staged are lost too.` : back;
}

/**
 * Source's hero [D1200, D1206]: the state's glyph and colour and one sentence naming the state, never the line's or a
 * row's words. The card leaves it out: its rows say it [D1199]. `working`: the agent's turn runs; `rejected`: a push
 * was just turned away.
 */
export type Hero = { glyph: "spin" | "check" | "warn" | "bad" | "pr" | "edit" | "merged"; tone: "quiet" | "changes" | "good" | "warn" | "bad" | "pr" | "merged"; sentence: string };

export function heroWords(state: SourceState, step: Step | null, { files, working, rejected, open = null }: { files: number; working: boolean; rejected: boolean; open?: number | null }): Hero {
  if (working) return { glyph: "spin", tone: "quiet", sentence: "Agent working" };
  const resolving = state.merging ?? state.rebasing;
  if (resolving) {
    const onto = state.merging?.incoming ?? state.rebasing?.onto ?? "";
    return state.changes.some((file) => file.status === "conflicted")
      ? { glyph: "warn", tone: "warn", sentence: `Conflicts with ${onto}` }
      : { glyph: "edit", tone: "changes", sentence: "Conflicts resolved" };
  }
  // The PR it pushes to, from the step or the branch's open PR.
  const pr = step && "pr" in step ? step.pr : open;
  if (rejected) return { glyph: "bad", tone: "bad", sentence: pr ? `Couldn't push to #${pr}` : "Couldn't push" };
  if (state.checkout === "folder" && files > 0) return { glyph: "edit", tone: "changes", sentence: "Changes in your folder" };
  switch (step?.kind) {
    case "merge":
      // D1228's words.
      return step.blocked ? { glyph: "warn", tone: "warn", sentence: `Can't merge into ${step.base} yet` } : { glyph: "check", tone: "good", sentence: "Ready to merge" };
    case "mergePr":
      // Waiting on checks or a review [D1228]; yellow while checks run, as the PR row.
      return mergePrWords(step).off ? { glyph: "pr", tone: (step.checks.running ?? 0) > 0 ? "pr" : "quiet", sentence: `Waiting on #${step.pr}` } : { glyph: "check", tone: "good", sentence: "Ready to merge" };
    case "catchUp":
      return { glyph: "warn", tone: "warn", sentence: `Would conflict with ${step.base}` };
    case "fixPr":
      if (step.why === "changes") return { glyph: "warn", tone: "warn", sentence: `Changes asked on #${step.pr}` };
      if (step.why === "conflicts") return { glyph: "warn", tone: "warn", sentence: `#${step.pr} conflicts with ${step.base}` };
      return { glyph: "bad", tone: "bad", sentence: step.failed ? `${plural(step.failed, "check")} failed on #${step.pr}` : `Checks failed on #${step.pr}` };
    case "pushPr":
      return { glyph: "pr", tone: "changes", sentence: `Ready to push to #${step.pr}` };
    case "sync":
      return { glyph: "edit", tone: "changes", sentence: step.behind > 0 ? `Behind ${step.remote}` : `Ahead of ${step.remote}` };
    case "publish":
      return { glyph: "edit", tone: "quiet", sentence: "Not published yet" };
    case "landed":
      return { glyph: "merged", tone: "merged", sentence: `Everything is in ${step.base}` };
    default:
      return files > 0 ? { glyph: "edit", tone: "changes", sentence: `${plural(files, "file")} changed` } : { glyph: "check", tone: "quiet", sentence: "No changes yet" };
  }
}

/** A PR's state word and its tone, as its row says it. */
export function prWords(pr: Pr): { word: string; tone: Tone } {
  if (pr.state === "merged") return { word: "Merged", tone: "quiet" };
  if (pr.state === "closed") return { word: "Closed", tone: "quiet" };
  switch (pr.health) {
    case "failed":
      return { word: pr.failed ? `${plural(pr.failed, "check")} failed` : "Checks failed", tone: "bad" };
    case "conflicts":
      return { word: "Conflicts", tone: "warn" };
    case "changes":
      return { word: "Changes asked", tone: "warn" };
    case "running":
      return { word: "Checks running", tone: "quiet" };
    case "ready":
      return { word: "Ready", tone: "good" };
    case "cancelled":
      return { word: "Checks cancelled", tone: "warn" };
    case "unknown":
      return { word: "Check state unknown", tone: "quiet" };
  }
}

/** The PR icon's dot: the worst open PR's tone [D1025, D1114]; none while every open one's checks run. */
export function prDot(prs: Pr[]): Tone | null {
  const tones = prs.filter((pr) => pr.state === "open").map((pr) => prWords(pr).tone);
  return (["bad", "warn", "good"] as const).find((tone) => tones.includes(tone)) ?? null;
}

/** One line of the PR watch: "#12 · checks failed". */
export function watchWords(event: PrWatch["events"][number]): string {
  const what = { opened: "opened", checksFailed: "· checks failed", checksPassed: "· checks passed", changesAsked: "· changes asked", commented: "· new comment", merged: "merged" }[event.kind];
  return `#${event.pr} ${what}`;
}

/** "14:32", the watch's clock time. */
export const clock = (atMs: number) => new Date(atMs).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });

/** A flagged file's fact, in amber under its name: what Rust saw, never a verdict [D1188] (proposed words). */
export function flagWords(flag: Flag): string {
  switch (flag.kind) {
    case "test":
      return flag.deleted ? "test file deleted" : `test file lost ${plural(flag.removed, "line")}`;
    case "lock":
      return "lock file changed";
    case "manifest":
      return "dependencies changed";
    case "build":
      return "CI or build config changed";
    case "migration":
      return "migration";
  }
}

/** The last run's result as its CLI said it: "exited 0", or "result unreported" [D74, D1188]. */
export function runWords(run: LastRun): { result: string; tone: Tone; since: string } {
  return {
    result: run.exit === null ? "result unreported" : `exited ${run.exit}`,
    tone: run.exit === null ? "quiet" : run.exit === 0 ? "good" : "bad",
    since: run.changed ? "changed since" : "changed since: unknown",
  };
}
