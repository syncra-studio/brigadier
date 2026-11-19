// The session's Mockup tab, the old app's redesigned as w13's direction 1 [D2055, D2066]: a header with the title,
// round pills, the variants' names (All · A · B · C), Point · Try and Fit; the named variants side by side, live; the
// notes tray; Use with its confirm; and Mockup · Compare · Real once the pick is built [D2069].
import { useEffect, useEffectEvent, useState } from "react";

import { Button } from "../components/button";
import { cx } from "../components/cx";
import { EmptyState } from "../components/empty-state";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "../components/menu";
import { type Choice, Segmented } from "../components/segmented";
import { Check, CheckCircle, ChevronDown, Spinner } from "../icons";
import { matches } from "../shortcuts";
import { type PageOf, VariantColumn, type Zoom } from "./frame";
import { drawn, type Load, type Mockup, slots, statusOf } from "./model";
import { type MockupNote, noteCount, type Notes } from "./notes";
import type { Hovered } from "./pins";
import { type Send, Tray } from "./tray";

/** The zoom menu's steps, and pinch or ⌘-scroll's bounds (the old tab's). */
const ZOOMS = [25, 50, 100, 150, 200] as const;
const MIN_ZOOM = 10;
const MAX_ZOOM = 400;

type Mode = "point" | "try";
type Compare = "mockup" | "compare" | "real";

const MODES: readonly Choice<Mode>[] = [
  { value: "point", label: "Point", tip: "Click anything to comment on it" },
  { value: "try", label: "Try", tip: "Clicks reach the page" },
];
const COMPARES: readonly Choice<Compare>[] = [
  { value: "mockup", label: "Mockup" },
  { value: "compare", label: "Compare" },
  { value: "real", label: "Real" },
];

/** Send and Use take the round shown, 1-based: the notes are on it, and the pick is its variant. */
export type MockupActions = {
  send: (round: number) => void;
  use: (letter: string, round: number) => void;
  /** Loads a frame's page again: a variant's letter, or "Real". */
  retry: (key: string) => void;
  askAgain: () => void;
  openReal: () => void;
  openReview: () => void;
};

/** Where the tab starts, for the gallery's states: the round, view, mode and the confirm. */
export type MockupStart = { round?: number; view?: string; mode?: Mode; compare?: Compare; confirm?: string; held?: boolean };

