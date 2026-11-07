// Dev-only: every kit component in every state (D2). Opened by `pnpm gallery`.
import { type RefObject, useEffect, useRef } from "react";

import { Kit } from "./kit";
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
  return <iframe ref={frame} src="/" title="Components" className="fixed inset-0 size-full" />;
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
    <div ref={scroller} className="fixed inset-0 overflow-y-auto">
      <header className="app-drag sticky top-0 z-10 flex h-titlebar items-center border-b border-divider bg-background ps-traffic-lights">
        <h1 className="ps-2 text-sm font-medium">Components</h1>
      </header>
      <main className="isolate flex flex-col gap-10 px-8 py-8">
        <Kit />
      </main>
    </div>
  );
}
