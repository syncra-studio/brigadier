import type { ReactNode } from "react";

import { Button } from "../../components/button";
import { cx } from "../../components/cx";
import { DropdownMenu, DropdownMenuTrigger } from "../../components/menu";
import { ArrowDown, ArrowUp, Branch, Check, ChevronDown, Publish, Sparkles, Spinner, SyncGlyph, Warning } from "../../icons";
import type { MergeStyle, Step, StepError } from "../types";
import { errorWords, runningWords, stepWords, type Tone } from "../words";
import { ActionMenu, type ActionPick, hasActionMenu } from "./action-menus";
import type { PrWay } from "./create-pr";

/** Each half of the split button: the kit's small button, less its press scale [D1155]. */
const SPLIT = "inline-flex h-control-sm gap-1 text-sm font-medium transition-all";
const TONE: Record<Tone, string> = { quiet: "text-muted-foreground", good: "text-success", warn: "text-warning", bad: "text-destructive" };

function icon(step: Step): ReactNode {
  switch (step.kind) {
    case "merge":
    case "mergePr":
      return <Branch />;
    case "catchUp":
    case "sync":
      return <SyncGlyph />;
    case "pushPr":
      return <ArrowUp />;
    case "fixPr":
      return <Sparkles />;
    case "continue":
      return step.left > 0 ? <Sparkles /> : <Check />;
    case "publish":
      return <Publish />;
    default:
      return <Check />;
  }
}

/**
 * The one action button [D1008, D1015]: the old main button's split look, its label the next step Rust works out,
 * and the grey pre-check line under it saying what clicking does and whether it will work. The arrow holds every
 * other way. Fix with agent and Resolve with agent only leave a chip above the composer, sent when the user sends
 * [D1019, D1044].
 * `writing`: Commit pressed with a blank box, the message being written [D1029]. `held`: the gallery's open menu.
 */
export function ActionButton({ step, nowMs, running = false, writing = false, disabled = false, error = null, later = null, can, mergeStyle, rejected, prWay, onMergeStyle, onRun, onPick, held }: {
  step: Step;
  nowMs: number;
  running?: boolean;
  writing?: boolean;
  /** Off for now (✨ is writing a message). */
  disabled?: boolean;
  error?: StepError | null;
  /** Its click comes with a later step: off, and the line says so [D1143]. */
  later?: string | null;
  can?: (pick: ActionPick) => boolean;
  mergeStyle?: MergeStyle;
  rejected?: boolean;
  prWay?: PrWay;
  onMergeStyle?: (style: MergeStyle) => void;
  onRun?: () => void;
  onPick?: (pick: ActionPick) => void;
  held?: HTMLElement;
}) {
  const words = stepWords(step, nowMs);
  const busy = running || writing || disabled;
  const label = writing ? "Writing message…" : running ? runningWords(step).label : words.label;
  const line = running ? runningWords(step).line : error ? errorWords(error.kind, error.reason) : (later ?? words.line);
  const tone = running ? "quiet" : error ? "bad" : later ? "quiet" : words.tone;
  const variant = step.kind === "catchUp" ? "secondary" : "default";
  const menu = hasActionMenu(step);
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex" title={later ?? words.why}>
        <Button size={null} variant={variant} disabled={busy || words.off || Boolean(later)} onClick={onRun} className={cx(SPLIT, "min-w-0 flex-1 rounded-s-capsule px-2.5")}>
          {running || writing ? <Spinner className="animate-spin motion-reduce:animate-none" /> : icon(step)}
          <span className="truncate">{label}</span>
          {step.kind === "sync" && !busy && (
            <>
              <span className="flex items-center tabular-nums">
                <ArrowDown className="size-icon-xs" />
                {step.behind}
              </span>
              <span className="flex items-center tabular-nums">
                <ArrowUp className="size-icon-xs" />
                {step.ahead}
              </span>
            </>
          )}
        </Button>
        <DropdownMenu modal={false} {...(held && { open: true })}>
          <DropdownMenuTrigger
            render={
              <Button
                size={null}
                variant={variant}
                aria-label="More actions"
                disabled={busy || !menu}
                className={cx(SPLIT, "rounded-e-capsule border-s border-split-edge px-1.5")}
              />
            }
          >
            <ChevronDown />
          </DropdownMenuTrigger>
          {menu && <ActionMenu step={step} mergeStyle={mergeStyle} rejected={rejected} prWay={prWay} can={can} onMergeStyle={onMergeStyle} onPick={onPick} held={held} />}
        </DropdownMenu>
      </div>
      <p className={cx("px-1 text-xs", TONE[tone])}>
        {(step.kind === "fixPr" || (step.kind === "continue" && step.left > 0)) && !running && !error && !later && <Warning className="me-1 inline size-icon-xs align-text-bottom" />}
        {line}
      </p>
    </div>
  );
}
