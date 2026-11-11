// Workers, drawn on fake data, as the old app had them [D3010, D3012, D3013]: the chip, the sentences and rows in
// the parent's thread, the strip above the composer, the right panel's Workers tab and a worker's view.
import { type ReactNode, useState } from "react";

import { ComposerCard } from "../src/components/composer/composer";
import { ComposerRail } from "../src/components/composer/rail";
import { TooltipIconButton } from "../src/components/icon-button";
import { Body } from "../src/components/thread/body";
import { TitlebarTips } from "../src/components/tooltip";
import { X } from "../src/icons";
import { WorkerGlyph } from "../src/icons/worker-glyphs";
import type { Item, Turn } from "../src/thread/item";
import { type Worker, WorkerChip, WorkerName, WorkersPanel } from "../src/workers/chip";
import { PanelTabs, WORKERS_LABEL, WorkerList } from "../src/workers/list";
import { StillRunningRow, TeamSentence, TeamStepRow } from "../src/workers/sentence";
import { WorkersStrip } from "../src/workers/strip";
import { WorkerHeader, WorkerThread } from "../src/workers/view";
import { Row, Section, State } from "./parts";

const NOW = Date.now();
const noop = () => {};

const BRIEF =
  "Target src/upload/retry.rs\n\nChange: retry failed uploads 5 times with doubling waits from 1 s; stop at once on a 4xx. Keep the public API as it is, and commit on your branch when the tests pass.";
const RECEIPT = "Standard → Large model · medium · Work (5-hour 40%, resets 15:10)";

const worker = (id: string, name: string, kind: Worker["kind"], word: string, more: Partial<Worker> = {}): Worker => ({
  id,
  name,
  kind,
  word,
  startedAt: NOW - 130_000,
  lastAt: NOW - 4 * 60_000,
  model: "Large model",
  brief: BRIEF,
  receipt: RECEIPT,
  ...more,
});

export const RETRY = worker("w-retry", "Retry backoff", "working", "Working", { now: "Running cargo test", added: 42, removed: 7 });
export const PROGRESS = worker("w-progress", "Progress bar", "working", "Working", { now: "Writing…", startedAt: NOW - 210_000, added: 18, model: "Fast model", receipt: "Quick → Fast model · low · Personal (5-hour 12%, resets 17:40)" });
const HELD = worker("w-held", "Docs table", "needsYou", "Needs you", { startedAt: NOW - 240_000 });
const LIMIT = worker("w-limit", "Schema check", "limit", "Limit until 15:10");

/** Every state word wave 4 has a cause for [D3029]. */
const STATES: Worker[] = [
  HELD,
  LIMIT,
  worker("w-limit2", "Lint pass", "limit", "Limit"),
  worker("w-cli", "Changelog", "cliEnded", "Its CLI ended · next message continues it"),
  worker("w-fresh", "Thread phases", "freshContext", "Fresh context"),
  RETRY,
  worker("w-failed", "Flaky watcher", "failed", "Failed"),
  worker("w-ended", "Old importer", "stopped", "Ended"),
  worker("w-merged", "Daemon storage", "merged", "Merged"),
  worker("w-notmerged", "Upload list", "doneNotMerged", "Done · not merged"),
  worker("w-done", "Release notes", "done", "Done"),
];

const DONE_MANY = Array.from({ length: 12 }, (_, i) => worker(`w-d${i}`, `Finished task ${i + 1}`, i % 4 === 0 ? "stopped" : "done", i % 4 === 0 ? "Ended" : "Done", { lastAt: NOW - (i + 1) * 9 * 60_000 }));

/** A chip with its tip held open above it. */
function HeldChip({ worker: shown }: { worker: Worker }) {
  const [box, setBox] = useState<HTMLDivElement | null>(null);
  return (
    <div ref={setBox} className="relative flex min-w-64 justify-center pt-14">
      {box && <WorkerChip worker={shown} container={box} />}
    </div>
  );
}

/** A column as wide as a thread, its rows spaced as a turn's. */
function Column({ children }: { children: ReactNode }) {
  return <div className="flex w-140 min-w-0 flex-col gap-2">{children}</div>;
}

/** The right panel's frame. */
function Panel({ children }: { children: ReactNode }) {
  return <div className="flex h-110 w-90 flex-col overflow-hidden rounded-surface border border-border bg-background">{children}</div>;
}

const DONE_TURN: Turn = { id: "t-w", status: "done", startedAt: NOW - 184_000, endedAt: NOW };
const tool = (id: string, step: "read" | "run" | "edit" | "search", name: string, input: string): Item => ({
  id,
  turnId: DONE_TURN.id,
  kind: "tool",
  step,
  name,
  input,
  output: "",
  progress: "done",
  exitCode: 0,
});
const reply = (id: string, text: string): Item => ({ id, turnId: DONE_TURN.id, kind: "message", role: "assistant", text, streaming: false, final: true });
const body = (item: Item) => <Body key={item.id} item={item} turn={DONE_TURN} step={item.kind === "tool"} />;

