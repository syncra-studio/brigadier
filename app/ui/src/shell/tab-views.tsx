import { type ReactNode, useEffect, useState } from "react";

import { cx } from "../components/cx";
import { EmptyState } from "../components/empty-state";
import { NavRow } from "../components/nav";
import { Kbd } from "../components/kbd";
import { Tooltip, TooltipContent, TooltipTrigger } from "../components/tooltip";
import { Dock, PullRequestOpen, StickyNote } from "../icons";
import { FileViewer } from "../files/viewer";
import { useHomeProject } from "../home/start";
import { Actions } from "../landing/actions";
import { HostOf } from "../landing/host";
import { LivePrTab } from "../landing/live";
import { BackgroundHistory } from "../panel/background-history";
import { useFileRead } from "../panel/git";
import { ago } from "../panel/words";
import { PrInbox } from "../pull-requests/inbox";
import { useDaemon } from "../daemon";
import { ReviewView } from "../review/view";
import { useNoteRun } from "../note/run";
import { run } from "../onboarding/api";
import { newId } from "../session/store";
import { keysOf } from "../shortcuts";
import { LocalServers } from "../browser/new-tab";
import { BrowserTab } from "../browser/tab";
import { TerminalTab } from "../terminal/terminal";
import { TeamTab } from "../workers/live";
import { AttachmentTab } from "./attachment-tab";
import { MockupTab } from "../mockup/live";
import { NoteTab, UNTITLED_NOTE } from "./note-tab";
import { RightPanelSlot } from "./right-panel";
import { SummarySlot } from "./summary-card";
import { CHAT, HOME, isRef, openTab, replaceTab, revealOf, type Tab, TAB_KINDS, useTabs } from "./tab-store";

const CARD = "flex min-w-0 items-center rounded-session-tab bg-fill-faint not-has-disabled:hover:bg-fill has-data-popup-open:bg-fill";
/** A tile [D438]: its icon and key along the top, its name under them. */
const TOOL = "flex w-full min-w-0 flex-1 cursor-pointer flex-col items-start gap-3 rounded-session-tab p-3 text-start focus-visible:focus-ring disabled:cursor-not-allowed disabled:opacity-disabled";
const TOP = "flex min-h-4.5 w-full items-center justify-between gap-2"; // a key's height, so every tile is as tall
const ICON = "size-icon-md shrink-0 text-muted-foreground";
const LABEL = "w-full min-w-0 truncate";

/** A tile's card. Every tile is always drawn; one that can't be used here says why on hover, the tip hung on its card, as
 *  a disabled button hears no pointer. */
function Card({ why, children }: { why: string | null; children: ReactNode }) {
  if (!why) return <div className={CARD}>{children}</div>;
  return (
    <Tooltip>
      <TooltipTrigger render={<div className={CARD} />}>{children}</TooltipTrigger>
      <TooltipContent>{why}</TooltipContent>
    </Tooltip>
  );
}

/** The old app's New tab, under the browser's toolbar: what's picked replaces it [D361, D388, D244, D508]. */
function NewTab({ owner, tab, archived, active }: { owner: string; tab: Tab; archived: boolean; active: boolean }) {
  const shut = archived ? "This session is archived." : null;
  return (
    <div data-slot="new-tab-page" className="@container w-full min-w-0 overflow-y-auto px-5 py-8 text-label text-foreground">
      <div className="mx-auto flex w-full max-w-192 flex-col gap-4">
        <h2 className="font-medium">Tools</h2>
        <div className="grid grid-cols-2 gap-2 @new-tab:grid-cols-3">
          <Card why={shut}>
            <button type="button" disabled={archived} onClick={() => replaceTab(owner, tab.id, "terminal")} className={TOOL}>
              <span className={TOP}>
                <Dock className={ICON} />
                <Kbd>{keysOf("terminal")[1]}</Kbd>
              </span>
              <span className={LABEL}>Terminal</span>
            </button>
          </Card>
          <Card why={shut}>
            <button type="button" disabled={archived} onClick={() => replaceTab(owner, tab.id, "note", newId())} className={TOOL}>
              <span className={TOP}>
                <StickyNote className={ICON} />
              </span>
              <span className={LABEL}>New note</span>
            </button>
          </Card>
          <Card why={null}>
            <button type="button" onClick={() => replaceTab(owner, tab.id, "pr", "list")} className={TOOL}>
              <span className={TOP}>
                <PullRequestOpen className={ICON} />
              </span>
              <span className={LABEL}>Pull requests</span>
            </button>
          </Card>
        </div>
        <LocalServers owner={owner} active={active} onOpen={(url) => replaceTab(owner, tab.id, "browser", url)} />
        <NoteList owner={owner} active={active} onOpen={(note) => replaceTab(owner, tab.id, "note", note)} />
      </div>
    </div>
  );
}

