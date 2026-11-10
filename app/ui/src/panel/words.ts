import type { PanelHint, Pr, PrWatch, SourceFile, SourceState, Step } from "./types";

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

/**
 * The action button's label, and its pre-check line: what clicking does and whether it will work [D1015]. `off`:
 * the button can't be clicked now, `why` its tip.
 */
export function stepWords(step: Step, nowMs: number): { label: string; line: string; tone: Tone; off?: boolean; why?: string } {
  switch (step.kind) {
    case "commit": {
      const lands = step.clean ? `merges cleanly into ${step.base}` : `would conflict with ${step.base}`;
      const line = step.waiting === 0 ? `Then 1 commit · ${lands}` : `${plural(step.waiting, "commit")} waiting + this one · ${lands}`;
      return { label: "Commit", line, tone: "quiet" };
    }
    case "merge":
      return {
        label: `Merge into ${step.base}`,
        line: step.busy
          ? `${step.base} is checked out in your project folder with changes to ${names(step.busy)}`
          : step.moved > 0
            ? `${step.base} moved ${plural(step.moved, "commit")} · still merges cleanly`
            : `${plural(step.ready, "commit")} ready · merges cleanly into ${step.base}`,
        tone: "quiet",
        off: step.busy !== null,
      };
    case "catchUp":
      return { label: `Catch up with ${step.base}`, line: `Would conflict in ${names(step.conflicts)}`, tone: "warn" };
    case "continue":
      // While conflicts are left the button hands them to the agent; once none are, it continues [D1015, D1093].
      return step.left > 0
        ? { label: "Resolve with agent", line: `Catching up with ${step.base} · ${plural(step.left, "conflict")} left`, tone: "warn" }
        : { label: "Continue", line: `Catching up with ${step.base} · conflicts resolved`, tone: "quiet" };
    case "landed":
      return { label: "Commit", line: `Everything is in ${step.base} · merged ${ago(step.atMs, nowMs)}`, tone: "quiet", off: true };
    case "pushPr":
      return { label: `Push to #${step.pr}`, line: `#${step.pr} open · ${plural(step.ahead, "commit")} not on ${step.host} yet`, tone: "quiet" };
    case "fixPr":
      return {
        label: "Fix with agent",
        line: `${step.why === "checks" ? "Checks failed" : "Changes asked"} on #${step.pr} · ${step.detail}`,
        tone: "bad",
      };
    case "mergePr":
      return { label: `Merge #${step.pr}`, line: `#${step.pr} approved · checks passed · merges cleanly`, tone: "good" };
    case "folderCommit":
      return {
        label: "Commit",
        line: step.behind + step.ahead === 0 ? `On ${step.branch}` : `On ${step.branch} · ${step.behind} to pull, ${step.ahead + 1} to push after this`,
        tone: "quiet",
      };
    case "sync":
      return {
        label: "Sync Changes",
        line: step.behind > 0 ? `${step.branch} on ${step.remote} has ${plural(step.behind, "new commit")}` : `${plural(step.ahead, "commit")} to push to ${step.remote}`,
        tone: "quiet",
      };
    case "publish":
      return { label: "Publish Branch", line: `${step.branch} isn't on ${step.remote} yet`, tone: "quiet" };
  }
}

/** While a step runs: the button's label and its line, at once [D30]. */
export function runningWords(step: Step): { label: string; line: string } {
  switch (step.kind) {
    case "merge":
      return { label: "Merging…", line: `Merging ${plural(step.ready, "commit")} into ${step.base}` };
    case "catchUp":
      return { label: "Catching up…", line: `Merging ${step.base} into this branch` };
    case "mergePr":
      return { label: "Merging…", line: `Merging #${step.pr}` };
    case "pushPr":
      return { label: "Pushing…", line: `Pushing to #${step.pr}` };
    case "sync":
      return { label: "Syncing…", line: `Pulling, then pushing ${step.branch}` };
    case "publish":
      return { label: "Publishing…", line: `Publishing ${step.branch} to ${step.remote}` };
    default:
      return { label: "Committing…", line: "Committing" };
  }
}

