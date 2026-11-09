import { lazy, type ReactNode, Suspense, useEffect, useLayoutEffect, useRef, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";

import { AccountsPage } from "./accounts/page";
import { SessionOfThread } from "./accounts/limit";
import { SidebarProvider } from "./components/sidebar";
import { WorkingLine } from "./components/thread/work";
import { Toaster } from "./components/toast";
import { TooltipProvider } from "./components/tooltip";
import { openThread, type Row, useDaemon, useThread } from "./daemon";
import { HomeDraft, StartingBubble, StartingThread, useStartShown } from "./home/home";
import { newSession, useStart, useStartingRows } from "./home/start";
import { Key } from "./icons";
import { intro, loadProfile, useProfile } from "./onboarding/api";
import { Onboarding } from "./onboarding/onboarding";
import { GlobalSearch } from "./palette/palette";
import { AddProjectHost } from "./projects/add-project";
import { listenToMenu } from "./projects/store";
import { FeedbackDialog } from "./feedback/dialog";
import { ProjectSettingsHost } from "./projects/settings";
import { TrustHost } from "./projects/trust";
import { ArchivedBar } from "./sessions/archived";
import { Demo } from "./session/Demo";
import { SentBubbles, SessionComposer, useSending } from "./session/composer";
import { answeringSource } from "./session/decisions";
import { PendingSideLines, useSidePending } from "./session/side";
import { Titlebar, TitlebarNav } from "./shell/titlebar";
import { useShown } from "./sidebar/actions";
import { useSeen } from "./sidebar/seen";
import { SidebarFoot } from "./sidebar/foot";
import { AppSidebar, useStored } from "./sidebar/sidebar";
import { Thread, type ThreadHandle } from "./thread/thread";
import "./theme.css";

// A hash change is in-page, so Electron's will-navigate guard lets it through.
const onHash = (listener: () => void) => {
  window.addEventListener("hashchange", listener);
  return () => window.removeEventListener("hashchange", listener);
};
const useHash = (): string => useSyncExternalStore(onHash, () => window.location.hash);

// The screen that was open comes back when the app reopens.
if (!window.location.hash) window.location.hash = localStorage.getItem("route") ?? "";
window.addEventListener("hashchange", () => localStorage.setItem("route", window.location.hash));

function App() {
  const { daemon, refused } = useDaemon();
  const hash = useHash();
  const open = hash.startsWith("#thread/") ? decodeURIComponent(hash.slice("#thread/".length)) : null;
  // Rust's rows, with the sessions Home is still starting [D30].
  const rows = useStartingRows(open);
  // File › New Session (⌘N): Home in the open session's project [D184].
  useEffect(() => window.brigadier?.onMenu((command) => command === "new-session" && newSession(rows?.find((row) => row.id === open)?.project)), [rows, open]);
  const profile = useProfile();
  // The profile says whether this is the first launch: asked again on each reconnect until known.
  useEffect(() => {
    if (daemon && !profile.value) loadProfile();
  }, [daemon, profile.value]);
  // A window held clear for the first launch's intro (main's intro.ts) shows at once when there's none.
  const playsIntro = profile.value && !profile.value.onboarded && !profile.value.intro_seen && hash !== "#states";
  const knownNot = playsIntro === false || hash === "#states" || Boolean(refused || profile.error);
  useEffect(() => {
    if (knownNot) void intro.release()?.catch((error: unknown) => console.error(error));
  }, [knownNot]);
  if (hash === "#states") return <Demo />;
  if (!profile.value) return <FirstLoad error={daemon === null ? (refused ?? "Daemon not reachable · reconnecting…") : profile.error} />;
  if (!profile.value.onboarded) return <Onboarding profile={profile.value} />;
  if (hash === "#accounts") return <AccountsPage />;
  if (open !== null) {
    return (
      <Shell hash={hash} active={open} rows={rows}>
        <SessionThread id={open} rows={rows} offline={daemon === null} />
      </Shell>
    );
  }
  return (
    <Shell hash={hash} active={null} rows={rows}>
      <Home offline={daemon === null} />
    </Shell>
  );
}

// The sidebar beside every screen after onboarding [D173, D174]; open and width kept across launches.
function Shell({ hash, active, rows, children }: { hash: string; active: string | null; rows: Row[] | undefined; children: ReactNode }) {
  const { daemon, projects } = useDaemon();
  const [open, setOpen] = useStored("sidebar.open", true);
  const [width, setWidth] = useStored<number | null>("sidebar.width", null);
  useSeen(rows?.find((row) => row.id === active));
  return (
    <div className="fixed inset-0 bg-chrome">
      {/* The page's soft edge, around the sidebar and the content, which paint their own rounded halves. */}
      <div aria-hidden className="pointer-events-none absolute start-surface-inset end-surface-inset top-titlebar bottom-surface-inset rounded-surface shadow-raised" />
      <SidebarProvider open={open} onOpenChange={setOpen} width={width} onWidthChange={setWidth} navigationKey={hash} className="ps-surface-inset pb-surface-inset">
        <AppSidebar
          rows={rows}
          projects={projects ?? []}
          active={active}
          home={active === null}
          offline={daemon === null}
          onOpen={(id) => (window.location.hash = `#thread/${encodeURIComponent(id)}`)}
          // ⌘N's too: Home in the open session's project [D184].
          onNewSession={() => newSession(rows?.find((row) => row.id === active)?.project)}
          foot={(archived) => <SidebarFoot archived={archived} />}
        />
        <div className="body-divider flex min-w-0 flex-1 flex-col pe-surface-inset">{children}</div>
        <TitlebarNav active={active} rows={rows} />
      </SidebarProvider>
      {/* Past onboarding only, so it never asks there [D167]. */}
      <TrustHost active={active} />
      <ProjectSettingsHost />
      <FeedbackDialog />
    </div>
  );
}

// Home is a new session's draft [D161].
function Home({ offline }: { offline: boolean }) {
  return (
    <>
      <Titlebar offline={offline} />
      <main className="flex min-h-0 flex-1 flex-col overflow-clip rounded-e-surface bg-background">
        <HomeDraft />
      </main>
    </>
  );
}

// Before the profile is known: a blank window that drags, or why it can't load.
function FirstLoad({ error }: { error?: string }) {
  return (
    <main className="app-drag fixed inset-0 flex items-center justify-center">
      <p className={error ? "text-sm text-destructive" : "text-sm text-muted-foreground"}>{error ?? "Loading…"}</p>
    </main>
  );
}

// One session's thread, straight from Rust's fold [D64, D65]; the view draws it, with no folding here.
function SessionThread({ id, rows, offline }: { id: string; rows: Row[] | undefined; offline: boolean }) {
  const row = rows?.find((each) => each.id === id);
  // The title bar shows a rename or an archive at once [D30].
  const titled = useShown(rows)?.find((each) => each.id === id);
  const thread = useRef<ThreadHandle>(null);
  // Before the paint, and the Thread waits for it below: a new one never starts on the last session's rows.
  useLayoutEffect(() => openThread(id), [id]);
  const state = useThread();
  const sending = useSending(id);
  const sides = useSidePending(id);
  const line =
    row?.state === "interrupted" ? <WorkingLine state="interrupted">Interrupted · the run stopped before it finished</WorkingLine> :
    row?.state === "stalled" && <WorkingLine state="stalled">Stalled · no output from the agent for a while</WorkingLine>;
  // Started from Home and not made yet: "not found" means "not yet" [D30].
  const starting = useStart(id);
  const missing = state?.status === "missing" && !starting;
  const shown = useStartShown(id);
  return (
    <>
      <Titlebar offline={offline} row={titled} />
      <main className="flex min-h-0 flex-1 flex-col overflow-clip rounded-e-surface bg-background">
        <div className="flex min-h-0 flex-1">
          {missing ? (
            <p className="flex flex-1 items-center justify-center text-sm text-muted-foreground">Session not found</p>
          ) : state?.status === "error" ? (
            <p className="flex flex-1 items-center justify-center text-sm text-destructive">{state.error}</p>
          ) : (
            <div className={`flex min-h-0 min-w-0 flex-1 flex-col ${offline ? "opacity-disabled" : ""}`}>
              <div className="min-h-0 flex-1">
                {shown ? (
                  <StartingThread id={id} />
                ) : state?.id === id && (
                <SessionOfThread value={{ id, offline }}>
                  <Thread
                    key={id}
                    ref={thread}
                    source={answeringSource}
                    footer={
                      // Read-only while archived: its bar restores it [D180, D198].
                      row?.archived ? <ArchivedBar row={row} /> : (line || sending || starting || sides) && (
                        <>
                          <StartingBubble id={id} />
                          {line}
                          <SentBubbles id={id} />
                          <PendingSideLines source={id} />
                        </>
                      )
                    }
                  />
                </SessionOfThread>
                )}
              </div>
              {/* A follow-up waits for the start to land, never sent to a session Rust hasn't made [D30]. */}
              {!row?.archived && <SessionComposer key={id} onSent={(cid) => thread.current?.sent(cid)} id={id} row={row} offline={offline} blocked={starting && starting.outcome !== "delivered" ? "Starting…" : undefined} />}
            </div>
          )}
        </div>
      </main>
    </>
  );
}

// View › Add project… and File › Open Folder… (⌘O) [D165].
listenToMenu();

// Dev-only component gallery (pnpm gallery); other builds drop it.
const Gallery = import.meta.env.MODE === "gallery" ? lazy(() => import("../gallery/gallery")) : null;
// `pnpm thread` builds the thread demo in place of the app.
const ThreadDemo = import.meta.env.VITE_SCREEN === "thread" ? lazy(() => import("./thread/demo").then(({ Demo }) => ({ default: Demo }))) : null;
const Screen = Gallery ?? ThreadDemo;

createRoot(document.getElementById("root")!).render(
  <TooltipProvider>
    {Screen ? (
      <Suspense>
        <Screen />
      </Suspense>
    ) : (
      <>
        <App />
        <AddProjectHost />
        <GlobalSearch />
        <Toaster className="top-titlebar" />
      </>
    )}
  </TooltipProvider>,
);
