import type { ReactNode } from "react";

import { cx } from "../components/cx";
import { EmptyState } from "../components/empty-state";
import { Kbd } from "../components/kbd";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuShortcut, DropdownMenuTrigger } from "../components/menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "../components/tooltip";
import { ChatCompose, ChevronDown, Dock, Document, Grid, Search } from "../icons";
import { RightPanelSlot } from "./right-panel";
import { CHAT, HOME, replaceTab, type Tab, useTabs } from "./tab-store";

const CARD = "flex min-w-0 items-center rounded-session-tab bg-fill-faint hover:bg-fill has-data-popup-open:bg-fill";
const TOOL = "flex min-h-10 w-full min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-session-tab px-2.5 py-2 text-start focus-visible:focus-ring disabled:cursor-not-allowed disabled:opacity-disabled";
const ICON = "size-icon-md shrink-0 text-muted-foreground";
const LABEL = "min-w-0 flex-1 truncate";

/** The old app's New tab, with no browser or pages yet: what's picked replaces it. Only Terminal goes anywhere so far [D361, D388]. */
function NewTab({ owner, tab, archived }: { owner: string; tab: Tab; archived: boolean }) {
  const sideChat = (
    <button type="button" aria-label="Side chat" disabled className={TOOL}>
      <ChatCompose className={ICON} />
      <span className={LABEL}>Side chat</span>
      <Kbd>⌥⌘S</Kbd>
    </button>
  );
  return (
    <div data-slot="new-tab-page" className="@container w-full min-w-0 overflow-y-auto px-5 py-8 text-label text-foreground">
      <div className="mx-auto flex w-full max-w-192 flex-col gap-4">
        <h2 className="font-medium">Tools</h2>
        <div className="grid grid-cols-1 gap-x-4 gap-y-1 @new-tab:grid-cols-2">
          <div className={CARD}>
            <button type="button" disabled={archived} onClick={() => replaceTab(owner, tab.id, "terminal")} className={TOOL}>
              <Dock className={ICON} />
              <span className={LABEL}>Terminal</span>
              <Kbd>⌃`</Kbd>
            </button>
          </div>
          <div className={CARD}>
            <button type="button" disabled className={TOOL}>
              <Document className={ICON} />
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
                <Grid className={ICON} />
                <span className={LABEL}>More tools…</span>
                <ChevronDown className={ICON} />
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
          {children}
        </div>
        {tabs.map((tab) => (
          <div key={tab.id} role="tabpanel" aria-label={tab.kind === "new" ? "New tab" : "Terminal"} inert={tab.id !== active} className={cx("absolute inset-0 flex flex-col bg-background", tab.id !== active && "invisible")}>
            {tab.kind === "new" ? <NewTab owner={owner} tab={tab} archived={archived} /> : <EmptyState variant="centered" icon={Dock} title="Terminal" detail="Not connected yet" className="m-auto" />}
          </div>
        ))}
      </div>
      <RightPanelSlot />
    </main>
  );
}