/** What a step that failed says on the line: "Couldn't merge: …". */
export function errorWords(kind: Step["kind"], reason: string): string {
  const verb = { merge: "merge", mergePr: "merge", catchUp: "catch up", continue: "continue", pushPr: "push", sync: "sync", publish: "publish" }[kind as string] ?? "commit";
  return `Couldn't ${verb}: ${reason}`;
}

/** What discarding `file` throws away, in plain words (the old SourcePanel's discardWords). */
export function discardWords(scope: "staged" | "unstaged", file: SourceFile, alsoUnstaged: boolean): string {
  if (scope === "unstaged") {
    return file.status === "untracked"
      ? `${file.path} is deleted. Git doesn't track it, so it can't be brought back.`
      : `The changes to ${file.path} that aren't staged are lost. Its staged changes stay.`;
  }
  const back =
    file.status === "added"
      ? `${file.path} is new, so it's deleted.`
      : file.status === "renamed"
        ? `${file.path} goes back to ${file.oldPath ?? "its old name"} as it was last committed.`
        : `${file.path} goes back to how it was last committed.`;
  return alsoUnstaged ? `${back} Its changes that aren't staged are lost too.` : back;
}

/** Source's one status at the top [D1098, D1107]: what the work needs now, from Rust's state and step. */
export type Status = { title: string; tone: "quiet" | "changes" | "good" | "warn" | "bad"; icon: "clean" | "changes" | "warn" | "pr" | "sync" };

export function statusWords(state: SourceState, step: Step, files: number, prs: Pr[]): Status {
  const resolving = state.merging ?? state.rebasing;
  if (resolving) {
    const onto = state.merging?.incoming ?? state.rebasing?.onto ?? "";
    return state.changes.some((file) => file.status === "conflicted")
      ? { title: `Conflicts with ${onto}`, tone: "warn", icon: "warn" }
      : { title: "Conflicts resolved", tone: "changes", icon: "changes" };
  }
  if (files > 0) return { title: `${plural(files, "file")} changed`, tone: "changes", icon: "changes" };
  switch (step.kind) {
    case "merge":
    case "mergePr":
      return { title: "Ready to merge", tone: "good", icon: "clean" };
    case "catchUp":
      return { title: `Would conflict with ${step.base}`, tone: "warn", icon: "warn" };
    case "fixPr": {
      const failed = prs.find((pr) => pr.number === step.pr)?.failed ?? 0;
      if (step.why === "changes") return { title: `Changes asked on #${step.pr}`, tone: "warn", icon: "pr" };
      return { title: failed > 0 ? `${plural(failed, "check")} failed` : "Checks failed", tone: "bad", icon: "pr" };
    }
    case "pushPr":
      return { title: `${plural(step.ahead, "commit")} to push`, tone: "changes", icon: "sync" };
    case "sync":
      return { title: step.behind > 0 ? `${step.behind} to pull, ${step.ahead} to push` : `${step.ahead} to push`, tone: "changes", icon: "sync" };
    case "publish":
      return { title: "Not published yet", tone: "quiet", icon: "sync" };
    case "landed":
      return { title: `Merged into ${step.base}`, tone: "quiet", icon: "clean" };
    default:
      return { title: "No changes yet", tone: "quiet", icon: "clean" };
  }
}

/** A PR's state word and its tone, as its row says it. */
export function prWords(pr: Pr): { word: string; tone: Tone } {
  if (pr.state === "merged") return { word: "Merged", tone: "quiet" };
  if (pr.state === "closed") return { word: "Closed", tone: "quiet" };
  switch (pr.health) {
    case "failed":
      return { word: `${plural(pr.failed, "check")} failed`, tone: "bad" };
    case "conflicts":
      return { word: "Conflicts", tone: "warn" };
    case "changes":
      return { word: "Changes asked", tone: "warn" };
    case "running":
      return { word: "Checks running", tone: "quiet" };
    case "ready":
      return { word: "Ready", tone: "good" };
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
