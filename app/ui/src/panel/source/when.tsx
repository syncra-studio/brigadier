import type { ReactNode } from "react";

import { Button } from "../../components/button";
import { Select, type SelectOption } from "../../components/select";
import type { Pr, Step, When, WhenRule } from "../types";
import type { Tone } from "../words";

/** The choices, in the button's own words [D1201, D1206, D1212]. Merge #12 waits for 2.27's merge: shown, off, saying so. */
function choices(base: string, pr: number | null): SelectOption<WhenRule | "ask">[] {
  return [
    { value: "ask", label: "Ask me" },
    { value: "merge", label: `Merge into ${base}` },
    { value: "pr", label: "Create PR" },
    ...(pr === null
      ? []
      : [
          { value: "mergePr" as const, label: `Merge #${pr} once checks pass`, shown: `Merge #${pr}`, disabled: true, hint: `Comes with Merge #${pr}, a later step` },
          { value: "pushPr" as const, label: `Push to #${pr}` },
        ]),
  ];
}

/** "When it's done": one quiet row at the bottom of Source, per session, never in your own folder [D1201, D1206]. */
export function WhenRow({ when, step, prs, disabled = false, onPick, held }: {
  when: When | null;
  step: Step | null;
  prs: Pr[];
  disabled?: boolean;
  onPick: (rule: WhenRule | "ask") => void;
  held?: HTMLElement;
}) {
  const base = step && "base" in step ? step.base : "main";
  const pr = prs.find((each) => each.state === "open")?.number ?? null;
  return (
    <div className="mt-auto flex items-center gap-2 border-t border-divider pt-2">
      <span className="flex-1 text-label text-muted-foreground">When it's done</span>
      <Select
        label="When it's done"
        value={when?.rule ?? "ask"}
        options={choices(base, pr)}
        onChange={onPick}
        disabled={disabled}
        className="min-w-0"
        {...(held && { open: true, container: held, collisionAvoidance: { side: "none", align: "none" } as const })}
      />
    </div>
  );
}

const SOON: Record<WhenRule, (step: Step) => string> = {
  merge: (step) => `Merging into ${"base" in step ? step.base : "the base"}`,
  pr: () => "Creating a PR",
  mergePr: (step) => `Merging #${"pr" in step ? step.pr : ""}`,
  pushPr: (step) => `Pushing to #${"pr" in step ? step.pr : ""}`,
};

const OWN = " · won't land on its own";

/**
 * The rule's say on the one button, the same in Source and the card [D1199, D1206] (proposed words): the countdown with
 * Cancel, why a gate holds it, how this turn's landing ended. Null where the step's own line says it.
 */
export function whenWords(when: When | null, step: Step, nowMs: number): { line: string; tone: Tone; cancel?: boolean; createPr?: boolean; moving?: { label: string; line: string } } | null {
  if (!when || when.working) return null;
  if (when.acting) return { line: SOON[when.rule](step), tone: "quiet", ...(when.rule === "pr" && { moving: { label: "Creating PR…", line: "Creating a PR" } }) };
  if (when.at !== undefined) {
    const left = Math.ceil((when.at - nowMs) / 1000);
    return { line: `${SOON[when.rule](step)} ${left > 0 ? `in ${left} s` : "now"}`, tone: "good", cancel: left > 0 };
  }
  const stop = when.stopped;
  if (stop) {
    switch (stop.why) {
      case "step":
        return null;
      case "checking":
        return { line: "Checking the last test run", tone: "quiet" };
      case "noRun":
        return { line: "Waits for a passing test run", tone: "quiet" };
      case "unreported":
        return { line: `The last run's result wasn't reported${OWN}`, tone: "warn" };
      case "exit":
        return { line: `The last test run exited ${stop.exit}${OWN}`, tone: "warn" };
      case "compound":
        return { line: `The last run wasn't one test command${OWN}`, tone: "warn" };
      case "changed":
        return { line: `Files changed after the last test run${OWN}`, tone: "warn" };
    }
  }
  switch (when.done) {
    case undefined:
    case null:
      return null;
    case "cancelled":
      return { line: "Cancelled for this turn", tone: "quiet" };
    case "writer":
      return { line: "Couldn't write a message", tone: "bad" };
    case "prText":
      return { line: "Couldn't write the PR's text", tone: "bad", createPr: true };
    default:
      return { line: `Couldn't land: ${when.done}`, tone: "bad" };
  }
}

/** The trail after the line: Cancel while counting down, Create PR… when the PR's text couldn't be written [D1201, D1222]. */
export function whenTrail(words: ReturnType<typeof whenWords>, onCancel: () => void, onCreatePr: () => void): ReactNode {
  if (words?.cancel) {
    return (
      <Button size="inline" variant="link-blue" onClick={onCancel}>
        Cancel
      </Button>
    );
  }
  if (words?.createPr) {
    return (
      <Button size="inline" variant="link-blue" onClick={onCreatePr}>
        Create PR…
      </Button>
    );
  }
  return null;
}
