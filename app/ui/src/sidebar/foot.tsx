import { type ReactNode, useId, useLayoutEffect, useRef, useState } from "react";

import { cx } from "../components/cx";
import { ErrorLine } from "../components/error-line";
import { TooltipIconButton } from "../components/icon-button";
import { Popover, PopoverContent, PopoverTrigger } from "../components/popover";
import { Segmented } from "../components/segmented";
import { useSidebar } from "../components/sidebar";
import { StateDot } from "../components/state-dot";
import { Switch } from "../components/switch";
import { spacingPx, tokenMs } from "../components/tooltip";
import { useDaemon } from "../daemon";
import { setSetting, useSettings } from "../settings/api";
import { KEEP_AWAKE } from "../settings/general";
import { openSettings } from "../settings/shell";
import { errorText } from "../onboarding/api";
import { BarChart, ChevronRight, Lightbulb, Settings } from "../icons";
import { UpdatesRow } from "./updates";

/** Where a foot menu opens: up from the row, or beside the strip. */
export const footPlacement = (expanded: boolean) =>
  expanded ? ({ side: "top", align: "start" } as const) : ({ side: "right", align: "end", sideOffset: () => spacingPx() * 3 } as const);

/** Keeping the computer awake: a light bulb, lit with a dot while it is; on click, how it stands and when to stay awake. */
function KeepAwakeMenu() {
  const { open: expanded } = useSidebar();
  const { rows } = useDaemon();
  const lid = useId();
  // The same value as Settings › General's row [D2016].
  const mode = useSettings().value?.awake;
  const [error, setError] = useState<string | null>(null);
  const option = KEEP_AWAKE.find((each) => each.value === mode);
  const on = mode === "always" || (mode !== "off" && Boolean(rows?.some((row) => row.works)));
  const text = on ? "Awake now" : mode === "off" ? "The computer sleeps as it normally would" : "No agent is working";
  return (
    <Popover>
      <PopoverTrigger
        render={<TooltipIconButton look="strip" side={expanded ? "top" : "right"} tooltip={`Keep awake: ${option?.label ?? ""} · ${text}`} dot={on ? "bg-foreground" : undefined} />}
      >
        <Lightbulb className={cx(on && "text-foreground")} />
      </PopoverTrigger>
      <PopoverContent {...footPlacement(expanded)} padded={false} className="flex w-80 flex-col gap-3 p-3">
        <div className="flex items-start gap-2.5">
          <Lightbulb aria-hidden className={cx("mt-0.5 size-icon-md shrink-0", on ? "text-foreground" : "text-muted-foreground")} />
          <div className="flex min-w-0 flex-col gap-0.5">
            <span className="text-sm font-medium">Keep awake</span>
            <span className={cx("flex items-center gap-1.5 text-xs", on ? "text-foreground" : "text-muted-foreground")}>
              <StateDot {...(on ? { color: "bg-foreground" } : { tone: "off" as const })} />
              {text}
            </span>
          </div>
        </div>
        <div className="flex flex-col gap-1.5">
          <Segmented
            fill
            label="When to keep the computer awake"
            value={mode ?? "work"}
            options={KEEP_AWAKE}
            disabled={!mode}
            onChange={(value) => {
              setError(null);
              setSetting("awake", value).catch((cause: unknown) => setError(errorText(cause)));
            }}
          />
          <p className="text-xs text-muted-foreground">{option?.hint}</p>
          <ErrorLine error={error} />
        </div>
        {/* shortcut: drawn only, this branch has no lid-closed backend; wire it when one lands. */}
        <div className="flex items-start gap-3 border-t border-divider pt-3">
          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span id={`${lid}-label`} className="text-sm">
              With the lid closed too
            </span>
            <span id={`${lid}-hint`} className="text-xs text-muted-foreground">
              Applied whenever the computer is kept awake
            </span>
          </span>
          <Switch className="mt-0.5" aria-labelledby={`${lid}-label`} aria-describedby={`${lid}-hint`} checked={false} disabled />
        </div>
      </PopoverContent>
    </Popover>
  );
}

