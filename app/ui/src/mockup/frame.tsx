// One variant beside the others: its name, reason and Use, over its live frame [D2066], with the old tab's image
// states per frame: waiting, drawing, loading, and a page that won't load with Retry and its screenshot [D2055].
import { type ReactNode, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { Button } from "../components/button";
import { cx } from "../components/cx";
import { followLayout } from "../browser/follow";
import { ImageSquare } from "../icons";
import { drawn, type Load, type Variant } from "./model";
import type { MockupNote } from "./notes";
import { PinLayer } from "./pins";

/** "fit", or a zoom in percent. */
export type Zoom = "fit" | number;

/** Draws a variant's live page at `url`, or the real screen's (`key` "real"). */
export type PageOf = (key: string, url: string, zoom: Zoom) => ReactNode;

/** The center of an empty or busy frame. */
const MIDDLE = "flex size-full flex-col items-center justify-center gap-3 p-6 text-center text-sm text-muted-foreground";

export function VariantColumn({
  variant,
  label,
  why,
  drawing,
  load,
  zoom,
  page,
  notes,
  pointing,
  onNotes,
  use,
  picked,
  dim,
  onName,
  onRetry,
}: {
  variant: Variant;
  /** "A · Roomy", or "B · Real" in the compare. */
  label: string;
  why?: string | null;
  /** The variant the round draws now, of those not drawn yet. */
  drawing: boolean;
  load?: Load;
  zoom: Zoom;
  page: PageOf;
  notes: readonly MockupNote[];
  pointing: boolean;
  onNotes?: (change: (pins: MockupNote[]) => MockupNote[]) => void;
  /** Its Use button, where it takes one. */
  use?: { onClick: () => void; primary: boolean } | null;
  picked: boolean;
  dim: boolean;
  /** Its name, pressed: this variant alone. */
  onName?: () => void;
  onRetry: () => void;
}) {
  const [shot, setShot] = useState(false);
  // Loads are kept by letter: a new page or round (this column's key) tries its page afresh, not failed from the last.
  useEffect(() => {
    if (load === "failed") onRetry();
  }, []);
  const letter = variant.letter;
  const live = Boolean(variant.url && !shot && load !== "failed");
  let content: ReactNode;
  if (!drawn(variant)) {
    content = drawing ? <div className={MIDDLE}><span className="shimmer">Drawing {letter}…</span></div> : <div className={MIDDLE}>Waiting</div>;
  } else if (variant.url && !shot && load === "failed") {
    content = (
      <div role="alert" className={MIDDLE}>
        <ImageSquare className="size-icon-lg" />
        {letter}’s page didn’t load
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={onRetry}>
            Retry
          </Button>
          {variant.shot && (
            <Button variant="ghost" size="sm" onClick={() => setShot(true)}>
              Show the screenshot
            </Button>
          )}
        </div>
      </div>
    );
  } else if (variant.url && !shot) {
    // The page stays mounted while it loads, so it can finish; the loading line covers it.
    content = (
      <>
        {page(letter, variant.url, zoom)}
        {load === "loading" && <div role="status" className={cx(MIDDLE, "absolute inset-0 bg-background")}><span className="shimmer">Loading {letter}…</span></div>}
      </>
    );
  } else {
    content = (
      <img src={variant.shot ?? ""} alt={`${label}, its screenshot`} draggable={false} className="size-full object-contain object-top select-none" />
    );
  }
  const pins = drawn(variant) && <PinLayer variant={letter} notes={notes} pointing={pointing} onNotes={onNotes} />;
  return (
    <div data-slot="mockup-variant" className="flex min-w-0 flex-1 flex-col gap-1.5">
      <div className="flex h-control-sm min-w-0 items-center gap-1.5 text-sm">
        {onName ? (
          <button type="button" className="shrink-0 cursor-pointer rounded-control font-semibold whitespace-nowrap hover:text-foreground focus-visible:focus-ring" onClick={onName}>
            {label}
          </button>
        ) : (
          <span className="shrink-0 font-semibold whitespace-nowrap">{label}</span>
        )}
        <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{why}</span>
        {use && (
          <Button variant={use.primary ? "default" : "soft"} size="xs" onClick={use.onClick}>
            Use {letter}
          </Button>
        )}
      </div>
      <div data-slot="mockup-frame" className={cx("relative min-h-0 flex-1 overflow-hidden rounded-control border border-border bg-background", picked && "outline-2 outline-primary", dim && "opacity-40")}>
        {content}
        {pins && (live ? <OverPage>{pins}</OverPage> : pins)}
      </div>
    </div>
  );
}

/**
 * Draws `children` over a live page in the frame: the page lies beneath the app, which shows it through a hole
 * (browser/hole.ts), so they go above it at the end of the body, on the frame's box while the frame shows.
 */
function OverPage({ children }: { children: ReactNode }) {
  const box = useRef<HTMLDivElement>(null);
  const [rect, setRect] = useState<{ frame: DOMRect; stage: DOMRect } | null>(null);
  useEffect(() => {
    const element = box.current;
    if (!element) return;
    let placed = "";
    const stop = followLayout(
      () => [element],
      () => {
        const r = element.getBoundingClientRect();
        const stage = element.closest("[data-slot=mockup-stage]")?.getBoundingClientRect() ?? r;
        const next = !element.closest("[inert]") && element.checkVisibility({ visibilityProperty: true }) && r.width > 0 && r.height > 0 ? { frame: r, stage } : null;
        const key = JSON.stringify(next);
        if (key !== placed) {
          placed = key;
          setRect(next);
        }
      },
    );
    return stop;
  }, []);
  return (
    <>
      <div ref={box} className="pointer-events-none absolute inset-0" />
      {rect &&
        createPortal(
          <div className="mockup-over pointer-events-none fixed overflow-hidden" data-left={rect.stage.left} data-top={rect.stage.top} data-width={rect.stage.width} data-height={rect.stage.height}>
            <div
              data-slot="mockup-over-page"
              className="mockup-over absolute overflow-hidden rounded-control"
              data-left={rect.frame.left - rect.stage.left}
              data-top={rect.frame.top - rect.stage.top}
              data-width={rect.frame.width}
              data-height={rect.frame.height}
            >
              {children}
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