export function MockupView({
  mockup,
  notes,
  onNotes,
  send,
  active,
  page,
  actions,
  loads = {},
  hovers = {},
  start = {},
}: {
  mockup: Mockup | null;
  notes: Notes;
  onNotes: (notes: Notes) => void;
  send: Send;
  /** The tab is in front: only then do its keys work. */
  active: boolean;
  page: PageOf;
  actions: MockupActions;
  loads?: Record<string, Load>;
  hovers?: Record<string, Hovered>;
  start?: MockupStart;
}) {
  const newest = (mockup?.rounds.length ?? 1) - 1;
  // The newest round drawn: a later round draws while the one before stays up and takes notes.
  const last = mockup?.rounds[newest];
  const ready = newest > 0 && last && (last.drawing || !last.variants.length) ? newest - 1 : newest;
  // The round shown: null follows the newest drawn. A round drawn shows by itself unless notes wait, then "Show" [D2070].
  const [pinned, setPinned] = useState<number | null>(start.round ?? null);
  const [held, setHeld] = useState(start.held ?? false);
  // The newest drawn round when the tab last looked; when the tab opens, the round its unsent notes are on.
  const [seen, setSeen] = useState(-1);
  if (mockup && seen !== ready) {
    setSeen(ready);
    const from = seen >= 0 ? seen : (notes.round ?? ready + 1) - 1;
    if (pinned === null && noteCount(notes) > 0 && ready > from) {
      setPinned(from);
      setHeld(true);
    }
  }
  const shownRound = Math.min(pinned ?? ready, newest);
  const [view, setView] = useState(start.view ?? "all");
  const [mode, setMode] = useState<Mode>(start.mode ?? "point");
  const [zoom, setZoom] = useState<Zoom>("fit");
  const [compare, setCompare] = useState<Compare>(start.compare ?? "compare");
  const [confirm, setConfirm] = useState<string | null>(start.confirm ?? null);
  const [stage, setStage] = useState<HTMLDivElement | null>(null);

  const round = mockup?.rounds[shownRound];
  const variants = mockup && round ? slots(mockup, round) : [];
  // An older round only shows, its sent notes with it; one held for unsent notes still takes them.
  const older = shownRound < ready && !held;
  const working = Boolean(mockup && !mockup.real && !older);
  const takes = working && !confirm;
  const shown = view === "all" ? variants : variants.filter((v) => v.letter === view);
  const pins = older ? (round?.sent ?? []) : notes.pins;
  // Notes keep the round they're on, so the tab reopens on it.
  const note = (next: Notes) => onNotes({ ...next, round: shownRound + 1 });
  const changePins = (change: (pins: MockupNote[]) => MockupNote[]) => note({ ...notes, pins: change(notes.pins) });

  const showNewest = () => {
    setPinned(null);
    setHeld(false);
  };
  const build = () => {
    if (!confirm) return;
    actions.use(confirm, shownRound + 1);
    setConfirm(null);
  };
  const onKey = useEffectEvent((event: KeyboardEvent) => {
    const typing = event.target instanceof HTMLElement && event.target.closest("input, textarea, [contenteditable]");
    if (matches(event, "mockup-send")) {
      event.preventDefault();
      if (confirm) build();
      else if (working && !mockup?.stopped && noteCount(notes) && send !== "sending") actions.send(shownRound + 1);
    } else if (event.key === "Escape" && !typing) {
      if (confirm) setConfirm(null);
      else setMode("point");
    } else if ((event.key === "ArrowLeft" || event.key === "ArrowRight") && view !== "all" && !typing) {
      const at = variants.findIndex((v) => v.letter === view) + (event.key === "ArrowLeft" ? -1 : 1);
      const next = variants[(at + variants.length) % variants.length];
      if (next) setView(next.letter);
    }
  });
  useEffect(() => {
    if (!active) return;
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active]);
  // Pinch or ⌘-scroll zooms the frames (the old tab's).
  useEffect(() => {
    if (!stage) return;
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      setZoom((now) => Math.round(Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, (now === "fit" ? 100 : now) * Math.exp(-event.deltaY * 0.01)))));
    };
    stage.addEventListener("wheel", onWheel, { passive: false });
    return () => stage.removeEventListener("wheel", onWheel);
  }, [stage]);

  if (!mockup) {
    return <EmptyState variant="centered" as="div" title="No mockup in this session yet." detail="Ask for one, or the agent offers one for big UI changes." className="flex-1 bg-mockup-stage p-6" />;
  }
  if (mockup.stopped && !mockup.rounds.some((r) => r.variants.some(drawn))) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 bg-mockup-stage p-6 text-sm text-quiet-foreground">
        The mockup worker stopped before drawing anything.
        <Button variant="outline" size="sm" onClick={actions.askAgain}>
          Ask again
        </Button>
      </div>
    );
  }
  const status = statusOf(mockup);
  const picked = mockup.picked;
  const pickedRound = mockup.pickedRound ?? shownRound + 1;
  const pickedVariant = (mockup.pickedRound ? (mockup.rounds[pickedRound - 1]?.variants ?? []) : variants).find((v) => v.letter === picked);
  const firstWaiting = variants.find((v) => !drawn(v))?.letter;
  const drawnCount = variants.filter(drawn).length;
  const hint = !round?.drawing ? "Click anything to comment on it." : drawnCount ? `You can comment on ${variants.filter(drawn).map((v) => v.letter).join(", ")} now. Comments wait until you send them.` : null;
  const columns =
    mockup.real && pickedVariant
      ? [
          ...(compare !== "real" ? [{ variant: pickedVariant, label: `${picked} · Mockup`, why: `Round ${pickedRound} fixture` }] : []),
          ...(compare !== "mockup" ? [{ variant: { letter: "Real", name: "Real", url: mockup.real }, label: `${picked} · Real`, why: mockup.real.replace(/^https?:\/\//, "") }] : []),
        ]
      : shown.map((v) => ({ variant: v, label: v.name ? `${v.letter} · ${v.name}` : v.letter, why: v.why }));
  return (
    <section data-slot="mockup" aria-label={`Mockup: ${mockup.title}`} className="flex min-h-0 flex-1 flex-col bg-mockup-stage">
      <header className="flex h-panel-header shrink-0 items-center gap-2 border-b border-divider bg-background px-3 text-sm">
        <b className="min-w-0 truncate">{mockup.title}</b>
        <Segmented
          label="Rounds"
          value={String(shownRound)}
          options={mockup.rounds.map((_, i) => ({ value: String(i), label: `Round ${i + 1}` }))}
          onChange={(value) => (Number(value) === ready ? showNewest() : (setPinned(Number(value)), setHeld(false)))}
        />
        {held && shownRound < ready && !mockup.picked && (
          <Button variant="link-blue" size="inline" onClick={showNewest}>
            Round {ready + 1} ready · Show
          </Button>
        )}
        <span className="flex-1" />
        {status && (
          <span role="status" className={cx("flex shrink-0 items-center gap-1.5 text-xs", mockup.real ? "text-success" : "text-muted-foreground")}>
            {mockup.real ? <CheckCircle className="size-icon-sm" /> : mockup.stopped ? null : <Spinner className="size-icon-sm animate-spin motion-reduce:animate-none" />}
            {status}
          </span>
        )}
        {mockup.real ? (
          <Segmented label="Compare" value={compare} options={COMPARES} onChange={setCompare} />
        ) : (
          <>
            {variants.length > 1 && (
              <Segmented
                label="Variants"
                value={view}
                options={[{ value: "all", label: "All" }, ...variants.map((v) => ({ value: v.letter, label: v.letter, tip: v.name || undefined }))]}
                onChange={setView}
              />
            )}
            <Segmented label="Point or try" value={mode} options={MODES} onChange={setMode} />
            <ZoomMenu zoom={zoom} onChange={setZoom} />
          </>
        )}
      </header>
      <div ref={setStage} className="flex min-h-0 flex-1 gap-2.5 p-2.5">
        {columns.map(({ variant, label, why }) => (
          <VariantColumn
            // A new page or round starts the frame afresh, its screenshot fallback off.
            key={`${shownRound}:${variant.letter}:${variant.url ?? variant.shot ?? ""}`}
            variant={variant}
            label={label}
            why={why}
            drawing={Boolean(round?.drawing) && variant.letter === firstWaiting}
            load={loads[variant.letter]}
            zoom={zoom}
            page={page}
            notes={mockup.real ? [] : pins}
            pointing={takes && mode === "point"}
            hovered={hovers[variant.letter]}
            onNotes={takes && !older && send !== "sending" ? changePins : undefined}
            use={working && !mockup.building && !mockup.real && drawn(variant) ? { onClick: () => setConfirm(variant.letter), primary: confirm === variant.letter } : null}
            picked={!mockup.real && (confirm ?? picked) === variant.letter}
            dim={!mockup.real && Boolean(confirm ?? picked) && (confirm ?? picked) !== variant.letter}
            onName={view === "all" && !mockup.real && variants.length > 1 ? () => setView(variant.letter) : undefined}
            onRetry={() => actions.retry(variant.letter)}
          />
        ))}
      </div>
      <Tray
        notes={notes}
        onNotes={note}
        send={send}
        round={ready + 2}
        hint={hint}
        confirm={confirm ? { letter: confirm, others: variants.filter((v) => v.letter !== confirm && drawn(v)).map((v) => v.letter) } : null}
        stopped={mockup.stopped}
        older={older ? shownRound + 1 : null}
        built={mockup.real ? picked : null}
        answered={ready > 0 && shownRound === ready ? (mockup.rounds[ready - 1]?.sent.length ?? 0) : 0}
        onSend={() => actions.send(shownRound + 1)}
        onBuild={build}
        onCancel={() => setConfirm(null)}
        onNewest={showNewest}
        onEarlier={() => { setPinned(ready - 1); setHeld(false); }}
        onReal={actions.openReal}
        onReview={actions.openReview}
      />
    </section>
  );
}

/** Fit ⌄: the old tab's zoom menu, its steps and Zoom to fit. */
function ZoomMenu({ zoom, onChange }: { zoom: Zoom; onChange: (zoom: Zoom) => void }) {
  const row = (label: string, chosen: boolean, value: Zoom) => (
    <DropdownMenuItem key={label} onClick={() => onChange(value)}>
      <span className="flex-1">{label}</span>
      <Check className={cx("size-icon-sm", !chosen && "invisible")} />
    </DropdownMenuItem>
  );
  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button variant="ghost" size="xs" aria-label={zoom === "fit" ? "Zoom: fit" : `Zoom: ${zoom}%`} />}>
        <span className="tabular-nums">{zoom === "fit" ? "Fit" : `${zoom}%`}</span>
        <ChevronDown className="text-muted-foreground" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-mockup-menu">
        {ZOOMS.map((step) => row(`${step}%`, zoom === step, step))}
        <DropdownMenuSeparator />
        {row("Zoom to fit", zoom === "fit", "fit")}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