/** Usage: the list of what each agent has used. Nothing on this branch reports it, so it says so, as the old app did with none. */
function UsageMenu() {
  const { open: expanded } = useSidebar();
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger render={<TooltipIconButton look="strip" side={expanded ? "top" : "right"} tooltip="Usage" />}>
        <BarChart />
      </PopoverTrigger>
      {/* In the row, it lines up with the row's start: Settings and Keep awake sit before it. */}
      <PopoverContent {...footPlacement(expanded)} alignOffset={expanded ? -spacingPx() * 18 : 0} className="w-90">
        <div className="flex items-center justify-between px-2 py-1.5">
          <span className="font-mono text-2xs font-medium tracking-wide text-muted-foreground uppercase">Usage</span>
          <button
            type="button"
            onClick={() => {
              setOpen(false);
              openSettings("accounts");
            }}
            className="flex cursor-pointer items-center gap-1 text-xs font-medium text-link hover:underline"
          >
            Providers
            <ChevronRight className="size-icon-xs" />
          </button>
        </div>
        <p className="px-2 py-1.5 text-xs text-muted-foreground">No agent has reported usage yet.</p>
      </PopoverContent>
    </Popover>
  );
}

/** Glides the foot's icons between the row and the stack with the sidebar's own motion, the same elements throughout. */
function useGlide(open: boolean) {
  const foot = useRef<HTMLDivElement>(null);
  const seen = useRef(open);
  const from = useRef(new Map<Element, [number, number]>());
  const focused = useRef<HTMLElement | null>(null);
  // Read while rendering, before React moves them: where they are now, whatever changed since the last toggle, and mid-glide too.
  if (seen.current !== open && foot.current) {
    seen.current = open;
    focused.current = foot.current.contains(document.activeElement) ? (document.activeElement as HTMLElement) : null;
    const box = foot.current.getBoundingClientRect();
    from.current = new Map(
      [...foot.current.children].map((item) => {
        const at = item.getBoundingClientRect();
        return [item, [at.left - box.left, at.top - box.bottom]];
      }),
    );
  }
  useLayoutEffect(() => {
    // Reversing the icons drops focus from one React moved.
    if (focused.current?.isConnected && document.activeElement !== focused.current) focused.current.focus({ preventScroll: true });
    const box = foot.current!;
    const css = getComputedStyle(box);
    const glide = { duration: tokenMs("--duration-fold"), easing: css.getPropertyValue("--ease-sidebar") };
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    for (const item of box.children as HTMLCollectionOf<HTMLElement>) {
      const was = from.current.get(item);
      // From the bottom: that edge stays put while the box changes height.
      const dx = was ? was[0] - item.offsetLeft : 0;
      const dy = was ? was[1] - (item.offsetTop - box.clientHeight) : 0;
      if (dx || dy) item.animate({ translate: [`${dx}px ${dy}px`, "0 0"] }, glide);
    }
  }, [open]);
  return foot;
}

/**
 * The icons at the sidebar's foot. Expanded they make one row, Settings first. In the strip the same elements
 * reverse to read Archived, updates, Usage, Keep awake, Settings [D211], and Settings stays in the corner
 * either way. `archived` is the strip's Archived icon.
 */
export function SidebarFoot({ archived }: { archived?: ReactNode }) {
  const { open } = useSidebar();
  const foot = useGlide(open);
  // Keyed, so a toggle reverses the same elements: the page's order, and so Tab, runs as the icons read.
  const icons = [
    <TooltipIconButton key="settings" look="strip" side={open ? "top" : "right"} tooltip="Settings" onClick={() => openSettings("general")}>
      <Settings />
    </TooltipIconButton>,
    <KeepAwakeMenu key="awake" />,
    <UsageMenu key="usage" />,
    <UpdatesRow key="updates" />,
    // Always here, fading as the strip's own contents do; out of the row's way when expanded.
    archived && (
      <div key="archived" inert={open} className={cx("flex flex-col items-center transition-opacity motion-reduce:transition-none", open ? "pointer-events-none absolute opacity-0" : "opacity-100")}>
        {archived}
        {/* Set apart from the icons under it by the titlebar's rule, laid flat [D426]. */}
        <span aria-hidden className="strip-rule my-1.5" />
      </div>
    ),
  ];
  // The row's height always, the stack rising over the strip from it, so the list above never resizes on a toggle.
  // The row is its final width from the start, or it would wrap while the panel widens.
  return (
    <div className="relative min-h-11.5 shrink-0">
      <div ref={foot} className={cx("flex px-2 py-2", open ? "sidebar-panel-width relative flex-row flex-wrap items-center gap-1" : "absolute inset-x-0 bottom-0 flex-col gap-px")}>
        {open ? icons : icons.toReversed()}
      </div>
    </div>
  );
}