/** The project's notes, newest first, as the old New tab's Recents listed pages; read again each time it shows [D244]. */
function NoteList({ owner, active, onOpen }: { owner: string; active: boolean; onOpen: (note: string) => void }) {
  const [notes, setNotes] = useState<{ id: string; title: string; at: number }[]>([]);
  const run = useNoteRun(owner);
  useEffect(() => {
    if (!active) return;
    let live = true;
    void run(["list"]).then((reply) => live && reply.ok && setNotes(reply.notes.slice(0, 20)));
    return () => {
      live = false;
    };
  }, [run, active]);
  if (notes.length === 0) return null;
  return (
    <section aria-label="Notes" className="flex flex-col gap-2">
      <h2 className="font-medium">Notes</h2>
      <ul className="flex flex-col">
        {notes.map((note) => (
          <li key={note.id}>
            <NavRow onClick={() => onOpen(note.id)} className="text-label text-foreground">
              <StickyNote className="text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate">{note.title || UNTITLED_NOTE}</span>
              <span className="shrink-0 text-muted-foreground">{ago(note.at, Date.now())}</span>
            </NavRow>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** The account Automatic uses for project `id`, its last one read at once; undefined while read with none kept, null for none or unreadable. */
function useAutoAccount(id: string | undefined): string | null | undefined {
  const { daemon } = useDaemon();
  const key = `pullRequests.account.${id}`;
  const [read, setRead] = useState<{ key: string; account: string | null } | null>(null);
  const kept = localStorage.getItem(key) ?? undefined;
  useEffect(() => {
    if (!id || !daemon) return;
    let live = true;
    void run(["projects", "accounts", id]).then(
      ({ auto = null }) => {
        // None is never kept: it can be a read that failed, and the next tab would open as All accounts first.
        if (auto) localStorage.setItem(key, auto);
        else localStorage.removeItem(key);
        if (live) setRead({ key, account: auto });
      },
      () => live && setRead({ key, account: kept ?? null }),
    );
    return () => {
      live = false;
    };
  }, [id, daemon]);
  if (!id) return null;
  return read?.key === key ? read.account : kept;
}

/** The Pull Requests page's inbox as a tab, preset to the session's project and its GitHub account, picked or Automatic's; a
 *  PR opens in its own tab [D314]. */
function PrListTab({ owner, tab }: { owner: string; tab: Tab }) {
  const { rows, projects } = useDaemon();
  const home = useHomeProject();
  const id = owner === HOME ? home?.id : rows?.find((row) => row.id === owner)?.project;
  const picked = id ? projects?.find((each) => each.id === id)?.github_account : null;
  const auto = useAutoAccount(picked ? undefined : (id ?? undefined));
  // Preset once the project's known; the menus then keep what's picked here.
  // shortcut: a closed tab's filters stay in localStorage (a few bytes each); keep them in Rust's tab record if that grows.
  if (!rows || !projects) return null;
  return <PrInbox tab={{ key: `pullRequests.tab.${tab.id}`, preset: id ? { project: id } : {}, account: picked ?? auto, open: (ref) => openTab(owner, "pr", ref) }} />;
}

/** A checkout file, read by Rust [D1002]. */
function FileTab({ owner, tab, active }: { owner: string; tab: Tab; active: boolean }) {
  const path = tab.target ?? "";
  return <FileViewer owner={owner} path={path} read={useFileRead(path)} line={tab.line ?? null} reveal={revealOf(tab.id)} active={active} />;
}

/**
 * The page under the tab bar: the chat, which stays as it was (scrolled, its draft typed) under the open tabs, each
 * keeping its place too, with only the one in front showing. Beside it, the right panel's mount point.
 */
const REVIEW = "@";

export function TabbedMain({ owner, archived, children }: { owner: string; archived: boolean; children: ReactNode }) {
  const { tabs, active } = useTabs(owner);
  // Home's tabs read the picked project's repository until the first message makes its session [D279].
  const home = useHomeProject();
  const host = owner === HOME ? (home?.id ?? null) : null;
  return (
    <main className="flex min-h-0 flex-1 overflow-clip bg-background">
      <div className="relative flex min-h-0 min-w-0 flex-1">
        <div inert={active !== CHAT} className="flex min-h-0 min-w-0 flex-1 flex-col">
          <SummarySlot owner={owner}>{children}</SummarySlot>
        </div>
        {tabs.map((tab) => (
          <div
            key={tab.id}
            role="tabpanel"
            aria-label={TAB_KINDS[tab.kind].name}
            inert={tab.id !== active}
            className={cx("absolute inset-0 flex flex-col bg-background", tab.id !== active && "invisible")}
          >
            {/* A PR named in full (`host/owner/name#n`) is read by the Pull Requests page's own owner, needing no checkout [D159]. */}
            <HostOf.Provider key={host} value={tab.kind === "pr" && isRef(tab.target) ? REVIEW : host}>
              {tab.kind === "pr" && tab.target === "list" ? (
                <PrListTab owner={owner} tab={tab} />
              ) : owner === HOME && !host && (tab.kind === "actions" || (tab.kind === "pr" && !isRef(tab.target))) ? (
                <EmptyState variant="centered" icon={TAB_KINDS[tab.kind].icon} title={TAB_KINDS[tab.kind].name} detail="Pick a project to read its repository" className="m-auto" />
              ) : tab.kind === "file" ? (
                <FileTab key={tab.target} owner={owner} tab={tab} active={tab.id === active} />
              ) : tab.kind === "pr" ? (
                <LivePrTab key={tab.target} owner={owner} target={tab.target ?? ""} />
              ) : tab.kind === "review" ? (
                <ReviewView owner={owner} target={tab.target} tab={tab.id} kept={tab.scope} />
              ) : tab.kind === "attachment" ? (
                <AttachmentTab key={tab.target?.split("/")[0]} owner={owner} id={tab.target?.split("/")[0] ?? ""} label={tab.target?.split("/")[1] ?? ""} active={tab.id === active} />
              ) : tab.kind === "terminal" ? (
                <TerminalTab owner={owner} tab={tab.id} active={tab.id === active} />
              ) : tab.kind === "background" ? (
                <BackgroundHistory owner={owner} />
              ) : tab.kind === "actions" ? (
                <Actions owner={owner} />
              ) : tab.kind === "note" ? (
                <NoteTab key={tab.target} owner={owner} note={tab.target ?? ""} tabId={tab.id} active={tab.id === active} />
              ) : tab.kind === "browser" ? (
                <BrowserTab owner={owner} tab={tab} active={tab.id === active} />
              ) : tab.kind === "workers" || tab.kind === "subagents" ? (
                <TeamTab owner={owner} kind={tab.kind} target={tab.target} />
              ) : tab.kind === "mockup" ? (
                <MockupTab key={tab.target} owner={owner} tab={tab} active={tab.id === active} />
              ) : (
                // The New tab is the browser: Enter or a site turns it into the page, drawn anew [D508].
                <BrowserTab key="new" owner={owner} tab={tab} active={tab.id === active} onNavigate={(url) => replaceTab(owner, tab.id, "browser", url)}>
                  <NewTab owner={owner} tab={tab} archived={archived} active={tab.id === active} />
                </BrowserTab>
              )}
            </HostOf.Provider>
          </div>
        ))}
      </div>
      <RightPanelSlot owner={owner} />
    </main>
  );
}
