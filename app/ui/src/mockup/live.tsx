// The Mockup tab on Rust's mockup (`mockup <wid>`, relay/mockup.rs): each variant's page live in its frame as batch 5's
// browser pages are [D2066], the chat row with Open, and the tab's busy icon [D2055, D560].
import { useEffect, useRef, useState, useSyncExternalStore } from "react";

import { showToast } from "../components/toast";
import { useThread } from "../daemon";
import { followLayout } from "../browser/follow";
import { showPage } from "../browser/hole";
import { type BrowserBounds, placePage } from "../browser/layer";
import { closeBrowserPage, openPage, useBrowserPage, zoomPage } from "../browser/pages";
import { daemonRun } from "../session/composer";
import { CHAT, openTab, selectTab, type Tab } from "../shell/tab-store";
import type { Zoom } from "./frame";
import { type MockupActions, MockupView } from "./mockup";
import { busy, type Load, type Mockup } from "./model";
import { NO_NOTES, type Notes } from "./notes";
import { type MockupMoment, MockupRow, MockupTabIcon } from "./row";

// shortcut: polled every 1.5 s while shown, as Rust pushes no mockup change; push it with the rows if the poll shows.
const POLL_MS = 1500;
const mockups = new Map<string, Mockup | null>();
const watchers = new Map<string, { n: number; timer: number }>();
const listeners = new Set<() => void>();

function poll(wid: string) {
  void daemonRun(["mockup", wid]).then((reply) => {
    const next = reply.ok === false ? null : (reply as Mockup);
    if (JSON.stringify(next) === JSON.stringify(mockups.get(wid))) return;
    mockups.set(wid, next);
    listeners.forEach((l) => l());
  });
}

function watch(wid: string) {
  const w = watchers.get(wid);
  if (w) w.n += 1;
  else {
    poll(wid);
    watchers.set(wid, { n: 1, timer: window.setInterval(() => poll(wid), POLL_MS) });
  }
  return () => {
    const now = watchers.get(wid);
    if (now && --now.n === 0) {
      window.clearInterval(now.timer);
      watchers.delete(wid);
    }
  };
}

/** Worker `wid`'s mockup as Rust has it now; null till read, or when there is none. */
export function useMockup(wid: string): Mockup | null {
  useEffect(() => (wid ? watch(wid) : undefined), [wid]);
  return useSyncExternalStore(
    (l) => (listeners.add(l), () => listeners.delete(l)),
    () => mockups.get(wid) ?? null,
  );
}

/** The chat row's moment, from where the mockup is now. */
function momentOf(mockup: Mockup | null, count: number): MockupMoment {
  if (!mockup) return { kind: "drawing", count };
  if (mockup.picked && mockup.real) return { kind: "built", letter: mockup.picked };
  if (mockup.stopped) return { kind: "stopped" };
  if (mockup.picked) return { kind: "picked", letter: mockup.picked };
  return busy(mockup) ? { kind: "drawing", count: mockup.count } : { kind: "waiting" };
}

/** "Mockup · drawing 3 variants · Open" in the lead's chat; Open brings its tab to the front. */
export function LiveMockupRow({ worker, count }: { worker: string; count: number }) {
  const owner = useThread()?.id ?? "";
  const mockup = useMockup(worker);
  return <MockupRow moment={momentOf(mockup, count)} live={busy(mockup)} onOpen={() => openTab(owner, "mockup", worker)} />;
}

export function LiveMockupTabIcon({ worker }: { worker: string }) {
  return <MockupTabIcon busy={busy(useMockup(worker))} />;
}

const boundsOf = (element: HTMLElement): BrowserBounds => {
  const rect = element.getBoundingClientRect();
  return { x: rect.left, y: rect.top, width: rect.width, height: rect.height };
};

/** One frame's live page, opened while its tab is in front and placed over its box as a Browser tab's is. */
function LivePage({ owner, id, url, zoom, active, onLoad }: { owner: string; id: string; url: string; zoom: Zoom; active: boolean; onLoad: (load: Load | null) => void }) {
  const box = useRef<HTMLDivElement>(null);
  const page = useBrowserPage(id);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!active || page || failed || !box.current) return;
    openPage(owner, id, url, boundsOf(box.current)).catch(() => setFailed(true));
  }, [owner, id, url, active, page, failed]);
  useEffect(() => () => closeBrowserPage(id), [id]);
  useEffect(() => onLoad(failed || page?.failed ? "failed" : !page?.ready || page.loading ? "loading" : null), [failed, page?.failed, page?.ready, page?.loading]);
  useEffect(() => {
    if (page?.ready) zoomPage(id, zoom === "fit" ? 1 : zoom / 100);
  }, [id, zoom, page?.ready]);
  useEffect(() => {
    const element = box.current;
    if (!page?.ready || !element || !active) return;
    let placed = "";
    const place = () => {
      const rect = boundsOf(element);
      const bounds = !element.closest("[inert]") && rect.width > 0 && rect.height > 0 ? rect : null;
      const key = JSON.stringify(bounds);
      if (key === placed) return;
      placed = key;
      placePage(id, bounds);
      showPage(id, bounds);
    };
    const stop = followLayout(() => [element], place);
    return () => {
      stop();
      placePage(id, null);
      showPage(id, null);
    };
  }, [id, page?.ready, active]);
  return <div ref={box} className="size-full" />;
}

/** The Mockup tab of `owner`'s tabs, on its mockup worker's mockup. */
export function MockupTab({ owner, tab, active }: { owner: string; tab: Tab; active: boolean }) {
  const worker = tab.target ?? "";
  const mockup = useMockup(worker);
  const [notes, setNotes] = useState<Notes>(NO_NOTES);
  const [loads, setLoads] = useState<Record<string, Load>>({});
  // A frame's page by round, letter and address, so a new round or address loads anew; Retry bumps its try.
  const [tries, setTries] = useState<Record<string, number>>({});
  const round = mockup?.rounds.length ?? 0;
  const loaded = (key: string) => (load: Load | null) =>
    setLoads((now) => {
      const { [key]: _, ...rest } = now;
      return load ? { ...rest, [key]: load } : rest;
    });
  const actions: MockupActions = {
    send: () => showToast("Sending notes comes next", { tone: "error" }),
    use: () => showToast("Use comes next", { tone: "error" }),
    retry: (key) => {
      loaded(key)(null);
      setTries((now) => ({ ...now, [key]: (now[key] ?? 0) + 1 }));
    },
    askAgain: () => selectTab(owner, CHAT),
    openReal: () => mockup?.real && openTab(owner, "browser", mockup.real),
    openReview: () => openTab(owner, "review"),
  };
  return (
    <MockupView
      mockup={mockup}
      notes={notes}
      onNotes={setNotes}
      send="idle"
      active={active}
      loads={loads}
      actions={actions}
      page={(key, url, zoom) => (
        <LivePage key={`${round}-${key}-${url}-${tries[key] ?? 0}`} owner={owner} id={`${tab.id}-${round}-${key}-${tries[key] ?? 0}`} url={url} zoom={zoom} active={active} onLoad={loaded(key)} />
      )}
    />
  );
}
