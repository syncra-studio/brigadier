import { type ReactNode, useEffect, useState } from "react";

import { Button } from "../components/button";
import { ProviderMark } from "../components/composer/model-picker";
import { CopyButton } from "../components/copy-button";
import { cx } from "../components/cx";
import { ErrorLine } from "../components/error-line";
import { TooltipIconButton } from "../components/icon-button";
import { Popover, PopoverContent, PopoverTrigger } from "../components/popover";
import { useSidebar } from "../components/sidebar";
import { ArrowRotateCw, Check, DownloadSimple, Spinner, X } from "../icons";
import { BrigadierMark } from "../onboarding/mark";
import { store } from "../onboarding/api";
import { footPlacement } from "./foot";

/*
 * The update pills at the sidebar's foot, drawn as the old app's. Nothing on this branch checks for updates,
 * so these stay empty and the pills stay away until a backend fills them; Update and Skip have nothing to call.
 */

export type UpdateItem = {
  /** "app" for Brigadier, or the agent's id. */
  target: string;
  name: string;
  /** The agent's provider mark. */
  mark: string | null;
  current: string;
  latest: string;
  action: { type: "run" } | { type: "download" } | { type: "manual"; command: string };
  progress: { type: "available" } | { type: "updating" } | { type: "updated" } | { type: "failed"; error: string };
};
export type AppUpdate = { state: "available" | "updating" | "failed" | "ready"; version: string };

export const updates = store<UpdateItem[]>([]);
export const appUpdate = store<AppUpdate | null>(null);

/** How long an item takes to grow in or shrink away. */
const ITEM_MS = 200;

/** Something only sometimes there: it grows and fades in, and shrinks and fades out, so its neighbours glide. */
function BarItem({ show, axis = "x", children }: { show: boolean; axis?: "x" | "y"; children: ReactNode }) {
  const [kept, setKept] = useState(show);
  const [opened, setOpened] = useState(show);
  useEffect(() => {
    if (show) {
      const open = () => {
        setKept(true);
        setOpened(true);
      };
      // Laid out closed first, so the opening has somewhere to start from. Frames stop while the window is hidden, so a timer opens it too.
      let frame = requestAnimationFrame(() => {
        frame = requestAnimationFrame(open);
      });
      const timer = setTimeout(open, ITEM_MS / 4);
      return () => {
        cancelAnimationFrame(frame);
        clearTimeout(timer);
      };
    }
    const timer = setTimeout(() => {
      setKept(false);
      setOpened(false);
    }, ITEM_MS);
    return () => clearTimeout(timer);
  }, [show]);
  const instant = matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (!show && (!kept || instant)) return null;
  return (
    <div inert={!show} aria-hidden={!show || undefined} data-axis={axis} data-open={(show && (opened || instant)) || undefined} className="bar-item shrink-0 motion-reduce:transition-none">
      <div className={cx("flex overflow-hidden", axis === "x" ? "min-w-0 items-center" : "min-h-0 flex-col")}>{children}</div>
    </div>
  );
}

const Glyph = ({ item, className }: { item: UpdateItem; className: string }) => (item.target === "app" ? <BrigadierMark aria-hidden className={className} /> : <ProviderMark mark={item.mark} className={className} />);

/** "Codex update available", "Brigadier and Codex updates available", "Updating Codex". */
function rowLabel(items: readonly UpdateItem[]) {
  const all = items.map((item) => item.name);
  const names = all.length > 1 ? `${all.slice(0, -1).join(", ")} and ${all.at(-1)}` : (all[0] ?? "");
  if (items.some((item) => item.progress.type === "updating")) return `Updating ${names}`;
  if (items.every((item) => item.progress.type === "updated")) return `${names} updated`;
  return `${names} ${items.length > 1 ? "updates" : "update"} available`;
}

/** One update in the list: its mark, name and versions, then Update or Download, its progress or its check, and Skip. */
function UpdateRow({ item }: { item: UpdateItem }) {
  const { progress, action } = item;
  return (
    <div className="flex flex-col gap-1.5 px-1.5 py-1.5">
      <div className="flex items-center gap-2.5">
        <Glyph item={item} className="size-icon-md shrink-0" />
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-sm">{item.name}</span>
          <span className="text-xs text-muted-foreground tabular-nums">{progress.type === "updated" ? `Updated to ${item.current}` : `${item.current} → ${item.latest}`}</span>
        </div>
        {progress.type === "updating" ? (
          <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Spinner className="size-icon-sm animate-spin motion-reduce:animate-none" />
            Updating…
          </span>
        ) : progress.type === "updated" ? (
          <Check aria-label="Updated" className="size-icon-sm shrink-0 text-muted-foreground" />
        ) : (
          <>
            {action.type !== "manual" && (
              <Button size="sm" variant="outline">
                {action.type === "download" ? "Download" : progress.type === "failed" ? "Try again" : "Update"}
              </Button>
            )}
            <TooltipIconButton tooltip="Skip this version" side="top" aria-label={`Skip ${item.name} ${item.latest}`}>
              <X />
            </TooltipIconButton>
          </>
        )}
      </div>
      {action.type === "manual" && progress.type === "available" && (
        <div className="flex flex-col gap-1 ps-7">
          <span className="text-xs text-muted-foreground">Run this in a terminal to update:</span>
          <div className="flex items-center gap-1 rounded-sm bg-setup-raised ps-2">
            <code className="min-w-0 flex-1 truncate font-mono text-xs">{action.command}</code>
            <CopyButton text={action.command} tooltip="Copy the command" />
          </div>
        </div>
      )}
      {progress.type === "failed" && (
        <div role="alert" className="ps-7">
          <ErrorLine error={progress.error} />
        </div>
      )}
    </div>
  );
}

