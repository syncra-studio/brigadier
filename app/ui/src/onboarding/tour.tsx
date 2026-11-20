// The guided tour [D3109]: a few cards over the real app, each with one part lit and the rest dimmed. Offered once on Home
// after onboarding; ⌘K's Take the tour and Settings › General start it again. It only points: it never sends, starts
// a session or changes a setting.
import { useEffect, useId, useLayoutEffect, useState } from "react";
import { createPortal } from "react-dom";

import { Button } from "../components/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "../components/dialog";
import { Popover, PopoverContent } from "../components/popover";
import { holdShortcuts } from "../shortcuts";
import { setProfile, store, useProfile } from "./api";

type Side = "top" | "bottom" | "left" | "right";
type Step = { target: string; side: Side; title: string; line: string };

/** The app as it is today, in the order a first-time user meets it; a step whose part isn't on screen shows centred. */
const STEPS: readonly Step[] = [
  { target: '[data-slot="sidebar-panel"]', side: "right", title: "Projects and sessions", line: "Your projects and their sessions live here; View, beside Search, lists them by project or by session." },
  { target: '[data-slot="composer"]', side: "top", title: "Start a session", line: "Type a task and send it; the pickers set the project, its worktree and branch, what the agent may do unasked and the model, and ⌘N starts one from anywhere." },
  { target: ".strip-squares > *, [data-project-id], [data-row-id]", side: "right", title: "Working or needs you", line: "By a project or session, a spinner means an agent is working, a blue ring that it needs your answer, and a blue dot that there's news." },
  { target: ":has(> .session-tab-list)", side: "bottom", title: "Tabs", line: "After its project's house tab, the open session has its own tabs, its chat first; + opens a web page, a terminal or a note beside them." },
  { target: ".session-tab[data-home]", side: "bottom", title: "The project's page", line: "The house tab is the project's page, with every session in it as a list or a board." },
  { target: ".titlebar-nav", side: "bottom", title: "Back, Forward and the sidebar", line: "Back and Forward retrace where you've been, and the last button folds the sidebar to a strip or hides it." },
  { target: '[aria-controls="right-panel-content"]', side: "bottom", title: "Files", line: "Files shows the session's copy of the code; a file you pick opens as a tab." },
  { target: '[data-slot="sidebar-foot"]', side: "top", title: "Search and Settings", line: "⌘K finds any project or session and runs commands; Settings is here, and both can start this tour again." },
];

const at = store<number | null>(null);

/** Starts the tour from its first step. */
export const startTour = () => at.set(0);

/** Marks the tour offered or taken, so it never comes back on its own. */
const seen = () => void setProfile(["--tour"], { tour_seen: true }).catch((error: unknown) => console.error(error));

const end = () => {
  at.set(null);
  seen();
};

const next = (index: number) => (index === STEPS.length - 1 ? end() : at.set(index + 1));

/**
 * While the tour is open no key reaches the app [D3109]: Esc ends it, ← and → (and Enter, off its buttons) step, and
 * Tab, Enter and Space work its card's buttons. Capture, ahead of the app's own keys; the shortcuts and the menu's are held.
 */
function useTourKeys(touring: boolean) {
  useEffect(() => {
    if (!touring) return;
    holdShortcuts(true);
    const onKeyDown = (event: KeyboardEvent) => {
      const index = at.get();
      if (index === null) return;
      event.stopImmediatePropagation();
      const onButton = event.target instanceof Element && event.target.closest("[data-slot=tour-card] button");
      if (onButton && (event.key === "Enter" || event.key === " ")) return;
      event.preventDefault();
      // Tab goes round the card's buttons: the kit's Popover traps focus only with a Close part.
      if (event.key === "Tab") {
        const buttons = [...document.querySelectorAll<HTMLElement>("[data-slot=tour-card] button")];
        const now = buttons.indexOf(document.activeElement as HTMLElement);
        return buttons[now < 0 ? 0 : (now + (event.shiftKey ? -1 : 1) + buttons.length) % buttons.length]?.focus();
      }
      const plain = !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey;
      if (event.key === "Escape") end();
      else if (!plain || event.repeat) return;
      else if (event.key === "ArrowLeft" && index > 0) at.set(index - 1);
      else if (event.key === "Enter" || (event.key === "ArrowRight" && index < STEPS.length - 1)) next(index);
    };
    addEventListener("keydown", onKeyDown, true);
    return () => {
      removeEventListener("keydown", onKeyDown, true);
      holdShortcuts(false);
    };
  }, [touring]);
}

/** The part a step lights: the first match on screen and drawn (the folded sidebar keeps its full rows, unseen). */
function shown(selector: string): Element | null {
  return (
    [...document.querySelectorAll(selector)].find((found) => {
      const box = found.getBoundingClientRect();
      return box.width > 0 && box.height > 0 && box.right > 0 && box.bottom > 0 && box.left < innerWidth && box.top < innerHeight && !clipped(found, box) && found.checkVisibility({ opacityProperty: true, visibilityProperty: true });
    }) ?? null
  );
}

