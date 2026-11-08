import { type ReactNode, type RefObject, useEffect, useRef } from "react";

import { Button } from "../components/button";
import { cx } from "../components/cx";
import { Kbd } from "../components/kbd";
import { Tooltip, TooltipContent, TooltipTrigger } from "../components/tooltip";
import { Spinner } from "../icons";
import { ArrowLeft } from "./icons";

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

/** The setup's buttons: 30 high, round-ended, the label's type. */
export const PILL_BUTTON = "h-7.5 rounded-full text-label";
/** Each step's main button: 36 high, its key in a chip. */
const PRIMARY_BUTTON = "text-label h-9 gap-2.5 rounded-full ps-4 pe-2";
/** Its quieter ones (Sign in, Install, Add folder…) on `variant="outline"`. */
export const RAISED_BUTTON = cx(PILL_BUTTON, "border border-input px-3 gap-1.5");

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
                "relative h-0.75 rounded-capsule transition-all before:absolute before:-inset-x-0.5 before:-inset-y-2",
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
      disabled={intro ? busy : !ready || busy}
      onClick={onClick}
      className={intro ? "h-control-lg gap-3 rounded-full ps-5 pe-2.5 text-base" : PRIMARY_BUTTON}
    >
      {busy && <Spinner className="animate-spin" />}
      {label}
      <Kbd className={intro ? "h-5.5 px-2" : "px-1.5"}>↩</Kbd>
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
            size="sm"
            variant="ghost"
            aria-keyshortcuts={MAC ? "Meta+BracketLeft" : "Alt+ArrowLeft"}
            disabled={busy}
            onClick={onBack}
            className={cx(PILL_BUTTON, "gap-1.75 ps-2.5 pe-3 text-muted-foreground")}
          >
            <ArrowLeft className="size-3.25" />
            Back
          </Button>
        )}
        <span className="flex-1" />
        {count !== undefined && (
          <span role="status" className="truncate text-xs text-quiet-foreground tabular-nums">
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
