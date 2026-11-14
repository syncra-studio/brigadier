import { type ReactNode, useEffect, useState } from "react";

import { cx } from "../components/cx";
import { EmptyState } from "../components/empty-state";
import { NavRow } from "../components/nav";
import { Kbd } from "../components/kbd";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuShortcut, DropdownMenuTrigger } from "../components/menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "../components/tooltip";
import { useDaemon } from "../daemon";
import { ChatCompose, ChevronDown, Dock, Document, Grid, Search } from "../icons";
import { FileViewer } from "../files/viewer";
import { PullRequestOpen } from "../landing/icons";
import { LivePrTab } from "../landing/live";
import { PrList } from "../landing/pr-list";
import { BackgroundHistory } from "../panel/background-history";
import { useFileRead } from "../panel/git";
import { openPrs } from "../panel/open";
import { ago } from "../panel/words";
import { ReviewView } from "../review/view";
import { daemonRun } from "../session/composer";
import { newId } from "../session/store";
import { keysOf } from "../shortcuts";
import { WorkersPanelSlot } from "../workers/live";
import { AttachmentTab } from "./attachment-tab";
import { NoteTab, UNTITLED_NOTE } from "./note-tab";
import { RightPanelSlot } from "./right-panel";
import { SummarySlot } from "./summary-card";
import { CHAT, closeTab, HOME, openTab, replaceTab, revealOf, type Tab, TAB_KINDS, useTabs } from "./tab-store";

const CARD = "flex min-w-0 items-center rounded-session-tab bg-fill-faint hover:bg-fill has-data-popup-open:bg-fill";
/** A tile [D438]: its icon and key or chevron along the top, its name under them. */
const TOOL = "flex w-full min-w-0 flex-1 cursor-pointer flex-col items-start gap-3 rounded-session-tab p-3 text-start focus-visible:focus-ring disabled:cursor-not-allowed disabled:opacity-disabled";
const TOP = "flex min-h-4.5 w-full items-center justify-between gap-2"; // a key's height, so every tile is as tall
const ICON = "size-icon-md shrink-0 text-muted-foreground";
const LABEL = "w-full min-w-0 truncate";

/** The old app's New tab, with no browser yet: what's picked replaces it; Side chat and Find file aren't built yet [D361, D388, D240, D244]. */
function NewTab({ owner, tab, archived, active }: { owner: string; tab: Tab; archived: boolean; active: boolean }) {
  // What's picked opens in this tab's place, as Terminal does, though Rust's replace takes no target [D240].
  const replaceWith = (open: () => void) => {
    open();
    closeTab(owner, tab.id);
  };
  // The card's last known PRs, so it opens what the card's PR button opens [D200, D240].
  const prs = useDaemon().rows?.find((row) => row.id === owner)?.prs?.prs ?? [];
  const pullRequests = (
    <button type="button" disabled={owner === HOME} onClick={() => replaceWith(() => openPrs(owner, prs))} className={TOOL}>
      <span className={TOP}>
        <PullRequestOpen className={ICON} />
      </span>
      <span className={LABEL}>Pull requests</span>
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
            <button type="button" disabled={archived || owner === HOME} onClick={() => replaceWith(() => openTab(owner, "note", newId()))} className={TOOL}>
              <span className={TOP}>
                <Document className={ICON} />
              </span>
              <span className={LABEL}>New note</span>
            </button>
          </div>
          <div className={CARD}>
            {owner === HOME ? (
              <Tooltip>
                {/* A disabled button hears no pointer, so its tip hangs on what holds it. */}
                <TooltipTrigger render={<span className="flex w-full" />}>{pullRequests}</TooltipTrigger>
                <TooltipContent>Start the session to see its pull requests</TooltipContent>
              </Tooltip>
            ) : (
              pullRequests
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
                {/* Not built yet, as the old app's ⌥⌘S chat beside the session [D240]. */}
                <DropdownMenuItem disabled>
                  <ChatCompose />
                  Side chat
                  <DropdownMenuShortcut>⌥⌘S</DropdownMenuShortcut>
                </DropdownMenuItem>
                <DropdownMenuItem disabled>
                  <Search />
                  Find file
                  <DropdownMenuShortcut>⌘P</DropdownMenuShortcut>
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
        <NoteList owner={owner} active={active} onOpen={(note) => replaceWith(() => openTab(owner, "note", note))} />
      </div>
    </div>
  );
}

/** The session's notes, newest first, as the old New tab's Recents listed pages; read again each time it shows [D244]. */
function NoteList({ owner, active, onOpen }: { owner: string; active: boolean; onOpen: (note: string) => void }) {
  const [notes, setNotes] = useState<{ id: string; title: string; at: number }[]>([]);
  useEffect(() => {
    if (!active || owner === HOME) return;
    let live = true;
    void daemonRun(["note", owner, "list"]).then((reply) => live && reply.ok && setNotes(reply.notes));
    return () => {
      live = false;
    };
  }, [owner, active]);
  if (notes.length === 0) return null;
  return (
    <section aria-label="Notes" className="flex flex-col gap-2">
      <h2 className="font-medium">Notes</h2>
      <ul className="flex flex-col">
        {notes.map((note) => (
          <li key={note.id}>
            <NavRow onClick={() => onOpen(note.id)} className="text-label text-foreground">
              <Document className="text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate">{note.title || UNTITLED_NOTE}</span>
              <span className="shrink-0 text-muted-foreground">{ago(note.at, Date.now())}</span>
            </NavRow>
          </li>
        ))}
      </ul>
    </section>
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
  const [workersShown, setWorkersShown] = useState(0);
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
              tab.target === "list" ? (
                <PrList owner={owner} />
              ) : (
                <LivePrTab key={tab.target} owner={owner} target={tab.target ?? ""} />
              )
            ) : tab.kind === "review" ? (
              <ReviewView owner={owner} target={tab.target} tab={tab.id} kept={tab.scope} />
            ) : tab.kind === "attachment" ? (
              <AttachmentTab key={tab.target?.split("/")[0]} owner={owner} id={tab.target?.split("/")[0] ?? ""} label={tab.target?.split("/")[1] ?? ""} active={tab.id === active} />
            ) : tab.kind === "background" ? (
              <BackgroundHistory owner={owner} />
            ) : tab.kind === "note" ? (
              <NoteTab key={tab.target} owner={owner} note={tab.target ?? ""} active={tab.id === active} />
            ) : tab.kind === "new" ? <NewTab owner={owner} tab={tab} archived={archived} active={tab.id === active} /> : <EmptyState variant="centered" icon={TAB_KINDS[tab.kind].icon} title={TAB_KINDS[tab.kind].name} detail="Not connected yet" className="m-auto" />}
          </div>
        ))}
      </div>
      <WorkersPanelSlot owner={owner} onShown={setWorkersShown} />
      <RightPanelSlot owner={owner} beside={workersShown} />
    </main>
  );
}
