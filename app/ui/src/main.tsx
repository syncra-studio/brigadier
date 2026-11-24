import { PrDialogHost } from "./panel/create-pr";
import { lazy, type ReactNode, Suspense, useEffect, useLayoutEffect, useRef, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";

import { loadAccounts } from "./accounts/api";
import { SessionOfThread } from "./accounts/limit";
import { SidebarProvider } from "./components/sidebar";
import { WorkingLine } from "./components/thread/work";
import { DrawBoundary } from "./components/thread/error-state";
import { hhmm } from "./thread/words";
import { Toaster } from "./components/toast";
import { TooltipProvider } from "./components/tooltip";
import { openThread, peekThread, type Row, useDaemon, useThread } from "./daemon";
import { HomeDraft, StartingBubble, StartingLine, StartingSetup } from "./home/home";
import { newChat, newSession, setHomeDraft, splitNewChat, useHomeDraft, useStart, useStartingRows } from "./home/start";
import { PrInbox } from "./pull-requests/inbox";
import { PullRequestsNav } from "./pull-requests/nav";
import { PrPage, ReviewDraft } from "./pull-requests/page";
import { prPageOf, reviewChats } from "./pull-requests/route";
import { Chat, Key } from "./icons";
import { EmptyState } from "./components/empty-state";
import { intro, loadProfile, useProfile } from "./onboarding/api";
import { Onboarding } from "./onboarding/onboarding";
import { TourHost } from "./onboarding/tour";
import { GlobalSearch } from "./palette/palette";
import { AddProjectHost } from "./projects/add-project";
import { listenToMenu } from "./projects/store";
import { FeedbackDialog } from "./feedback/dialog";
import { FolderDrop } from "./shell/folder-drop";
import { ProjectPage, projectPageOf } from "./projects/page";
import { useProjects } from "./projects/projects";
import { RemoveProjectHost } from "./projects/remove";
import { TrustHost } from "./projects/trust";
import { ArchivedPage } from "./sessions/archived";
import { Demo } from "./session/Demo";
import { ArrivingBubbles, useArriving } from "./peers/live";
import { SessionComposer } from "./session/composer";
import { SentBubbles, useSending } from "./session/sent";
import { ImageViewerHost } from "./components/image-viewer";
import { ThreadDrop } from "./session/files";
import { RewindProvider } from "./session/rewind";
import { answeringSource } from "./session/decisions";
import { PendingModelLine, useModelPick } from "./session/model";
import { PendingSideLines, useSidePending } from "./session/side";
import { TabBar } from "./shell/tab-bar";
import { HOME } from "./shell/tab-store";
import { TabbedMain } from "./shell/tab-views";
import { FakeCaption, TitlebarNav } from "./shell/titlebar";
import { loadSettings } from "./settings/api";
import { useNotices } from "./settings/notices";
import { preloadRouting } from "./settings/routing";
import { listenToSettingsKeys, SettingsNav, SettingsView, settingsPageOf } from "./settings/shell";
import { useShown } from "./sidebar/actions";
import { useSeen } from "./sidebar/seen";
import { AppSidebar, useStored } from "./sidebar/sidebar";
import { Strip } from "./sidebar/strip";
import { Thread, type ThreadHandle } from "./thread/thread";
import { installBrowserAgent } from "./browser/agent";
import { installTabLayer } from "./browser/layer";
import { installLinks } from "./browser/links";
import "./theme.css";

// A hash change is in-page, so Electron's will-navigate guard lets it through.
const onHash = (listener: () => void) => {
  window.addEventListener("hashchange", listener);
  return () => window.removeEventListener("hashchange", listener);
};
const useHash = (): string => useSyncExternalStore(onHash, () => window.location.hash);

// The screen that was open comes back when the app reopens; Accounts is Settings › Providers now [D2004, D2054].
if (!window.location.hash) window.location.hash = localStorage.getItem("route") ?? "";
if (window.location.hash === "#accounts" || window.location.hash === "#settings/accounts") window.location.hash = "#settings/providers";
// Settings isn't kept: it reopens on what it was opened from, as the old app's lastSelection had it.
window.addEventListener("hashchange", () => window.location.hash.startsWith("#settings") || localStorage.setItem("route", window.location.hash));

function App() {
  const { daemon, refused, projects, rows: saved } = useDaemon();
  const hash = useHash();
  const open = hash.startsWith("#thread/") ? decodeURIComponent(hash.slice("#thread/".length)) : null;
  // Rust's rows, with the sessions Home is still starting [D30].
  const rows = useStartingRows(open);
  const chats = reviewChats.use();
  // ⌘N and File › New Chat: the draft last open, from anywhere [D184].
  useEffect(() => window.brigadier?.onMenu((command) => command === "new-session" && newChat()), []);
  const listed = Boolean(daemon && projects && saved);
  useEffect(() => {
    if (listed) void splitNewChat(projects!, saved!);
  }, [listed]);
  const profile = useProfile();
  // The profile says whether this is the first launch: asked again on each reconnect until known.
  useEffect(() => {
    if (daemon && !profile.value) loadProfile();
  }, [daemon, profile.value]);
  // Loaded at start, so a limit line opens with its last words, not after a reload [D460].
  useEffect(() => {
    if (daemon) {
      void loadAccounts();
      loadSettings();
      // Routing's dot, for an offer Brigadier works out on this read [D386], and its page's first paint [D321].
      preloadRouting();
    }
  }, [daemon]);
  // Notices and the Dock badge for the app's lifetime [D200, D2012].
  useNotices(open);
  // A window held clear for the first launch's intro (main's intro.ts) shows at once when there's none.
  const playsIntro = profile.value && !profile.value.onboarded && !profile.value.intro_seen && hash !== "#states";
  const knownNot = playsIntro === false || hash === "#states" || Boolean(refused || profile.error);
  useEffect(() => {
    if (knownNot) void intro.release()?.catch((error: unknown) => console.error(error));
  }, [knownNot]);
  // The launch screen stays until the first screen is known: the profile, or why it can't load [D283].
  const known = hash === "#states" || Boolean(profile.value || profile.error || refused) || daemon === null;
  useEffect(() => {
    if (known) endLaunchScreen(Boolean(playsIntro));
  }, [known, playsIntro]);
  if (hash === "#states") return <Demo />;
  if (!profile.value) return <FirstLoad error={daemon === null ? (refused ?? "Daemon not reachable · reconnecting…") : profile.error} />;
  if (!profile.value.onboarded) return <Onboarding profile={profile.value} />;
  const settings = settingsPageOf(hash);
  if (settings !== null) {
    return (
      <Shell hash={hash} active={null} rows={rows} settings={settings}>
        <SettingsView page={settings} />
      </Shell>
    );
  }
  const page = projectPageOf(hash);
  if (page !== null) {
    // Its settings, with no tab bar, as Settings' [D176 D179].
    return (
      <Shell hash={hash} active={null} rows={rows} page={page}>
        <ProjectPage id={page} />
      </Shell>
    );
  }
  const prs = prPageOf(hash);
  if (prs !== null) {
    // A PR fills the page with its review chat floating over it [D237]; no PR, its inbox [D243].
    const chat = prs ? chats[prs] : undefined;
    // Before the rows are read it's taken as live, so a send in that moment can't start a second review chat.
    const live = chat && (rows ? rows.some((row) => row.id === chat && !row.archived) : true) ? chat : undefined;
    return (
      <Shell hash={hash} active={live ?? null} rows={rows} prs={prs}>
        {prs ? (
          <PrPage key={prs} target={prs} chat={live}>
            {live ? <SessionThread id={live} rows={rows} offline={daemon === null} docked /> : <ReviewDraft review={prs} />}
          </PrPage>
        ) : (
          <PrInbox />
        )}
      </Shell>
    );
  }
  if (open !== null) {
    return (
      <Shell hash={hash} active={open} rows={rows}>
        <SessionThread id={open} rows={rows} offline={daemon === null} />
      </Shell>
    );
  }
  return (
    <Shell hash={hash} active={null} rows={rows}>
      <Home>
        <HomeDraft />
      </Home>
    </Shell>
  );
}

// The strip and sidebar beside every screen after onboarding [D173, D174]; shown and its width kept across launches. The
// shell [D69]: no frame, the strip and sidebar flush at the window's start and the main area from its edge to the window's
// end, the titlebar row across both. Settings keeps the sidebar shown with its nav in place of the sessions [D2004].
function Shell({ hash, active, rows, settings, page, prs, children }: { hash: string; active: string | null; rows: Row[] | undefined; settings?: string; page?: string; prs?: string; children: ReactNode }) {
  const { daemon } = useDaemon();
  // With this window's unanswered changes on top, so a pin shows at once [D30, D808].
  const projects = useProjects();
  const [open, setOpen] = useStored("sidebar.open", true);
  const [width, setWidth] = useStored<number | null>("sidebar.width", null);
  useSeen(rows?.find((row) => row.id === active));
  // One tab bar for every page but Settings and a project's, kept as the page changes so its tabs change smoothly: the
  // old ones shrink out, the new grow in [D836 D854 D179]. It shows a rename or an archive at once [D30].
  const titled = useShown(rows)?.find((each) => each.id === active);
  // The Pull Requests page lights its strip button [D194].
  const pulls = hash.startsWith("#pull-requests");
  const home = active === null && page === undefined && settings === undefined && prs === undefined;
  const rail = (squares?: ReactNode) => (
    <Strip pulls={pulls} settings={settings}>
      {squares}
    </Strip>
  );
  return (
    <div
      className="fixed inset-0"
      // A session row under the pointer or focus: its rows are fetched before the click [D477].
      onPointerOver={(event) => peekRow(event.target, REST_MS)}
      onPointerDown={(event) => peekRow(event.target)}
      onFocus={(event) => peekRow(event.target)}
    >
      <SidebarProvider open={open} onOpenChange={setOpen} width={width} onWidthChange={setWidth}>
        {/* One sidebar for every page: Settings' and Pull Requests' navs crossfade over the sessions in it [D2004 D225]. */}
        <AppSidebar
          rows={rows}
          projects={projects ?? []}
          active={active}
          page={page}
          offline={daemon === null}
          onOpen={(id) => (window.location.hash = `#thread/${encodeURIComponent(id)}`)}
          // Archived, its project's draft, or Chats'; deleted, its project no longer known, the draft last open [D184].
          onNewSession={() => {
            const gone = rows?.find((row) => row.id === active);
            if (gone) newSession(gone.project);
            else newChat();
          }}
          onNewChat={newChat}
          rail={rail}
          nav={settings !== undefined ? <SettingsNav current={settings} /> : prs !== undefined ? <PullRequestsNav current={prs} /> : undefined}
        />
        {/* Settings' page is the main area too. */}
        <div className="main-surface flex min-w-0 flex-1 flex-col overflow-clip pt-tab-bar">{children}</div>
        {/* None on the Pull Requests page: a PR fills it, its review chat floating over it [D237]. */}
        {settings === undefined && page === undefined && prs === undefined && <TabBar owner={active ?? HOME} row={active ? titled : undefined} offline={daemon === null} />}
        <TitlebarNav hash={hash} rows={rows} />
        <FakeCaption />
      </SidebarProvider>
      {/* Past onboarding only, so it never asks there [D167]. */}
      <TrustHost active={active} />
      <RemoveProjectHost />
      <FeedbackDialog />
      <FolderDrop />
      <TourHost home={home} />
    </div>
  );
}

// Home is a new session's draft [D161], a project's or Chats', with its own tabs [D706].
function Home({ children }: { children: ReactNode }) {
  const { project } = useHomeDraft();
  const projects = useProjects();
  // A removed project's draft goes with it.
  const gone = project !== null && projects !== undefined && !projects.some((each) => each.id === project);
  useLayoutEffect(() => setHomeDraft({ review: undefined, ...(gone && { project: null }) }), [gone]);
  return (
    <>
      <TabbedMain owner={HOME} archived={false}>
        {children}
      </TabbedMain>
    </>
  );
}

/** Fades the launch screen (index.html) out over the first screen; at once under the intro, which needs the window clear. */
function endLaunchScreen(now = false): void {
  const splash = document.getElementById("splash");
  if (!splash || (!now && "leaving" in splash.dataset)) return;
  splash.dataset.leaving = "";
  // A timer, not transitionend: a covered window runs no transitions.
  setTimeout(() => splash.remove(), now ? 0 : parseFloat(getComputedStyle(splash).transitionDuration) * 1000);
}

// Before the profile is known: a blank window that drags, or why it can't load.
function FirstLoad({ error }: { error?: string }) {
  return (
    <main className="app-drag fixed inset-0 flex items-center justify-center">
      <p className={error ? "text-sm text-destructive" : "text-sm text-muted-foreground"}>{error ?? "Loading…"}</p>
    </main>
  );
}

/** A row the pointer rests on is peeked shortly, so a sweep down the sidebar folds nothing; a press or focus at once. */
const REST_MS = 80;
let resting: ReturnType<typeof setTimeout> | undefined;
const peekRow = (target: EventTarget, wait = 0) => {
  const id = target instanceof Element ? target.closest("[data-row-id]")?.getAttribute("data-row-id") : null;
  clearTimeout(resting);
  if (id) resting = setTimeout(() => peekThread(id), wait);
};

// One session's thread, straight from Rust's fold [D64, D65]; the view draws it, with no folding here.
// Docked, it's the Pull Requests page's floating review chat: no tabs, its thread hidden while the dock is compact [D237].
function SessionThread({ id, rows, offline, docked }: { id: string; rows: Row[] | undefined; offline: boolean; docked?: boolean }) {
  const row = rows?.find((each) => each.id === id);
  const thread = useRef<ThreadHandle>(null);
  // Before the paint, and the Thread waits for it below: a new one never starts on the last session's rows.
  useLayoutEffect(() => openThread(id), [id]);
  const state = useThread();
  const sending = useSending(id);
  const sides = useSidePending(id);
  const arriving = useArriving(id, answeringSource);
  const picking = useModelPick(id);
  const line =
    row?.state === "stalled" ? <WorkingLine state="stalled">Stalled · no output from the agent for a while</WorkingLine> :
    // The agent's own retry and safety hold, in its words' place (D487).
    row?.state === "retrying" ? <WorkingLine state="live">{retryWords(row.reason)}</WorkingLine> :
    row?.state === "checking" && <WorkingLine state="live">Running extra safety checks · this can take a little longer</WorkingLine>;
  // Started from Home and not made yet: "not found" means "not yet" [D30].
  const starting = useStart(id);
  const missing = state?.status === "missing" && !starting;
  const body = (
        <div className="flex min-h-0 flex-1">
          {missing ? (
            <EmptyState variant="centered" icon={Chat} title="This conversation isn’t available" detail="Brigadier has no conversation by this name. Pick another in the sidebar." className="m-auto" />
          ) : (
            <div className={`flex min-h-0 min-w-0 flex-1 flex-col ${offline ? "opacity-disabled" : ""}`}>
              {/* A load error leaves the thread's place empty: its notice and Retry are on the composer's rail. */}
              {/* Fresh for each session [D490], keyed apart from the composer beside it: React loses one of two siblings sharing a key, and its rows stay on screen. */}
              <DrawBoundary key={`thread:${id}`} summary="This conversation couldn’t be shown" className="mx-auto min-h-0 w-full max-w-reading flex-1 px-6 pt-8">
              <ThreadDrop owner={id}>
                {/* Archived, its page takes the thread's place; new sessions keep their pending message [D487, D458]. */}
                {row?.archived ? (
                  <ArchivedPage row={row} />
                ) : state?.status === "error" ? null : (starting || state?.id === id) && (
                <SessionOfThread value={{ id, offline }}>
                  <RewindProvider key={id} id={id} row={row} offline={offline}>
                  <Thread
                    key={id}
                    id={id}
                    ref={thread}
                    source={answeringSource}
                    footer={
                      (line || sending || starting || sides || picking || arriving.length > 0) && (
                        <>
                          <StartingBubble id={id} />
                          <StartingSetup id={id} />
                          <StartingLine id={id} />
                          {line}
                          <SentBubbles id={id} />
                          <ArrivingBubbles list={arriving} />
                          <PendingSideLines source={id} />
                          <PendingModelLine id={id} />
                        </>
                      )
                    }
                  />
                  </RewindProvider>
                </SessionOfThread>
                )}
              </ThreadDrop>
              </DrawBoundary>
              {/* A follow-up waits for the start to land, never sent to a session Rust hasn't made [D30]. */}
              {!row?.archived && <SessionComposer key={id} onSent={(cid) => thread.current?.sent(cid)} id={id} row={row} offline={offline} placeholder={docked ? "Ask about this pull request" : undefined} blocked={starting && starting.outcome !== "delivered" ? "Starting…" : undefined} />}
            </div>
          )}
        </div>
  );
  if (docked) return body;
  return (
    <TabbedMain owner={id} archived={Boolean(row?.archived)}>
      {body}
    </TabbedMain>
  );
}

/** "Reconnecting · try 2 of 5 · next at 09:41", each part only where the agent's CLI said it [D74]. */
function retryWords(reason: unknown): string {
  const { attempt, max, at } = (reason ?? {}) as { attempt?: number | null; max?: number | null; at?: number | null };
  const tries = attempt ? ` · try ${attempt}${max ? ` of ${max}` : ""}` : "";
  return `Reconnecting${tries}${at && at > Date.now() ? ` · next at ${hhmm(at)}` : ""}`;
}

// View › Add project… and File › Open Folder… (⌘O) [D165].
listenToMenu();
// ⌘, opens Settings, ⌘/ its Keyboard shortcuts [D2013, D2022].
listenToSettingsKeys();
// The Review diff's engine loads at idle, so the first diff opened draws at once (the old app's warmCode).
void import("./review/diff-view").then((view) => view.warmReview());

// Dev-only component gallery (pnpm gallery); other builds drop it.
const Gallery = import.meta.env.MODE === "gallery" ? lazy(() => import("../gallery/gallery")) : null;
// `pnpm thread` builds the thread demo in place of the app.
const ThreadDemo = import.meta.env.VITE_SCREEN === "thread" ? lazy(() => import("./thread/demo").then(({ Demo }) => ({ default: Demo }))) : null;
const Screen = Gallery ?? ThreadDemo;
if (Screen) endLaunchScreen(true);
// A screen that never comes, as when the app throws, isn't left hidden under it.
setTimeout(endLaunchScreen, 10_000);

// The platform the window is drawn for, which the `win:` styles read [new-design].
if (window.brigadier) document.documentElement.dataset.platform = window.brigadier.platform;
// The browser's pages, under the app, and the agents' calls on them.
if (window.brigadier) {
  installTabLayer();
  installBrowserAgent();
}
installLinks();

createRoot(document.getElementById("root")!).render(
  <TooltipProvider>
    {Screen ? (
      <Suspense>
        <Screen />
      </Suspense>
    ) : (
      <>
        <DrawBoundary summary="This view couldn’t be shown" className="mx-auto w-full max-w-reading px-6 pt-8">
          <App />
        </DrawBoundary>
        <AddProjectHost />
        <GlobalSearch />
        <Toaster className="top-titlebar pt-2" />
        <ImageViewerHost />
        <PrDialogHost />
      </>
    )}
  </TooltipProvider>,
);
