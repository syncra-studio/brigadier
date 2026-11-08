import { type ReactNode, type RefObject, useEffect, useRef } from "react";

import { Button } from "../components/button";
import { cx } from "../components/cx";
import { Tooltip, TooltipContent, TooltipTrigger } from "../components/tooltip";
import { ArrowLeft, Spinner } from "../icons";

/*
 * What the setup's steps share, as the old app drew them [D48]: the strip of step marks along the
 * top, a centred heading with a line under it, a body that scrolls on its own, and a footer with
 * Back, a count and the step's one action.
 */

export type Step = "intro" | "name" | "agents" | "projects";
export const STEPS: readonly Step[] = ["name", "agents", "projects"];
const LABELS: Record<Step, string> = { intro: "Welcome", name: "Name", agents: "Agents", projects: "Projects" };

export const MAC = navigator.userAgent.includes("Mac");

/** Focuses what it's given a frame after it mounts. */
export function useFocusOnMount<T extends HTMLElement>(): RefObject<T | null> {
  const ref = useRef<T>(null);
  useEffect(() => {
    const frame = requestAnimationFrame(() => ref.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, []);
  return ref;
}

/*
 * The setup's buttons are the kit's Button with no size (`size={null}`): it gives the cursor, focus
 * ring and disabled look; these give the old app's sizes and type, which the kit's sizes don't have.
 * Continue keeps the kit's default colours; the pills bring their own (`variant={null}`).
 */
/** Pressed, a button shrinks a little and springs back, as the kit's do. */
const PRESS = "inline-flex transition-all motion-safe:active:scale-press-button";
/** Each step's main button: 36 high, 16 before the words, 8 after its key, which sits in a chip. */
const PRIMARY_BUTTON = cx(PRESS, "h-9 gap-2.5 rounded-full ps-4 pe-2 text-label font-medium");
/** The intro's: the steps' own at the large control size, its key's chip grown with it. */
const INTRO_BUTTON = cx(PRESS, "h-control-lg gap-3 rounded-full ps-5 pe-2.5 text-sm font-medium");
/** The key in a button: a capsule tinted with the button's own text colour, as the old app drew it. */
const KEY = "pointer-events-none inline-flex items-center justify-center rounded-capsule border border-transparent bg-current-wash font-sans leading-none select-none";
const PRIMARY_KEY = cx(KEY, "h-4.5 min-w-4.5 px-1.5 text-2xs");
const INTRO_KEY = cx(KEY, "h-5.5 min-w-5.5 px-2 text-xs");
/** The setup's pill: 30 high, round-ended, the label's type. */
export const PILL = cx(PRESS, "h-7.5 rounded-full text-label font-medium");
/** Its quieter ones (Sign in, Install, Add folder…): a raised fill in a hairline, 12 to a side. */
export const RAISED_BUTTON = cx(PILL, "gap-1.75 border border-input bg-setup-raised px-3 text-foreground hover:bg-muted");
/** Back, at the footer's start. */
const BACK_BUTTON = cx(PILL, "gap-1.75 ps-2.5 pe-3 text-muted-foreground hover:bg-fill hover:text-foreground");

/** The strip along the top: the window drags by it, a mark per step; steps already reached can be revisited. */
export function TopBar({ step, reached, onStep }: { step: Step; reached: number; onStep: (step: Step) => void }) {
  const current = STEPS.indexOf(step);
  return (
    <div className="app-drag relative z-10 grid h-titlebar shrink-0 grid-cols-3 items-center px-2">
      <nav aria-label="Setup steps" className="app-no-drag col-start-2 flex items-center justify-center gap-1">
        {STEPS.map((entry, index) => (
          <Tooltip key={entry}>
            <TooltipTrigger
              render={<button type="button" />}
              aria-label={`Step ${index + 1}: ${LABELS[entry]}`}
              aria-current={index === current ? "step" : undefined}
              disabled={index > reached}
              onClick={() => onStep(entry)}
              className={cx(
                "relative h-0.75 cursor-pointer rounded-capsule transition-all disabled:cursor-not-allowed before:absolute before:-inset-x-0.5 before:-inset-y-2",
                index === current ? "w-7.5 bg-foreground" : "w-3.75 bg-muted enabled:hover:bg-faint-foreground",
              )}
            />
            <TooltipContent side="bottom">{LABELS[entry]}</TooltipContent>
          </Tooltip>
        ))}
      </nav>
    </div>
  );
}

/** A step's heading: its title and the line under it. */
export function StepHeader({ title, description }: { title: string; description: ReactNode }) {
  return (
    <header className="mx-auto flex w-full max-w-onboarding shrink-0 flex-col items-center px-6 pt-18 text-center">
      <h1 className="onboarding-heading text-balance">{title}</h1>
      <p aria-live="polite" className="mt-3.5 text-lg text-balance text-muted-foreground">
        {description}
      </p>
    </header>
  );
}

/** Where Enter belongs to what's open or a field that sends, not to the step. */
const OWN_ENTER = "[role=menu], [role=listbox], [role=combobox], [data-own-enter], .xterm";

/** Continue: the steps' main button, larger on the intro. */
export function ContinueButton({ ready, busy = false, intro = false, onClick, form, label = "Continue" }: {
  ready: boolean;
  busy?: boolean;
  intro?: boolean;
  onClick?: () => void;
  form?: string;
  label?: string;
}) {
  const button = useRef<HTMLButtonElement>(null);
  // The intro's takes the focus once usable; a step's never does, so it can't take it from a terminal.
  useEffect(() => {
    if (ready && intro) button.current?.focus();
  }, [ready, intro]);
  return (
    <Button
      ref={button}
      type={form ? "submit" : "button"}
      form={form}
      size={null}
      disabled={intro ? busy : !ready || busy}
      onClick={onClick}
      className={intro ? INTRO_BUTTON : PRIMARY_BUTTON}
    >
      {busy && <Spinner className="animate-spin" />}
      {label}
      <kbd className={intro ? INTRO_KEY : PRIMARY_KEY}>↩</kbd>
    </Button>
  );
}

/**
 * The footer, under a rule: Back (⌘[) at the start; at the end how many are chosen, then the
 * step's action, which Enter presses wherever the focus is.
 */
export function StepFooter({ onBack, count, primary }: {
  onBack?: () => void;
  count?: ReactNode;
  primary: { label: string; onClick: () => void; disabled?: boolean; busy?: boolean };
}) {
  const { onClick, busy = false } = primary;
  const blocked = primary.disabled === true || busy;

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Enter" || event.isComposing) return;
      if (event.target instanceof Element && event.target.closest(OWN_ENTER)) return;
      event.preventDefault();
      event.stopPropagation();
      const others = event.altKey || event.shiftKey || event.ctrlKey;
      if (!event.repeat && !others && !blocked) onClick();
    };
    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () => window.removeEventListener("keydown", onKeyDown, { capture: true });
  }, [onClick, blocked]);

  useEffect(() => {
    if (!onBack) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(MAC ? event.metaKey && event.key === "[" : event.altKey && event.key === "ArrowLeft") || event.repeat) return;
      event.preventDefault();
      if (!busy) onBack();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onBack, busy]);

  return (
    <footer className="shrink-0 border-t border-divider px-6 py-4">
      <div className="mx-auto flex w-full max-w-onboarding items-center gap-2">
        {onBack && (
          <Button
            variant={null}
            size={null}
            aria-keyshortcuts={MAC ? "Meta+BracketLeft" : "Alt+ArrowLeft"}
            disabled={busy}
            onClick={onBack}
            className={BACK_BUTTON}
          >
            <ArrowLeft className="size-3.25" />
            Back
          </Button>
        )}
        <span className="flex-1" />
        {count !== undefined && (
          <span role="status" className="truncate text-xs text-setup-hint tabular-nums">
            {count}
          </span>
        )}
        <span className="ms-3.5">
          <ContinueButton ready={!primary.disabled} busy={busy} onClick={onClick} label={primary.label} />
        </span>
      </div>
    </footer>
  );
}
