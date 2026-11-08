import { type RefObject, useEffect, useRef, useState } from "react";

import { ArrowUp, PlayTriangle, Stop } from "../../icons";
import { Button } from "../button";
import { Tooltip, TooltipContent, TooltipTrigger } from "../tooltip";
import type { FollowUp } from "./draft";

/** A second Esc within this long stops the run (the first one arms the button). */
const ESC_WINDOW_MS = 2000;
/** How long Stop stays once the run can't be stopped any more, so the button doesn't flicker between steps. */
const STOP_HOLD_MS = 700;
/** Menus, dialogs and the composer's own menus take their Esc first (not the gallery's frozen ones, held open). */
const TAKES_ESC = ["[role=dialog]", "[role=menu]", "[role=listbox]", "[data-slot=composer-menu]"].map((open) => `${open}:not([data-held] *)`).join(", ");
const TEXT_FIELD = "input, textarea, select, [contenteditable=true], [contenteditable='']";

/** `on`, staying true for `ms` after it goes false (and true at once when it comes back). */
function useHeldOn(on: boolean, ms: number): boolean {
  const [held, setHeld] = useState(on);
  if (on && !held) setHeld(true);
  useEffect(() => {
    if (on) return;
    const timer = setTimeout(() => setHeld(false), ms);
    return () => clearTimeout(timer);
  }, [on, ms]);
  return on || held;
}

/**
 * The two-press stop: while the run can be stopped, the first Esc outside menus and dialogs leaves the field
 * (keeping its text) and arms Stop; a second within two seconds stops. With nothing to stop, Esc puts the
 * cursor in the field. Returns whether Stop is armed.
 */
function useEscToStop(on: boolean, stoppable: boolean, onStop: () => void, button: RefObject<HTMLElement | null>): boolean {
  const [armedAt, setArmedAt] = useState<number | null>(null);
  useEffect(() => {
    if (!on) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || event.isComposing || document.querySelector(TAKES_ESC)) return;
      const field = button.current?.closest("[data-slot=composer-card]")?.querySelector<HTMLElement>("[contenteditable]");
      const active = document.activeElement;
      if (!stoppable) {
        if (!(active instanceof HTMLElement && active.matches(TEXT_FIELD))) field?.focus();
        return;
      }
      if (field && active === field) field.blur();
      if (armedAt !== null && event.timeStamp - armedAt < ESC_WINDOW_MS) {
        setArmedAt(null);
        onStop();
      } else {
        setArmedAt(event.timeStamp);
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [on, stoppable, armedAt, onStop, button]);
  useEffect(() => {
    if (armedAt === null) return;
    const timer = setTimeout(() => setArmedAt(null), ESC_WINDOW_MS);
    return () => clearTimeout(timer);
  }, [armedAt]);
  return armedAt !== null && stoppable;
}

/**
 * The composer's send button, a circle: ↑ sends (queues or steers while a turn runs), ■ stops (also while
 * Esc is armed), ▶ resumes a stopped run. Disabled with nothing to send, or with `blocked` saying why.
 */
export function SendButton({
  empty,
  running,
  canStop,
  canResume = false,
  followUp = "queue",
  blocked,
  keys = true,
  armed: frozenArmed = false,
  onSend,
  onStop,
  onResume,
}: {
  empty: boolean;
  running: boolean;
  canStop: boolean;
  canResume?: boolean;
  followUp?: FollowUp;
  /** Why it can't send now ("Reconnecting…"): disabled, with this as its tip. */
  blocked?: string;
  /** `false`: no Esc handling (the gallery's frozen copies, so one Esc doesn't reach them all). */
  keys?: boolean;
  /** Shows Stop armed (the gallery's frozen copy). */
  armed?: boolean;
  onSend: () => void;
  onStop: () => void;
  onResume?: () => void;
}) {
  const button = useRef<HTMLButtonElement>(null);
  const stoppable = useHeldOn(canStop, STOP_HOLD_MS);
  const armed = useEscToStop(keys, stoppable, onStop, button) || frozenArmed;
  const state = armed || (stoppable && empty) ? "stop" : !running && empty && canResume ? "resume" : "send";
  const tip =
    state === "stop"
      ? armed
        ? "Press Esc again to stop"
        : "Stop"
      : state === "resume"
        ? "Resume"
        : (blocked ?? (running && !empty ? (followUp === "steer" ? "Steer" : "Queue") : "Send message"));
  // A circle, as the old app's: not the icon-button corner (D27-D29 are about ghost icons).
  return (
    <Tooltip>
      <TooltipTrigger
        delay={0}
        render={
          <Button
            ref={button}
            aria-label={tip}
            size={null}
            data-state={state}
            disabled={state === "send" && (empty || blocked !== undefined)}
            onClick={state === "stop" ? onStop : state === "resume" ? onResume : onSend}
            className="inline-flex size-control-sm rounded-capsule transition-all motion-safe:active:scale-press"
          >
            {state === "stop" ? <Stop className="size-icon-sm" /> : state === "resume" ? <PlayTriangle /> : <ArrowUp />}
          </Button>
        }
      />
      <TooltipContent side="bottom">{tip}</TooltipContent>
    </Tooltip>
  );
}