/** Updates at the foot, there only while something has a newer version: a chip of marks in the row, an icon with a dot on the strip. */
export function UpdatesRow() {
  const items = updates.use();
  const { open: expanded } = useSidebar();
  const [open, setOpen] = useState(false);
  // Kept while the chip leaves, so it doesn't empty as it shrinks.
  const [last, setLast] = useState(items);
  if (items.length > 0 && JSON.stringify(items) !== JSON.stringify(last)) setLast(items);
  const shown = items.length > 0 ? items : last;
  const busy = shown.some((item) => item.progress.type === "updating");
  const finished = shown.length > 0 && shown.every((item) => item.progress.type === "updated");
  const only = shown.length === 1 && shown[0]!.target !== "app" && shown[0]!.action.type === "run" && shown[0]!.progress.type === "available" ? shown[0]! : null;
  const empty = items.length === 0;
  // The list closes once its last row has shrunk away.
  useEffect(() => {
    if (!empty || !open) return;
    const timer = setTimeout(() => setOpen(false), ITEM_MS);
    return () => clearTimeout(timer);
  }, [empty, open]);
  return (
    <BarItem show={!empty || open} axis={expanded ? "x" : "y"}>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger
          render={<TooltipIconButton look={expanded ? "chip" : "strip"} side={expanded ? "top" : "right"} tooltip={only ? `Update ${only.name} to ${only.latest}` : rowLabel(shown)} dot={expanded || busy || finished ? undefined : "bg-foreground"} />}
        >
          {busy ? <Spinner aria-hidden className="animate-spin motion-reduce:animate-none" /> : finished ? <Check aria-hidden /> : <DownloadSimple aria-hidden />}
          {expanded && (
            <span className="flex items-center">
              {shown.map((item) => (
                <BarItem key={item.target} show={items.includes(item)}>
                  <Glyph item={item} className="mx-0.5 size-icon-sm shrink-0" />
                </BarItem>
              ))}
            </span>
          )}
        </PopoverTrigger>
        <PopoverContent {...footPlacement(expanded)} padded={false} className="flex w-96 flex-col p-1.5">
          {shown.map((item) => (
            <BarItem key={item.target} axis="y" show={items.includes(item)}>
              <UpdateRow item={item} />
            </BarItem>
          ))}
          <BarItem axis="y" show={items.some((item) => item.target !== "app" && item.progress.type !== "available")}>
            <p className="px-1.5 pt-1 pb-1 text-xs text-muted-foreground">Sessions already running keep the version they started with.</p>
          </BarItem>
        </PopoverContent>
      </Popover>
    </BarItem>
  );
}

const TIPS: Record<AppUpdate["state"], (version: string) => string> = {
  available: (version) => `Update Brigadier to ${version}`,
  updating: () => "Updating Brigadier",
  failed: () => "Couldn't update Brigadier. Click to try again",
  ready: () => "Restart to update",
};

/** Brigadier's own update, as the agents' pill: only the icon changes between its states, so it keeps its place and size. */
export function AppUpdatePill() {
  const update = appUpdate.use();
  const { open: expanded } = useSidebar();
  const state = update?.state ?? "available";
  const busy = state === "updating";
  return (
    <BarItem show={update !== null} axis={expanded ? "x" : "y"}>
      <TooltipIconButton look={expanded ? "chip" : "strip"} side={expanded ? "top" : "right"} tooltip={TIPS[state](update?.version ?? "")} aria-busy={busy || undefined} dot={expanded || busy ? undefined : "bg-foreground"}>
        {busy ? <Spinner aria-hidden className="animate-spin motion-reduce:animate-none" /> : state === "ready" ? <ArrowRotateCw aria-hidden /> : <DownloadSimple aria-hidden />}
        {expanded && <BrigadierMark aria-hidden className="mx-0.5 size-icon-sm shrink-0" />}
      </TooltipIconButton>
    </BarItem>
  );
}
