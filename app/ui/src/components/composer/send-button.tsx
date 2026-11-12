import { type RefObject, useEffect, useRef, useState } from "react";

import { ArrowUp, ArrowUpRight, PlayTriangle, Stop } from "../../icons";
import { keysOf, matches } from "../../shortcuts";
import { Button } from "../button";
import { Tooltip, TooltipContent, TooltipTrigger } from "../tooltip";
import type { FollowUp } from "./draft";

/** A second Esc within this long stops the run (the first one arms the button). */
const ESC_WINDOW_MS = 2000;
/** How long Stop stays once the run can't be stopped any more, so the button doesn't flicker between steps. */
const STOP_HOLD_MS = 700;
/** Menus, dialogs and the composer's own menus take their Esc first (not the gallery's, held open). */
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
function useEscToStop(stoppable: boolean, onStop: () => void, button: RefObject<HTMLElement | null>): boolean {
  const [armedAt, setArmedAt] = useState<number | null>(null);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!matches(event, "stop") || event.defaultPrevented || document.querySelector(TAKES_ESC)) return;
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
  }, [stoppable, armedAt, onStop, button]);
  useEffect(() => {
    if (armedAt === null) return;
    const timer = setTimeout(() => setArmedAt(null), ESC_WINDOW_MS);
    return () => clearTimeout(timer);
  }, [armedAt]);
  return armedAt !== null && stoppable;
}

const MAC = navigator.userAgent.includes("Mac");

/** Whether ⌘ (Ctrl elsewhere) is held down now, while `on`. */
function useModHeld(on: boolean): boolean {
  const [held, setHeld] = useState(false);
  useEffect(() => {
    if (!on) return;
    const check = (event: KeyboardEvent | PointerEvent) => setHeld(MAC ? event.metaKey : event.ctrlKey);
    const off = () => setHeld(false);
    window.addEventListener("keydown", check);
    window.addEventListener("keyup", check);
    // A ⌘ let go where no key-up reached us shows up as soon as the pointer moves.
    window.addEventListener("pointermove", check);
    window.addEventListener("blur", off);
    return () => {
      window.removeEventListener("keydown", check);
      window.removeEventListener("keyup", check);
      window.removeEventListener("pointermove", check);
      window.removeEventListener("blur", off);
      setHeld(false);
    };
  }, [on]);
  return on && held;
}

/**
 * The composer's send button, a circle: ↑ sends (queues or steers while a turn runs), ■ stops (also while
 * Esc is armed), ▶ resumes a stopped run. With `onSendNew`, holding ⌘ turns ↑ into ↗ and a click starts the message
 * as a new session [D183, D204]. Disabled with nothing to send, or with `blocked` saying why.
 */
export function SendButton({
  empty,
  running,
  canStop,
  canResume = false,
  followUp = "queue",
  blocked,
  to,
  onSend,
  onSendNew,
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
  /** The worker the message goes to alone (the composer's To:). */
  to?: string;
  onSend: () => void;
  /** Starts the message as a new session (⌘-click); without it ⌘ changes nothing. */
  onSendNew?: () => void;
  onStop: () => void;
  onResume?: () => void;
}) {
  const button = useRef<HTMLButtonElement>(null);
  const stoppable = useHeldOn(canStop, STOP_HOLD_MS);
  const armed = useEscToStop(stoppable, onStop, button);
  const state = armed || (stoppable && empty) ? "stop" : !running && empty && canResume ? "resume" : "send";
  const modHeld = useModHeld(onSendNew !== undefined);
  const asNew = state === "send" && onSendNew !== undefined && modHeld && !empty;
  const verb = running && !empty ? (followUp === "steer" ? "Steer" : "Queue") : onSendNew ? "Send" : "Send message";
  const tip =
    state === "stop"
      ? armed
        ? "Press Esc again to stop"
        : "Stop"
      : state === "resume"
        ? "Resume"
        : (blocked ?? (to !== undefined ? `Send to ${to}` : asNew ? "Start as a new session" : onSendNew ? `${verb} ${keysOf("send")[0]} · Start as a new session ${keysOf("start-new")[0]}` : verb));
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
            // Resume waits while one is on its way (no `onResume`) or offline, as Send does.
            disabled={state === "send" ? empty || blocked !== undefined : state === "resume" && (blocked !== undefined || !onResume)}
            onClick={(event) => (state === "stop" ? onStop() : state === "resume" ? onResume?.() : onSendNew && (asNew || (MAC ? event.metaKey : event.ctrlKey)) ? onSendNew() : onSend())}
            className="inline-flex size-control-sm rounded-capsule transition-all motion-safe:active:scale-press"
          >
            {state === "stop" ? <Stop className="size-icon-sm" /> : state === "resume" ? <PlayTriangle /> : asNew ? <ArrowUpRight data-slot="send-new-session" /> : <ArrowUp />}
          </Button>
        }
      />
      <TooltipContent side="bottom">{tip}</TooltipContent>
    </Tooltip>
  );
}
