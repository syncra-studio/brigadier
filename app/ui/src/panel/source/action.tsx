import { type ReactNode, useLayoutEffect, useRef, useState } from "react";

import { Button } from "../../components/button";
import { cx } from "../../components/cx";
import { DropdownMenu, DropdownMenuTrigger } from "../../components/menu";
import { InfoTip } from "../../components/thread/tip";
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
 * Source and the summary card draw the same one, from the same model [D1199].
 * `writing`: Commit only under way, the writer writing its message first [D1029]. `held`: the gallery's open menu.
 */
export function ActionButton({ step, nowMs, running = false, writing = false, disabled = false, say = null, note = null, uncommitted = 0, error = null, later = null, can, mergeStyle, rejected, prWay, onMergeStyle, onRun, onPick, held, moving = null, trail = null }: {
  step: Step;
  nowMs: number;
  running?: boolean;
  writing?: boolean;
  /** Off for now: the agent works, or the daemon's out of reach [D1208, D30]. */
  disabled?: boolean;
  /** A line in place of the pre-check: "Waits for the turn to finish", "Couldn't write a message" [D1208, D1212]. */
  say?: { line: string; tone: Tone } | null;
  /** Added to the pre-check line: "main is 3 behind origin/main" [D1187, D1193]. */
  note?: string | null;
  /** Files not committed yet: the arrow ends with Commit only and Edit message… [D1191, D1203]. */
  uncommitted?: number;
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
  /** While running, words other than the step's own: "When it's done" creating a PR from a merge step [D1201]. */
  moving?: { label: string; line: string } | null;
  /** After the line: the countdown's Cancel [D1201, D1206]. */
  trail?: ReactNode;
}) {
  const words = stepWords(step, nowMs);
  const busy = running || writing || disabled;
  const runWords = moving ?? runningWords(step);
  const label = writing ? "Committing…" : running ? runWords.label : words.label;
  const line = running ? runWords.line : error ? errorWords(error.kind, error.reason) : (say?.line ?? later ?? (note ? `${words.line} · ${note}` : words.line));
  const tone = running ? "quiet" : error ? "bad" : say ? say.tone : later ? "quiet" : words.tone;
  const variant = step.kind === "catchUp" ? "secondary" : "default";
  const menu = hasActionMenu(step, uncommitted);
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
                disabled={busy || !menu || (step.kind === "landed" && uncommitted === 0)}
                className={cx(SPLIT, "rounded-e-capsule border-s border-split-edge px-1.5")}
              />
            }
          >
            <ChevronDown />
          </DropdownMenuTrigger>
          {menu && <ActionMenu step={step} mergeStyle={mergeStyle} rejected={rejected} prWay={prWay} can={can} onMergeStyle={onMergeStyle} onPick={onPick} held={held} uncommitted={uncommitted} />}
        </DropdownMenu>
      </div>
      <OneLine text={line} className={TONE[tone]} trail={trail}>
        {(step.kind === "fixPr" || (step.kind === "continue" && step.left > 0)) && !running && !error && !later && !say && <Warning className="me-1 inline size-icon-xs align-text-bottom" />}
        {line}
      </OneLine>
    </div>
  );
}

/** The grey line: one line at most, cut with an ellipsis; an ⓘ shows the whole line only when it doesn't fit [D1198]. */
function OneLine({ text, className, trail, children }: { text: string; className: string; trail?: ReactNode; children: ReactNode }) {
  const box = useRef<HTMLSpanElement>(null);
  const [cut, setCut] = useState(false);
  useLayoutEffect(() => {
    const el = box.current!;
    const check = () => setCut(el.scrollWidth > el.clientWidth);
    check();
    void document.fonts.ready.then(check);
    const watch = new ResizeObserver(check);
    watch.observe(el);
    return () => watch.disconnect();
  }, [text]);
  return (
    <p className={cx("flex min-w-0 items-center px-1 text-xs", className)}>
      <span ref={box} className="min-w-0 truncate">
        {children}
      </span>
      {cut && (
        <span className="flex shrink-0 text-muted-foreground">
          <InfoTip text={text} />
        </span>
      )}
      {trail && <span className="ms-1.5 shrink-0">{trail}</span>}
    </p>
  );
}
