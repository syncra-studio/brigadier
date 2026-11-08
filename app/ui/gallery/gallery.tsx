// Dev-only: every kit component in every state (D2). Opened by `pnpm gallery`.
import { type RefObject, useEffect, useRef } from "react";

import { Choices } from "./choices";
import { ComposerGallery } from "./composer";
import { RailGallery } from "./rail";
import { AidsGallery } from "./aids";
import { DecisionsGallery } from "./decisions";
import { PickersGallery } from "./pickers";
import { Kit } from "./kit";
import { Notices } from "./notices";
import { Panes } from "./panes";
import { Popups } from "./popups";
import { ProjectsGallery } from "./projects";
import { Thread } from "./thread";
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

/**
 * A held-open menu or select takes focus as it mounts (and again later); give it back unless the user
 * just clicked or typed, so the page rests as the app does and the sidebar's peek isn't held off.
 */
function useNoHeldFocus() {
  useEffect(() => {
    let actedAt = -Infinity;
    const acted = () => (actedAt = performance.now());
    const onFocus = (event: FocusEvent) => {
      const target = event.target as HTMLElement;
      if (performance.now() - actedAt > 500 && target.closest?.("[data-held]")) target.blur();
    };
    addEventListener("pointerdown", acted, true);
    addEventListener("keydown", acted, true);
    addEventListener("focusin", onFocus, true);
    if ((document.activeElement as HTMLElement | null)?.closest("[data-held]")) (document.activeElement as HTMLElement).blur();
    return () => {
      removeEventListener("pointerdown", acted, true);
      removeEventListener("keydown", acted, true);
      removeEventListener("focusin", onFocus, true);
    };
  }, []);
}

function GalleryPage() {
  const scroller = useRef<HTMLDivElement>(null);
  useKeptScroll(scroller);
  useNoHeldFocus();
  return (
    <div ref={scroller} className="fixed inset-0 overflow-y-auto">
      <header className="app-drag sticky top-0 z-10 flex h-titlebar items-center border-b border-divider bg-background ps-traffic-lights">
        <h1 className="ps-2 text-sm font-medium">Components</h1>
      </header>
      <main className="isolate flex flex-col gap-10 px-8 py-8">
        <ProjectsGallery />
        <ComposerGallery />
        <RailGallery />
        <AidsGallery />
        <PickersGallery />
        <DecisionsGallery />
        <Thread />
        <Notices />
        <Choices />
        <Panes />
        <Popups />
        <Kit />
      </main>
    </div>
  );
}
