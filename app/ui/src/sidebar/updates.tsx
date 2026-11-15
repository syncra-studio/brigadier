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
import { type Agent, checkAll, useAgents } from "../onboarding/api";
import { runFailure, useAgentSetup } from "../onboarding/agents";
import { versionText } from "../accounts/parts";
import { useDaemon } from "../daemon";
import { footPlacement } from "./foot";

/*
 * The update pill at the sidebar's foot: one, whatever kinds of update there are, and what to update is chosen
 * in its list [D41]. It holds the agents whose own updater has a newer version, as Rust found it: checked a minute
 * after launch and every six hours, as the old app did; Update runs the agent's own, as its page's does.
 * shortcut: no Brigadier release check yet, so the app's own update never shows; wire it when releases exist.
 */

export type UpdateItem = {
  /** "app" for Brigadier, or the agent's id. */
  target: string;
  name: string;
  /** The agent's provider mark. */
  mark: string | null;
  current: string;
  latest: string;
  action: { type: "run" } | { type: "download" } | { type: "restart" } | { type: "manual"; command: string };
  progress: { type: "available" } | { type: "updating" } | { type: "updated" } | { type: "failed"; error: string };
};

/** The old app's: the agents are checked a minute after launch, then this often. */
const FIRST_CHECK_MS = 60_000;
const CHECK_EVERY_MS = 6 * 60 * 60_000;
/** Skipped versions (`name@version`), this window's own choice, kept across launches as the old app kept them. */
const SKIPPED = "skipped-updates";
const readSkipped = (): string[] => JSON.parse(localStorage.getItem(SKIPPED) ?? "[]") as string[];

/** An agent's update as a row: one newer than it, its run while it goes, or why it failed until tried again or closed. */
function itemOf(agent: Agent, skipped: readonly string[], failed: string | undefined): UpdateItem | null {
  const run = agent.setup?.action === "update" ? agent.setup : null;
  const error = runFailure(run, agent.label) ?? (agent.outdated ? failed : undefined);
  if (!run?.running && !error && (!agent.outdated || skipped.includes(`${agent.name}@${agent.latest}`))) return null;
  const progress = run?.running ? ({ type: "updating" } as const) : error ? ({ type: "failed", error } as const) : ({ type: "available" } as const);
  return { target: agent.name, name: agent.label, mark: agent.mark, current: versionText(agent) ?? "", latest: agent.latest ? `v${agent.latest}` : "", action: { type: "run" }, progress };
}

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
  if (items.every((item) => item.action.type === "restart")) return "Restart to update";
  return `${names} ${items.length > 1 ? "updates" : "update"} available`;
}

/** One update in the list: its mark, name and versions, then Update or Download, its progress or its check, and Skip. */
function UpdateRow({ item, onUpdate, onSkip }: { item: UpdateItem; onUpdate: () => void; onSkip: () => void }) {
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
              <Button size="sm" variant="outline" onClick={onUpdate}>
                {action.type === "restart" ? "Restart" : action.type === "download" ? "Download" : progress.type === "failed" ? "Try again" : "Update"}
              </Button>
            )}
            <TooltipIconButton tooltip="Skip this version" side="top" aria-label={`Skip ${item.name} ${item.latest}`} onClick={onSkip}>
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

