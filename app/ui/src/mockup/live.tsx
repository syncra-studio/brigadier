// The Mockup tab on Rust's mockup (`mockup <wid>`, relay/mockup.rs): each variant's page live in its frame as batch 5's
// browser pages are [D2066], the chat row with Open, and the tab's busy icon [D2055, D560].
import { useEffect, useRef, useState, useSyncExternalStore } from "react";

import { showToast } from "../components/toast";
import { useThread } from "../daemon";
import { followLayout } from "../browser/follow";
import { showPage } from "../browser/hole";
import { type BrowserBounds, placePage } from "../browser/layer";
import { closeBrowserPage, openPage, useBrowserPage, zoomPage } from "../browser/pages";
import { daemonRun, failure } from "../session/composer";
import { CHAT, openTab, selectTab, type Tab } from "../shell/tab-store";
import type { Zoom } from "./frame";
import { type MockupActions, MockupView } from "./mockup";
import { busy, type Load, type Mockup } from "./model";
import { NO_NOTES, type Notes } from "./notes";
import { type MockupMoment, MockupRow, MockupTabIcon } from "./row";
import type { Send } from "./tray";

// shortcut: polled every 1.5 s while shown, as Rust pushes no mockup change; push it with the rows if the poll shows.
const POLL_MS = 1500;
/** Typing in the note for all variants saves once it pauses. */
const DRAFT_MS = 400;
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

/** The chat row's moment, from where the mockup is now; `ready`: the row of that round's every variant in. */
function momentOf(mockup: Mockup | null, count: number, ready?: number | null): MockupMoment {
  if (!mockup) return ready ? { kind: "ready", round: ready, open: false } : { kind: "drawing", count };
  if (mockup.picked && mockup.real) return { kind: "built", letter: mockup.picked };
  if (mockup.stopped) return { kind: "stopped" };
  if (mockup.picked) return mockup.building ? { kind: "picked", letter: mockup.picked } : { kind: "built", letter: mockup.picked };
  const open = mockup.rounds.length === (ready ?? mockup.rounds.length);
  if (ready) return { kind: "ready", round: ready, open };
  return busy(mockup) ? { kind: "drawing", count: mockup.count } : { kind: "ready", round: null, open: true };
}

/**
 * "Mockup · drawing 3 variants · Open" in the lead's chat, "Mockup · round 1 ready · pick one with Use, or leave a
 * note · Open" once its variants are in, or a send of the user's notes, "You → mockup · 3 notes on A and B · round 2
 * drawing"; Open brings its tab to the front.
 */
export function LiveMockupRow({ worker, count, on, round, ready }: { worker: string; count: number; on?: string[] | null; round?: number | null; ready?: number | null }) {
  const owner = useThread()?.id ?? "";
  const mockup = useMockup(worker);
  const moment: MockupMoment = round ? { kind: "notes", count, on: on ?? [], round } : momentOf(mockup, count, ready);
  return <MockupRow moment={moment} live={!round && !ready && busy(mockup)} onOpen={() => openTab(owner, "mockup", worker)} />;
}

// The news the user last saw in each Mockup tab, kept across restarts.
const SEEN_KEY = "mockup-seen";
const seenNews = (): Record<string, number> => JSON.parse(localStorage.getItem(SEEN_KEY) ?? "{}");

/** The Mockup tab's icon: the spinner while busy, else a blue dot while its news is unseen [D560]. */
export function LiveMockupTabIcon({ worker }: { worker: string }) {
  const mockup = useMockup(worker);
  return <MockupTabIcon busy={busy(mockup)} unread={(mockup?.news ?? 0) > (seenNews()[worker] ?? 0)} />;
}

/** Saves the notes still unsaved as the mockup's draft, once. */
function saveDraft(worker: string, unsaved: { current: Notes | null }) {
  const notes = unsaved.current;
  // Kept till saved: one that fails saves again with the next change or as the tab closes.
  if (notes)
    void daemonRun(["mockup", worker, "draft", JSON.stringify(notes)]).then((reply) => {
      if (reply.ok === true && unsaved.current === notes) unsaved.current = null;
    });
}

const boundsOf = (element: HTMLElement): BrowserBounds => {
  const rect = element.getBoundingClientRect();
  return { x: rect.left, y: rect.top, width: rect.width, height: rect.height };
};

/** The part of `a` inside `b`, or null when none is. */
function clip(a: BrowserBounds, b: BrowserBounds): BrowserBounds | null {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const width = Math.min(a.x + a.width, b.x + b.width) - x;
  const height = Math.min(a.y + a.height, b.y + b.height) - y;
  return width > 0 && height > 0 ? { x, y, width, height } : null;
}