const RECENT = [tool("wt-1", "read", "read", "src/upload/retry.rs"), tool("wt-2", "run", "shell", "cargo test -p upload")];
const EARLIER = [tool("wt-0a", "search", "rg", "“retry” in src/upload"), tool("wt-0b", "read", "read", "src/upload/mod.rs"), tool("wt-0c", "edit", "apply_patch", "src/upload/retry.rs")];
const ANSWER = reply("wt-3", "Uploads now retry 5 times, waiting 1, 2, 4, 8 and 16 s; a 4xx stops at once. Committed on `brigadier/retry-backoff` (2 commits).");

/** A worker opened in the panel: its header and thread. */
function View({ shown, children, workedMs, previous, live }: { shown: Worker; children?: ReactNode; workedMs?: number; previous?: ReactNode[]; live?: string }) {
  return (
    <Panel>
      <WorkerHeader
        worker={shown}
        onBack={noop}
        actions={
          <TitlebarTips>
            <TooltipIconButton look="toolbar" tooltip="Close right panel" onClick={noop}>
              <X />
            </TooltipIconButton>
          </TitlebarTips>
        }
      />
      <WorkerThread worker={shown} workedMs={workedMs} previous={previous} live={live}>
        {children}
      </WorkerThread>
    </Panel>
  );
}

/** The panel live: the list, a row opening its worker, back to the list. */
function LivePanel() {
  const [open, setOpen] = useState<string | null>(null);
  const [tab, setTab] = useState(WORKERS_LABEL);
  const [ended, setEnded] = useState<string[]>([]);
  const all = [RETRY, PROGRESS, HELD, ...STATES.slice(6), ...DONE_MANY].map((each) => (ended.includes(each.id) ? { ...each, kind: "stopped" as const, word: "Ended", lastAt: Date.now() } : each));
  const shown = all.find((each) => each.id === open);
  return (
    <WorkersPanel.Provider value={{ open: setOpen }}>
      <Panel>
        {shown ? (
          <>
            <WorkerHeader worker={shown} onBack={() => setOpen(null)} />
            <WorkerThread worker={shown} workedMs={184_000} live="Thinking">
              {RECENT.map(body)}
            </WorkerThread>
          </>
        ) : (
          <>
            <PanelTabs active={tab} tabs={["Files", WORKERS_LABEL]} finishedWords="11 done · 4 ended" onSelect={setTab} onClose={noop} />
            {tab === WORKERS_LABEL ? <WorkerList workers={all} onStop={(id) => setEnded((now) => [...now, id])} /> : <p className="m-auto text-sm text-muted-foreground">Files</p>}
          </>
        )}
      </Panel>
    </WorkersPanel.Provider>
  );
}

