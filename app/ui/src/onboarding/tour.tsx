// The guided tour [D3109]: a few cards over the real app, each with one part lit and the rest dimmed. Offered once on Home
// after onboarding; ⌘K's Take the tour and Settings › General start it again. It only points: it never sends, starts
// a session or changes a setting.
import { useId, useLayoutEffect, useState } from "react";
import { createPortal } from "react-dom";

import { Button } from "../components/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "../components/dialog";
import { Popover, PopoverContent } from "../components/popover";
import { setProfile, store, useProfile } from "./api";

type Side = "top" | "bottom" | "left" | "right";
type Step = { target: string; side: Side; title: string; line: string };

/** The app as it is today, in the order a first-time user meets it; a step whose part isn't on screen shows centred. */
const STEPS: readonly Step[] = [
  { target: '[data-slot="sidebar-panel"]', side: "right", title: "Projects and sessions", line: "Your projects and their sessions live here; View, beside Search, lists them by project or by session." },
  { target: '[data-slot="composer"]', side: "top", title: "Start a session", line: "Type a task and send it; the pickers set the project, its worktree and branch, what the agent may do unasked and the model, and ⌘N starts one from anywhere." },
  { target: "[data-project-id], [data-row-id]", side: "right", title: "Working or needs you", line: "By a project or session, a spinner means an agent is working, a blue ring that it needs your answer, and a blue dot that there's news." },
  { target: '[data-slot="session-tabs"]', side: "bottom", title: "Tabs", line: "Each session has its own tabs, its chat first; + opens a web page, a terminal or a note beside it." },
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

/** The part a step lights, when it's on screen. */
function shown(selector: string): Element | null {
  const found = document.querySelector(selector);
  const box = found?.getBoundingClientRect();
  return box && box.width > 0 && box.height > 0 && box.right > 0 && box.left < innerWidth && box.top < innerHeight ? found : null;
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
    <div className="flex w-80 flex-col gap-1.5 p-2">
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
        <Button size="sm" onClick={() => (last ? end() : at.set(index + 1))}>
          {last ? "Done" : "Next"}
        </Button>
      </div>
    </div>
  );
}

/** The tour's current step: lit with its card beside it, or its card centred over the dimmed window. Esc ends it. */
function Tour({ index }: { index: number }) {
  const step = STEPS[index];
  const target = useTarget(step.target);
  const titleId = useId();
  const lineId = useId();
  const card = <Card step={step} index={index} titleId={titleId} lineId={lineId} />;
  const close = (open: boolean, details: { reason: string }) => !open && details.reason === "escape-key" && end();
  if (!target) {
    return (
      <Dialog open onOpenChange={close}>
        <DialogContent showCloseButton={false} frame="max-w-fit p-3" aria-labelledby={titleId} aria-describedby={lineId}>
          {card}
        </DialogContent>
      </Dialog>
    );
  }
  const { box } = target;
  return (
    <>
      {/* The whole window catches clicks, the lit part too: the tour only points. */}
      {createPortal(
        <div aria-hidden className="fixed inset-0 z-popup">
          <div data-left={box.left - 4} data-top={box.top - 4} data-width={box.width + 8} data-height={box.height + 8} className="tour-spot fixed rounded-control ring-2 ring-ring" />
        </div>,
        document.body,
      )}
      <Popover open modal onOpenChange={close}>
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
  if (index !== null) return <Tour index={index} />;
  return home && profile?.onboarded && profile.tour_seen === false && <Offer />;
}
