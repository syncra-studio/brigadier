import { lazy, type ReactNode, Suspense, useEffect, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";

import { AccountsPage } from "./accounts/page";
import { SessionOfThread } from "./accounts/limit";
import { SidebarProvider, useSidebar } from "./components/sidebar";
import { WorkingLine } from "./components/thread/work";
import { Toaster } from "./components/toast";
import { TooltipProvider } from "./components/tooltip";
import { openThread, type Row, threadSource, useDaemon, useThread } from "./daemon";
import { intro, loadProfile, useProfile } from "./onboarding/api";
import { Onboarding } from "./onboarding/onboarding";
import { StartForm } from "./onboarding/start";
import { AddProjectHost } from "./projects/add-project";
import { listenToMenu } from "./projects/store";
import { ProjectSettingsHost } from "./projects/settings";
import { TrustHost } from "./projects/trust";
import { Demo } from "./session/Demo";
import { useSeen } from "./sidebar/seen";
import { AppSidebar, useStored } from "./sidebar/sidebar";
import { TerminalPane } from "./terminal/terminal";
import { Thread } from "./thread/thread";
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
  const { daemon, refused, rows } = useDaemon();
  const hash = useHash();
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
  if (hash.startsWith("#thread/")) {
    const id = decodeURIComponent(hash.slice("#thread/".length));
    return (
      <Shell hash={hash} active={id}>
        <SessionThread id={id} row={rows?.find((row) => row.id === id)} offline={daemon === null} />
      </Shell>
    );
  }
  return (
    <Shell hash={hash} active={null}>
      <Home />
    </Shell>
  );
}

// The sidebar beside every screen after onboarding [D173, D174]; open and width kept across launches.
function Shell({ hash, active, children }: { hash: string; active: string | null; children: ReactNode }) {
  const { daemon, rows, projects } = useDaemon();
  const [open, setOpen] = useStored("sidebar.open", true);
  const [width, setWidth] = useStored<number | null>("sidebar.width", null);
  useSeen(rows?.find((row) => row.id === active));
  return (
    <div className="fixed inset-0 bg-chrome">
      <SidebarProvider open={open} onOpenChange={setOpen} width={width} onWidthChange={setWidth} navigationKey={hash} className="ps-surface-inset pb-surface-inset">
        <AppSidebar
          rows={rows}
          projects={projects ?? []}
          active={active}
          home={active === null}
          offline={daemon === null}
          onOpen={(id) => (window.location.hash = `#thread/${encodeURIComponent(id)}`)}
          onNewSession={() => (window.location.hash = "")}
        />
        <div className="body-divider flex min-w-0 flex-1 flex-col pe-surface-inset">{children}</div>
      </SidebarProvider>
      {/* Past onboarding only, so it never asks there [D167]. */}
      <TrustHost active={active} />
      <ProjectSettingsHost />
    </div>
  );
}

// The window's top beside the sidebar; collapsed, it keeps clear of the traffic lights.
function Titlebar({ children }: { children?: ReactNode }) {
  const { open } = useSidebar();
  return (
    <header className="flex h-titlebar shrink-0 items-center gap-3 px-3 text-sm">
      {!open && <div className="app-drag h-full w-traffic-lights shrink-0" />}
      <span className="app-drag flex h-full min-w-0 flex-1 items-center truncate">{children}</span>
    </header>
  );
}

// Home is a new session: the Start form.
function Home() {
  const { daemon, refused } = useDaemon();
  return (
    <>
      <Titlebar />
      <main className="flex min-h-0 flex-1 flex-col items-center gap-2 overflow-y-auto rounded-e-surface bg-background pt-titlebar">
        <h1 className="font-display text-hero font-semibold">Brigadier</h1>
        {daemon && (
          <p className="text-sm text-muted-foreground">
            Daemon connected · pid {daemon.pid} · version {daemon.version}
          </p>
        )}
        {daemon === null && <p className="text-sm text-destructive">{refused ?? "Daemon not reachable · reconnecting…"}</p>}
        <a href="#states" className="text-sm text-muted-foreground hover:text-foreground">
          Session states
        </a>
        <a href="#accounts" className="text-sm text-muted-foreground hover:text-foreground">
          Accounts
        </a>
        <StartForm />
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
// Its terminal sits beside it, on the same conversation [D47].
function SessionThread({ id, row, offline }: { id: string; row: Row | undefined; offline: boolean }) {
  const title = row?.title;
  useEffect(() => openThread(id), [id]);
  const state = useThread();
  return (
    <>
      <Titlebar>{title || id}</Titlebar>
      <main className="flex min-h-0 flex-1 flex-col overflow-clip rounded-e-surface bg-background">
        {offline && <p className="text-center text-sm text-muted-foreground">Daemon not reachable · reconnecting…</p>}
        <div className="flex min-h-0 flex-1">
          {state?.status === "missing" ? (
            <p className="flex flex-1 items-center justify-center text-sm text-muted-foreground">Session not found</p>
          ) : state?.status === "error" ? (
            <p className="flex flex-1 items-center justify-center text-sm text-destructive">{state.error}</p>
          ) : (
            <div className={`min-h-0 min-w-0 flex-1 ${offline ? "opacity-disabled" : ""}`}>
              <SessionOfThread value={{ id, offline }}>
                <Thread
                  source={threadSource}
                  footer={
                    row?.state === "interrupted" ? <WorkingLine state="interrupted">Interrupted · the run stopped before it finished</WorkingLine> :
                    row?.state === "stalled" && <WorkingLine state="stalled">Stalled · no output from the agent for a while</WorkingLine>
                  }
                />
              </SessionOfThread>
            </div>
          )}
          {state?.status !== "missing" && <TerminalPane id={id} />}
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
        <Toaster className="top-titlebar" />
      </>
    )}
  </TooltipProvider>,
);
