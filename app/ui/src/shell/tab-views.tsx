import type { ReactNode } from "react";

import { cx } from "../components/cx";
import { EmptyState } from "../components/empty-state";
import { Kbd } from "../components/kbd";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuShortcut, DropdownMenuTrigger } from "../components/menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "../components/tooltip";
import { ChatCompose, ChevronDown, Dock, Document, Grid, Search } from "../icons";
import { FileViewer } from "../files/viewer";
import { LivePrTab } from "../landing/live";
import { useFileRead } from "../panel/git";
import { ReviewView } from "../review/view";
import { keysOf } from "../shortcuts";
import { AttachmentTab } from "./attachment-tab";
import { RightPanelSlot } from "./right-panel";
import { SummarySlot } from "./summary-card";
import { CHAT, HOME, replaceTab, revealOf, type Tab, TAB_KINDS, useTabs } from "./tab-store";

const CARD = "flex min-w-0 items-center rounded-session-tab bg-fill-faint hover:bg-fill has-data-popup-open:bg-fill";
/** A tile [D438]: its icon and key or chevron along the top, its name under them. */
const TOOL = "flex w-full min-w-0 flex-1 cursor-pointer flex-col items-start gap-3 rounded-session-tab p-3 text-start focus-visible:focus-ring disabled:cursor-not-allowed disabled:opacity-disabled";
const TOP = "flex min-h-4.5 w-full items-center justify-between gap-2"; // a key's height, so every tile is as tall
const ICON = "size-icon-md shrink-0 text-muted-foreground";
const LABEL = "w-full min-w-0 truncate";

/** The old app's New tab, with no browser or pages yet: what's picked replaces it. Only Terminal goes anywhere so far [D361, D388]. */
function NewTab({ owner, tab, archived }: { owner: string; tab: Tab; archived: boolean }) {
  const sideChat = (
    <button type="button" aria-label="Side chat" disabled className={TOOL}>
      <span className={TOP}>
        <ChatCompose className={ICON} />
        <Kbd>⌥⌘S</Kbd>
      </span>
      <span className={LABEL}>Side chat</span>
    </button>
  );
  return (
    <div data-slot="new-tab-page" className="@container w-full min-w-0 overflow-y-auto px-5 py-8 text-label text-foreground">
      <div className="mx-auto flex w-full max-w-192 flex-col gap-4">
        <h2 className="font-medium">Tools</h2>
        <div className="grid grid-cols-2 gap-2 @new-tab:grid-cols-4">
          <div className={CARD}>
            <button type="button" disabled={archived} onClick={() => replaceTab(owner, tab.id, "terminal")} className={TOOL}>
              <span className={TOP}>
                <Dock className={ICON} />
                <Kbd>{keysOf("terminal")[1]}</Kbd>
              </span>
              <span className={LABEL}>Terminal</span>
            </button>
          </div>
          <div className={CARD}>
            <button type="button" disabled className={TOOL}>
              <span className={TOP}>
                <Document className={ICON} />
              </span>
              <span className={LABEL}>New page</span>
            </button>
          </div>
          <div className={CARD}>
            {owner === HOME ? (
              <Tooltip>
                {/* A disabled button hears no pointer, so its tip hangs on what holds it. */}
                <TooltipTrigger render={<span className="flex w-full" />}>{sideChat}</TooltipTrigger>
                <TooltipContent>Start the session to use Side chat</TooltipContent>
              </Tooltip>
            ) : (
              sideChat
            )}
          </div>
          <div className={CARD}>
            <DropdownMenu>
              <DropdownMenuTrigger render={<button type="button" className={TOOL} />}>
                <span className={TOP}>
                  <Grid className={ICON} />
                  <ChevronDown className={ICON} />
                </span>
                <span className={LABEL}>More tools…</span>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem disabled>
                  <Search />
                  Find file
                  <DropdownMenuShortcut>⌘P</DropdownMenuShortcut>
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      </div>
    </div>
  );
}

/** A checkout file, read by Rust [D1002]. */
function FileTab({ tab, active }: { tab: Tab; active: boolean }) {
  const path = tab.target ?? "";
  return <FileViewer path={path} read={useFileRead(path)} line={tab.line ?? null} reveal={revealOf(tab.id)} active={active} />;
}

/**
 * The page under the tab bar: the chat, which stays as it was (scrolled, its draft typed) under the open tabs, each
 * keeping its place too, with only the one in front showing. Beside it, the right panel's mount point.
 */
export function TabbedMain({ owner, archived, children }: { owner: string; archived: boolean; children: ReactNode }) {
  const { tabs, active } = useTabs(owner);
  return (
    <main className="flex min-h-0 flex-1 overflow-clip rounded-e-surface bg-background">
      <div className="relative flex min-h-0 min-w-0 flex-1">
        <div inert={active !== CHAT} className="flex min-h-0 min-w-0 flex-1 flex-col">
          <SummarySlot owner={owner}>{children}</SummarySlot>
        </div>
        {tabs.map((tab) => (
          <div key={tab.id} role="tabpanel" aria-label={TAB_KINDS[tab.kind].name} inert={tab.id !== active} className={cx("absolute inset-0 flex flex-col bg-background", tab.id !== active && "invisible")}>
            {/* Each kind until it's wired: the terminal comes later [D361]. */}
            {tab.kind === "file" ? (
              <FileTab key={tab.target} tab={tab} active={tab.id === active} />
            ) : tab.kind === "pr" ? (
              <LivePrTab key={tab.target} owner={owner} number={Number(tab.target)} />
            ) : tab.kind === "review" ? (
              <ReviewView owner={owner} target={tab.target} tab={tab.id} kept={tab.scope} />
            ) : tab.kind === "attachment" ? (
              <AttachmentTab key={tab.target?.split("/")[0]} owner={owner} id={tab.target?.split("/")[0] ?? ""} label={tab.target?.split("/")[1] ?? ""} active={tab.id === active} />
            ) : tab.kind === "new" ? <NewTab owner={owner} tab={tab} archived={archived} /> : <EmptyState variant="centered" icon={TAB_KINDS[tab.kind].icon} title={TAB_KINDS[tab.kind].name} detail="Not connected yet" className="m-auto" />}
          </div>
        ))}
      </div>
      <RightPanelSlot owner={owner} />
    </main>
  );
}
