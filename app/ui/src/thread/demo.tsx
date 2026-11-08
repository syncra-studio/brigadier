// The thread on fake data: `pnpm thread`. Pick a size, stream replies, jump around.
import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";

import { WorkingLine } from "../components/thread/work";
import { FakeThread } from "./fake";
import { Thread, type ThreadHandle } from "./thread";

const SIZES = [1_000, 10_000, 100_000];
/** The bench's fast scroll: 1,500 px a frame (about 90,000 px/s), far past a trackpad flick. */
const FLING_PX = 1_500;
const FLING_MS = 2_000;

/** Scrolls up, then back down, at the bench's speed, to show the rows that aren't drawn in time. */
function fling(handle: ThreadHandle) {
  const start = performance.now();
  const step = (now: number) => {
    const elapsed = now - start;
    if (elapsed > 2 * FLING_MS) return;
    handle.scrollBy(elapsed < FLING_MS ? -FLING_PX : FLING_PX);
    requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

export function Demo() {
  const [size, setSize] = useState(10_000);
  const [huge, setHuge] = useState(false);
  const [streaming, setStreaming] = useState(true);
  const thread = useRef<ThreadHandle>(null);
  const store = useMemo(() => new FakeThread(size, 1, huge), [size, huge]);
  useEffect(() => (streaming ? store.stream() : undefined), [store, streaming]);
  const running = useSyncExternalStore(store.subscribe, () => store.get().turns.at(-1)?.status === "running");
  return (
    <main className="fixed inset-0 flex flex-col">
      {/* Buttons in a drag region don't take clicks, so only the empty parts drag. */}
      <header className="flex h-titlebar shrink-0 items-center gap-1 text-sm">
        <div className="app-drag h-full w-traffic-lights shrink-0" />
        {SIZES.map((each) => (
          <Toggle key={each} on={size === each} onClick={() => setSize(each)}>
            {each.toLocaleString()} items
          </Toggle>
        ))}
        <Toggle on={huge} onClick={() => setHuge(!huge)}>
          Huge outputs
        </Toggle>
        <Toggle on={streaming} onClick={() => setStreaming(!streaming)}>
          Streaming
        </Toggle>
        <Toggle onClick={() => thread.current?.toIndex(Math.floor(store.get().items.length * 0.05))}>Jump far up</Toggle>
        <Toggle onClick={() => thread.current?.toBottom()}>Jump to bottom</Toggle>
        <Toggle onClick={() => thread.current && fling(thread.current)}>Fling</Toggle>
        <div className="app-drag h-full flex-1" />
      </header>
      <div className="min-h-0 flex-1">
        <Thread key={`${size}:${huge}`} source={store} ref={thread} footer={running ? <Working store={store} /> : null} />
      </div>
      <div className="mx-auto w-full max-w-reading shrink-0 px-6 pb-4">
        <textarea
          aria-label="Message"
          placeholder="Type here while it streams"
          className="w-full resize-none rounded-overlay bg-card px-4 py-3 text-base shadow-raised outline-none"
          rows={2}
        />
      </div>
    </main>
  );
}

/** The running turn's working line, only while no row above is live (one live sign at a time, as the old app). */
function Working({ store }: { store: FakeThread }) {
  const quiet = useSyncExternalStore(store.subscribe, () => {
    const item = store.get().items.at(-1);
    if (item?.kind === "message" || item?.kind === "reasoning") return !item.streaming;
    if (item?.kind === "tool") return item.progress !== "running";
    return true;
  });
  return quiet ? <WorkingLine state="live">Thinking</WorkingLine> : null;
}

function Toggle({ on, onClick, children }: { on?: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`h-control-sm rounded-control px-2.5 ${on ? "bg-muted text-foreground" : "text-muted-foreground hover:text-foreground"}`}
    >
      {children}
    </button>
  );
}