export function WorkersGallery() {
  const [stopped, setStopped] = useState(false);
  return (
    <>
      <Section title="Worker glyphs">
        <Row name="One per worker, the same wherever it shows (the old 30 shapes in 8 colours)">
          <div className="flex max-w-160 flex-wrap gap-3">
            {Array.from({ length: 48 }, (_, i) => (
              <WorkerGlyph key={i} id={`worker-${i}`} className="size-6" />
            ))}
          </div>
          <State label="With its working dot">
            <WorkerGlyph id="worker-3" working className="size-6" />
          </State>
        </Row>
      </Section>

      <Section title="Worker chip and name">
        <Row name="Each state word, in the chip's tip (the old chip shows its state on hover only)">
          {STATES.map((each) => (
            <State key={each.id} label={each.kind}>
              <HeldChip worker={each} />
            </State>
          ))}
        </Row>
        <Row name="Unknown, hovered, and the name button">
          <State label="A worker the app doesn't have">
            <WorkerChip worker={null} />
          </State>
          <State label="Hovered" frozen="hover">
            <WorkerChip worker={RETRY} />
          </State>
          <State label="Name with its glyph">
            <WorkerName worker={RETRY} />
          </State>
          <State label="Name alone (the sentence shows glyphs up front)">
            <WorkerName worker={RETRY} glyph={false} />
          </State>
        </Row>
      </Section>

      <Section title="Workers in the parent's thread">
        <Row name="What happened to them">
          <Column>
            <TeamSentence keep="g-ts-1" word="started" workers={[RETRY]} />
            <TeamSentence keep="g-ts-2" word="started" workers={[RETRY, PROGRESS]} />
            <TeamSentence keep="g-ts-3" word="started" workers={[RETRY, PROGRESS, HELD]} />
            <TeamSentence keep="g-ts-5" word="started" workers={[RETRY, PROGRESS, HELD, LIMIT, STATES[3]!]} />
            <TeamSentence keep="g-ts-w1" word="waiting" workers={[HELD]} why="Waiting for your approval" />
            <TeamSentence keep="g-ts-w2" word="waiting" workers={[LIMIT]} why="Waiting for an answer" />
            <TeamSentence keep="g-ts-w3" word="waiting" workers={[HELD, LIMIT]} />
            <TeamSentence keep="g-ts-s" word="stopped" workers={[STATES[7]!]} />
            <TeamSentence keep="g-ts-f" word="failed" workers={[STATES[6]!]} />
            <TeamSentence keep="g-ts-d" word="finished" workers={[STATES[9]!, STATES[10]!]} />
          </Column>
        </Row>
        <Row name="Started, opened to its briefs and what routing picked">
          <Column>
            <OpenOnce>
              <TeamSentence keep="g-ts-open" word="started" workers={[RETRY, PROGRESS]} />
            </OpenOnce>
          </Column>
        </Row>
        <Row name="What the lead did to them">
          <Column>
            <TeamStepRow keep="g-step-1" step={{ type: "messaged", byUser: false, worker: RETRY, text: "Also cap the total wait at 60 s." }} />
            <TeamStepRow keep="g-step-2" step={{ type: "messaged", byUser: true, worker: RETRY, text: "Skip the 4xx case for now." }} />
            <TeamStepRow keep="g-step-3" step={{ type: "stopped", byUser: false, workers: [STATES[7]!], afterMs: 190_000, reason: "Its approach duplicated the importer's own retry; not needed." }} />
            <TeamStepRow keep="g-step-4" step={{ type: "stopped", byUser: true, workers: [RETRY], afterMs: 190_000 }} />
          </Column>
        </Row>
        <Row name="Stop with workers running: the turn stops, the workers run on, one click ends them [D3009, D3011]">
          <State label="After Stop">
            <Column>
              <StillRunningRow workers={[RETRY, PROGRESS]} onStop={noop} />
            </Column>
          </State>
          <State label="After Stop them">
            <Column>
              <TeamStepRow keep="g-step-5" step={{ type: "stopped", byUser: true, workers: [RETRY, PROGRESS] }} />
            </Column>
          </State>
          <State label="Live: Stop them">
            <Column>
              {stopped ? <TeamStepRow keep="g-step-6" step={{ type: "stopped", byUser: true, workers: [RETRY, PROGRESS] }} /> : <StillRunningRow workers={[RETRY, PROGRESS]} onStop={() => setStopped(true)} />}
            </Column>
          </State>
        </Row>
      </Section>

      <Section title="Workers strip, above the composer">
        <Row name="One worker is its own row; more fold into a count">
          <State label="One, working">
            <Strip workers={[RETRY]} />
          </State>
          <State label="One, needs you">
            <Strip workers={[HELD]} />
          </State>
          <State label="Three, folded">
            <Strip workers={[RETRY, PROGRESS, HELD]} />
          </State>
          <State label="Three, open">
            <Strip workers={[RETRY, PROGRESS, HELD]} open />
          </State>
        </Row>
      </Section>

      <Section title="Right panel: Workers">
        <Row name="The list (the tab row shows only here until 4.3 wires it)">
          <State label="Active and Done">
            <Panel>
              <PanelTabs active={WORKERS_LABEL} tabs={["Files", WORKERS_LABEL]} onSelect={noop} onClose={noop} />
              <WorkerList workers={[RETRY, PROGRESS, HELD, LIMIT, STATES[3]!, ...DONE_MANY]} onStop={noop} />
            </Panel>
          </State>
          <State label="None active">
            <Panel>
              <PanelTabs active={WORKERS_LABEL} tabs={["Files", WORKERS_LABEL]} onSelect={noop} onClose={noop} />
              <WorkerList workers={DONE_MANY.slice(0, 3)} onStop={noop} />
            </Panel>
          </State>
          <State label="A row hovered: End in its time's place" frozen="hover">
            <Panel>
              <WorkerList workers={[RETRY]} onStop={noop} />
            </Panel>
          </State>
          <State label="Live: open a worker, End one">
            <LivePanel />
          </State>
        </Row>
        <Row name="A worker opened">
          <State label="Working">
            <View shown={RETRY} live="Thinking">
              {RECENT.map(body)}
            </View>
          </State>
          <State label="Needs you">
            <View shown={HELD}>{RECENT.map(body)}</View>
          </State>
          <State label="Ended">
            <View shown={STATES[7]!} workedMs={190_000}>
              {RECENT.map(body)}
            </View>
          </State>
          <State label="Done, its earlier work folded">
            <View shown={STATES[10]!} workedMs={184_000} previous={EARLIER.map(body)}>
              {[...RECENT, ANSWER].map(body)}
            </View>
          </State>
        </Row>
      </Section>
    </>
  );
}

/** The strip over a composer, as in a session. */
function Strip({ workers, open = false }: { workers: Worker[]; open?: boolean }) {
  return (
    <div className="w-140">
      <ComposerRail>
        <WorkersStrip workers={workers} onStop={noop} initiallyOpen={open} />
      </ComposerRail>
      <ComposerCard>
        <textarea aria-label="Message" placeholder="Do anything" className="min-h-16 w-full resize-none bg-transparent px-2 py-1 text-sm outline-none" />
      </ComposerCard>
    </div>
  );
}

/** Holds its row open: clicks its closed toggle once, as a user would. */
function OpenOnce({ children }: { children: ReactNode }) {
  return (
    <div
      ref={(box) => {
        box?.querySelector<HTMLElement>('[aria-expanded="false"]')?.click();
      }}
    >
      {children}
    </div>
  );
}