/** The foot's one update pill, there only while something has a newer version: a chip of marks, lying along the row or standing up in the strip. A click always opens the list. */
export function UpdatesRow() {
  const online = Boolean(useDaemon().daemon);
  const { list } = useAgents();
  const setup = useAgentSetup(list, online);
  const [skipped, setSkipped] = useState(readSkipped);
  useEffect(() => {
    if (!online) return;
    let every: number | undefined;
    const first = window.setTimeout(() => {
      void checkAll(true);
      every = window.setInterval(() => void checkAll(), CHECK_EVERY_MS);
    }, FIRST_CHECK_MS);
    return () => {
      clearTimeout(first);
      clearInterval(every);
    };
  }, [online]);
  const items = (list ?? []).flatMap((agent) => itemOf(agent, skipped, setup.failed[agent.name]) ?? []);
  const update = (item: UpdateItem): Promise<boolean> => {
    const agent = list?.find((each) => each.name === item.target);
    return agent ? setup.begin(agent, "update") : Promise.resolve(false);
  };
  // What a click on the pill does: when all there is is one agent's update it runs itself, it starts at once;
  // anything else (several, a download, a command to copy, a failure to read) opens the list [D199].
  const direct = items.length === 1 && items[0].action.type === "run" && items[0].progress.type === "available" ? items[0] : null;
  const skip = (item: UpdateItem) => {
    const agent = list?.find((each) => each.name === item.target);
    // A failed run is closed; an available version is hidden until a newer one comes out.
    if (item.progress.type === "failed") void setup.close(item.target);
    else if (agent) {
      const next = [...skipped, `${agent.name}@${agent.latest}`];
      localStorage.setItem(SKIPPED, JSON.stringify(next));
      setSkipped(next);
    }
  };
  const { drawn: expanded } = useSidebar();
  const [open, setOpen] = useState(false);
  // Kept while the chip leaves, so it doesn't empty as it shrinks.
  const [last, setLast] = useState(items);
  if (items.length > 0 && JSON.stringify(items) !== JSON.stringify(last)) setLast(items);
  const shown = items.length > 0 ? items : last;
  const busy = shown.some((item) => item.progress.type === "updating");
  const finished = shown.length > 0 && shown.every((item) => item.progress.type === "updated");
  const restart = shown.length > 0 && shown.every((item) => item.action.type === "restart");
  const empty = items.length === 0;
  // The list closes once its last row has shrunk away.
  useEffect(() => {
    if (!empty || !open) return;
    const timer = setTimeout(() => setOpen(false), ITEM_MS);
    return () => clearTimeout(timer);
  }, [empty, open]);
  // Every row an "Update" button could run right now, for "Update all" [D199].
  const runnable = shown.filter((item) => item.action.type !== "manual" && (item.progress.type === "available" || item.progress.type === "failed"));
  return (
    <BarItem show={!empty || open} axis={expanded ? "x" : "y"}>
      <Popover open={open} onOpenChange={(next) => !direct && setOpen(next)}>
        <PopoverTrigger
          render={<TooltipIconButton look={expanded ? "chip" : "chip-tall"} side={expanded ? "top" : "right"} tooltip={direct ? `Update ${direct.name} to ${direct.latest}` : rowLabel(shown)} />}
          onClick={direct ? () => void update(direct).then((started) => !started && setOpen(true)) : undefined}
        >
          {busy ? <Spinner aria-hidden className="animate-spin motion-reduce:animate-none" /> : finished ? <Check aria-hidden /> : restart ? <ArrowRotateCw aria-hidden /> : <DownloadSimple aria-hidden />}
          <span className={cx("flex items-center", !expanded && "flex-col")}>
            {shown.map((item) => (
              <BarItem key={item.target} show={items.includes(item)} axis={expanded ? "x" : "y"}>
                <Glyph item={item} className={cx("size-icon-sm shrink-0", expanded ? "mx-0.5" : "my-0.5")} />
              </BarItem>
            ))}
          </span>
        </PopoverTrigger>
        <PopoverContent {...footPlacement(expanded)} padded={false} className="flex w-96 flex-col p-1.5">
          <BarItem axis="y" show={shown.length > 1}>
            <div className="flex justify-end px-1.5 pt-1 pb-1.5">
              <Button size="sm" variant="secondary" disabled={runnable.length < 2} onClick={() => runnable.forEach((item) => void update(item))}>
                Update all
              </Button>
            </div>
          </BarItem>
          {shown.map((item) => (
            <BarItem key={item.target} axis="y" show={items.includes(item)}>
              <UpdateRow item={item} onUpdate={() => update(item)} onSkip={() => skip(item)} />
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