/** One frame's live page, opened while its tab is in front and placed over its box as a Browser tab's is. */
function LivePage({ owner, tab, url, zoom, active, onLoad }: { owner: string; tab: string; url: string; zoom: Zoom; active: boolean; onLoad: (load: Load | null) => void }) {
  // Its own page each time it mounts: a frame coming in can't take the one going out's as already made.
  const [id] = useState(() => `${tab}-${crypto.randomUUID()}`);
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
      // The page is placed whole on the canvas, and shows only where the stage does.
      const stage = element.closest("[data-slot=mockup-stage]");
      const shown = bounds && stage ? clip(bounds, boundsOf(stage as HTMLElement)) : bounds;
      const key = JSON.stringify([bounds, shown]);
      if (key === placed) return;
      placed = key;
      placePage(id, bounds);
      showPage(id, shown);
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
  // The notes as Rust keeps them till changed here; each change goes back, so they survive closing the tab [D2055].
  const [changed, setChanged] = useState<Notes | null>(null);
  const notes = changed ?? mockup?.draft ?? NO_NOTES;
  const [send, setSend] = useState<Send>("idle");
  const unsaved = useRef<Notes | null>(null);
  // A send's id, the same on its retries till one goes through.
  const sendCid = useRef<string | null>(null);
  useEffect(() => {
    if (!changed) return;
    unsaved.current = changed;
    const timer = window.setTimeout(() => saveDraft(worker, unsaved), DRAFT_MS);
    return () => window.clearTimeout(timer);
  }, [worker, changed]);
  // A change still waiting to save when the tab closes saves then.
  useEffect(() => () => saveDraft(worker, unsaved), [worker]);
  // The tab in front sees its news: the icon's dot goes till the next.
  useEffect(() => {
    const news = mockup?.news ?? 0;
    if (!active || news <= (seenNews()[worker] ?? 0)) return;
    localStorage.setItem(SEEN_KEY, JSON.stringify({ ...seenNews(), [worker]: news }));
    listeners.forEach((l) => l());
  }, [active, worker, mockup?.news]);
  const [loads, setLoads] = useState<Record<string, Load>>({});
  // A frame's page by letter and address, so a new address loads anew; Retry bumps its try. A round shown remounts its frames.
  const [tries, setTries] = useState<Record<string, number>>({});
  const loaded = (key: string) => (load: Load | null) =>
    setLoads((now) => {
      const { [key]: _, ...rest } = now;
      return load ? { ...rest, [key]: load } : rest;
    });
  const actions: MockupActions = {
    // One message to the worker, steered into its turn [D300]; a failure keeps the notes for Retry.
    send: (shown) => {
      setSend("sending");
      const sent = notes;
      // The notes go with the send, not as a draft a closing tab would write back; a failed one keeps them.
      unsaved.current = null;
      sendCid.current ??= crypto.randomUUID();
      void daemonRun(["mockup", worker, "send", JSON.stringify({ ...sent, round: shown, cid: sendCid.current })]).then((reply) => {
        if (reply.ok !== true) {
          unsaved.current ??= sent;
          // A refused send never went: its retry is a new one.
          if (reply.error === "refused") sendCid.current = null;
          setSend("failed");
          showToast(failure(reply), { tone: "error" });
          return;
        }
        sendCid.current = null;
        setChanged(NO_NOTES);
        setSend("idle");
        poll(worker);
      });
    },
    // The pick goes to the worker to wire in, the unsent notes with it [D2068]; to the lead if the worker was stopped.
    use: (letter, shown) => {
      const sent = notes;
      unsaved.current = null;
      void daemonRun(["mockup", worker, "use", letter, JSON.stringify({ ...sent, round: shown })]).then((reply) => {
        if (reply.ok !== true) {
          unsaved.current ??= sent;
          return showToast(failure(reply), { tone: "error" });
        }
        setChanged(NO_NOTES);
        if (reply.message) showToast(String(reply.message));
        poll(worker);
      });
    },
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
      onNotes={setChanged}
      send={send}
      active={active}
      loads={loads}
      actions={actions}
      page={(key, url, zoom) => (
        <LivePage key={`${key}-${url}-${tries[key] ?? 0}`} owner={owner} tab={tab.id} url={url} zoom={zoom} active={active} onLoad={loaded(key)} />
      )}
    />
  );
}
