import { type ReactNode, useId, useState } from "react";

import { cx } from "../components/cx";
import { TooltipIconButton } from "../components/icon-button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "../components/menu";
import { Popover, PopoverContent, PopoverTrigger } from "../components/popover";
import { Segmented } from "../components/segmented";
import { useSidebar } from "../components/sidebar";
import { StateDot } from "../components/state-dot";
import { Switch } from "../components/switch";
import { spacingPx } from "../components/tooltip";
import { useDaemon } from "../daemon";
import { BarChart, ChevronRight, Comment, HelpIcon, Keyboard, Lightbulb, Settings } from "../icons";
import { AppUpdatePill, UpdatesRow } from "./updates";

/** Where a foot menu opens: up from the row, or beside the strip. */
export const footPlacement = (expanded: boolean) =>
  expanded ? ({ side: "top", align: "start" } as const) : ({ side: "right", align: "end", sideOffset: () => spacingPx() * 3 } as const);

type Mode = "off" | "work" | "always";

const MODES: readonly { value: Mode; label: string; hint: string }[] = [
  { value: "off", label: "Off", hint: "The computer sleeps as it normally would" },
  { value: "work", label: "While agents work", hint: "The screen stays on and the computer doesn't sleep while an agent is working" },
  { value: "always", label: "Always", hint: "The screen stays on and the computer doesn't sleep until you turn this off" },
];

// shortcut: shows Rust's default and can't change it, because the daemon doesn't route `awake`; add it to ROUTED, then read and set the mode with run(["awake", mode]).
const MODE: Mode = "work";

/** Keeping the computer awake: a light bulb, lit with a dot while it is; on click, how it stands and when to stay awake. */
function KeepAwakeMenu() {
  const { open: expanded } = useSidebar();
  const { rows } = useDaemon();
  const lid = useId();
  const option = MODES.find((each) => each.value === MODE);
  const on = Boolean(rows?.some((row) => row.works));
  const text = on ? "Awake now" : "No agent is working";
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
          <Segmented fill label="When to keep the computer awake" value={MODE} options={MODES} disabled onChange={() => {}} />
          <p className="text-xs text-muted-foreground">{option?.hint}</p>
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
              window.location.hash = "#accounts";
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

/** Help: both items wait for their pages, so they are drawn and greyed. */
function HelpMenu() {
  const { open: expanded } = useSidebar();
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger render={<TooltipIconButton look="strip" side={expanded ? "top" : "right"} tooltip="Help" />}>
        <HelpIcon />
      </DropdownMenuTrigger>
      <DropdownMenuContent {...(expanded ? ({ side: "top", align: "end" } as const) : footPlacement(false))} className="w-60">
        <DropdownMenuItem disabled>
          <Comment />
          Send feedback…
        </DropdownMenuItem>
        <DropdownMenuItem disabled>
          <Keyboard />
          Keyboard shortcuts
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** A foot icon that moves between the row and the stack: it fades in where it lands. */
function Moving({ open, end = false, children }: { open: boolean; end?: boolean; children: ReactNode }) {
  // Two names for one fade, so it starts again on each turn.
  return <div className={cx("flex motion-reduce:animate-none", open && end && "ms-auto", open ? "animate-foot-row" : "animate-foot-stack")}>{children}</div>;
}

/**
 * The icons at the sidebar's foot. Expanded they make one row, Settings first and Help at the far right;
 * collapsed they stack in the strip, Settings last, so Settings stays in the corner either way.
 */
export function SidebarFoot() {
  const { open } = useSidebar();
  const settings = (
    <TooltipIconButton look="strip" side={open ? "top" : "right"} tooltip="Settings" onClick={() => (window.location.hash = "#accounts")}>
      <Settings />
    </TooltipIconButton>
  );
  return (
    <div className={cx("flex shrink-0 px-2 py-2", open ? "flex-row flex-wrap items-center gap-1" : "flex-col gap-px")}>
      {open && settings}
      <Moving open={open}>
        <KeepAwakeMenu />
      </Moving>
      <Moving open={open}>
        <UsageMenu />
      </Moving>
      <Moving open={open}>
        <UpdatesRow />
      </Moving>
      <Moving open={open}>
        <AppUpdatePill />
      </Moving>
      <Moving open={open} end>
        <HelpMenu />
      </Moving>
      {!open && settings}
    </div>
  );
}
