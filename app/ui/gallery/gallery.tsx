// Dev-only: every kit component in every state (D2). Opened by `pnpm gallery`.
import { type RefObject, useEffect, useRef } from "react";

import { CardGallery } from "./card";
import { ChangesGallery } from "./changes";
import { Choices } from "./choices";
import { PullRequestsGallery } from "./pull-requests";
import { Contents } from "./contents";
import { ComposerGallery } from "./composer";
import { RailGallery } from "./rail";
import { TabsGallery } from "./tabs";
import { AidsGallery } from "./aids";
import { DecisionsGallery } from "./decisions";
import { FilesGallery } from "./files";
import { RewindGallery } from "./rewind";
import { ForkGallery } from "./fork";
import { FindGallery } from "./find";
import { HomeGallery } from "./home";
import { PickersGallery } from "./pickers";
import { Kit } from "./kit";
import { Notices } from "./notices";
import { PaletteGallery } from "./palette";
import { Panes } from "./panes";
import { Area } from "./parts";
import { Popups } from "./popups";
import { ArchiveGallery } from "./archive";
import { ProjectSettingsGallery } from "./project-settings";
import { ProjectsGallery } from "./projects";
import { ReviewGallery } from "./review";
import { SessionGallery } from "./session";
import { SidebarGallery } from "./sidebar";
import { Thread } from "./thread";
import { RightPanelGallery } from "./right-panel";
import { CommitGallery } from "./commit";
import { BranchGallery } from "./branch";
import "./gallery.css";

const SCROLL_KEY = "gallery-scroll";

// The build's stamp (vite.config.mts), or nothing while a rebuild is writing.
function buildStamp(): Promise<number | undefined> {
  return import(/* @vite-ignore */ `/build-id.js?${Date.now()}`).then(
    (stamp: { default: number }) => stamp.default,
    () => undefined,
  );
}

/**
 * The window holds the gallery in a frame and reloads the frame when `pnpm gallery` finishes a new build
 * (D23): the app refuses to reload or navigate its window itself.
 */
function LiveFrame() {
  const frame = useRef<HTMLIFrameElement>(null);
  useEffect(() => {
    let loaded: number | undefined;
    const timer = setInterval(async () => {
      const stamp = await buildStamp();
      if (stamp === undefined) return;
      loaded ??= stamp;
      if (stamp === loaded) return;
      loaded = stamp;
      frame.current!.contentWindow!.location.reload();
    }, 500);
    return () => clearInterval(timer);
  }, []);
  return (
    <>
      <iframe ref={frame} src="/" title="Components" className="fixed inset-0 size-full" />
      {/* The window drags only by regions in its top frame, so this strip lies over the frame's header. */}
      <div className="app-drag fixed inset-x-0 top-0 h-titlebar" />
    </>
  );
}

export default function Gallery() {
  return window.top === window ? <LiveFrame /> : <GalleryPage />;
}

/** Keeps the scroll place across the frame's reloads. */
function useKeptScroll(scroller: RefObject<HTMLDivElement | null>) {
  useEffect(() => {
    const box = scroller.current!;
    box.scrollTop = Number(sessionStorage.getItem(SCROLL_KEY));
    const keep = () => sessionStorage.setItem(SCROLL_KEY, String(box.scrollTop));
    addEventListener("pagehide", keep);
    return () => removeEventListener("pagehide", keep);
  }, [scroller]);
}

function GalleryPage() {
  const scroller = useRef<HTMLDivElement>(null);
  useKeptScroll(scroller);
  return (
    <div className="fixed inset-0 flex flex-col">
      <header className="app-drag flex h-titlebar shrink-0 items-center border-b border-divider bg-background ps-traffic-lights">
        <h1 className="ps-2 text-sm font-medium">Components</h1>
      </header>
      <div className="flex min-h-0 flex-1">
        <Contents scroller={scroller} />
        <div ref={scroller} className="min-w-0 flex-1 overflow-y-auto">
          <main className="isolate flex flex-col gap-16 px-8 py-8">
            <Area name="Screens">
              <HomeGallery />
              <ProjectsGallery />
              <ProjectSettingsGallery />
              <ArchiveGallery />
              <SidebarGallery />
              <PaletteGallery />
              <SessionGallery />
            </Area>
            <Area name="Composer">
              <ComposerGallery />
              <RailGallery />
              <AidsGallery />
              <PickersGallery />
              <DecisionsGallery />
            </Area>
            <Area name="Thread">
              <Thread />
              <RewindGallery />
              <ForkGallery />
              <FindGallery />
              <Notices />
              <ChangesGallery />
            </Area>
            <Area name="Controls">
              <Kit />
              <Choices />
            </Area>
            <Area name="Popups and status">
              <Popups />
            </Area>
            <Area name="Review">
              <ReviewGallery />
            </Area>
            <Area name="Layout">
              <TabsGallery />
              <Panes />
              <FilesGallery />
            </Area>
            <Area name="Landing the work">
              <PullRequestsGallery />
            </Area>
            <Area name="Right panel">
              <RightPanelGallery />
              <CardGallery />
              <CommitGallery />
              <BranchGallery />
            </Area>
          </main>
        </div>
      </div>
    </div>
  );
}