/** Scrolled or cut out of sight by a box around it that clips, as the sidebar's list scrolled down. */
function clipped(found: Element, box: DOMRect): boolean {
  // Not body: its overflow is the viewport's, checked above, and its own box can be empty.
  for (let up = found.parentElement; up && up !== document.body; up = up.parentElement) {
    const { overflow, overflowY } = getComputedStyle(up);
    if (overflow === "visible") continue;
    const clip = up.getBoundingClientRect();
    // A list that scrolls must show the part whole; a box that only clips (the folded sidebar), some of it.
    const whole = overflowY === "auto" || overflowY === "scroll";
    if (whole ? box.top < clip.top - 1 || box.bottom > clip.bottom + 1 : box.bottom <= clip.top || box.top >= clip.bottom) return true;
    if (box.right <= clip.left || box.left >= clip.right) return true;
  }
  return false;
}

/** The step's part and its box, measured again after the paint (a part still sliding in) and as it or the window resizes. */
function useTarget(selector: string) {
  const [found, setFound] = useState<{ element: Element; box: DOMRect } | null>(null);
  useLayoutEffect(() => {
    const observer = new ResizeObserver(() => measure());
    const measure = () => {
      const element = shown(selector);
      if (element) observer.observe(element);
      setFound(element && { element, box: element.getBoundingClientRect() });
    };
    measure();
    const frame = requestAnimationFrame(measure);
    addEventListener("resize", measure);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      removeEventListener("resize", measure);
    };
  }, [selector]);
  return found;
}

/** A step's words and its way on: Back, Next (Done on the last), Skip tour and where you are. */
function Card({ step, index, titleId, lineId }: { step: Step; index: number; titleId: string; lineId: string }) {
  const last = index === STEPS.length - 1;
  return (
    <div data-slot="tour-card" className="flex w-80 flex-col gap-1.5 p-2">
      <p id={titleId} className="text-sm font-medium">
        {step.title}
      </p>
      <p id={lineId} className="text-sm text-muted-foreground">
        {step.line}
      </p>
      <div className="mt-2 flex items-center gap-1.5">
        <span className="flex-1 text-xs text-muted-foreground tabular-nums">
          {index + 1} of {STEPS.length}
        </span>
        <Button variant="ghost" size="sm" onClick={end}>
          Skip tour
        </Button>
        {index > 0 && (
          <Button variant="outline" size="sm" onClick={() => at.set(index - 1)}>
            Back
          </Button>
        )}
        <Button size="sm" onClick={() => next(index)}>
          {last ? "Done" : "Next"}
        </Button>
      </div>
    </div>
  );
}

/** The tour's current step: lit with its card beside it, or its card centred over the dimmed window. */
function Tour({ index }: { index: number }) {
  const step = STEPS[index];
  const target = useTarget(step.target);
  const titleId = useId();
  const lineId = useId();
  const card = <Card step={step} index={index} titleId={titleId} lineId={lineId} />;
  if (!target) {
    return (
      <Dialog open>
        <DialogContent showCloseButton={false} frame="max-w-fit p-3" aria-labelledby={titleId} aria-describedby={lineId}>
          {card}
        </DialogContent>
      </Dialog>
    );
  }
  const { box } = target;
  return (
    <>
      {/* The whole window catches clicks, the lit part too: the tour only points. An outline, not a ring: a ring is a box-shadow and would replace the dim. */}
      {createPortal(
        <div aria-hidden className="fixed inset-0 z-popup">
          <div data-left={box.left - 4} data-top={box.top - 4} data-width={box.width + 8} data-height={box.height + 8} className="tour-spot fixed rounded-control outline-2 outline-ring" />
        </div>,
        document.body,
      )}
      <Popover open modal>
        <PopoverContent anchor={target.element} side={step.side} collisionAvoidance={{ side: "flip", align: "shift" }} aria-labelledby={titleId} aria-describedby={lineId}>
          {card}
        </PopoverContent>
      </Popover>
    </>
  );
}

/** On Home, once, after onboarding: "Take a 1-minute tour?" Either answer marks it offered. */
function Offer() {
  return (
    <Dialog open onOpenChange={(open) => !open && seen()}>
      <DialogContent showCloseButton={false}>
        <DialogTitle>Take a 1-minute tour?</DialogTitle>
        <DialogDescription>See where projects, sessions and tabs live, and how to get around.</DialogDescription>
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={seen}>
            Not now
          </Button>
          <Button
            onClick={() => {
              seen();
              startTour();
            }}
          >
            Show me
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** The tour and its first offer, past onboarding; `home` says Home is in front, where the offer waits. */
export function TourHost({ home }: { home: boolean }) {
  const index = at.use();
  const profile = useProfile().value;
  useTourKeys(index !== null);
  if (index !== null) return <Tour index={index} />;
  return home && profile?.onboarded && profile.tour_seen === false && <Offer />;
}
