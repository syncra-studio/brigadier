// Dev-only: four directions for the right panel's content (files, workers, one worker), on fake data, for the owner to
// choose from. Opened by `pnpm gallery` at #directions; 1–4 switch. Not wired to the app.
import { type ReactNode, useEffect, useState } from "react";

import { cx } from "../src/components/cx";
import { TooltipIconButton } from "../src/components/icon-button";
import { Segmented } from "../src/components/segmented";
import { TitlebarTips, Tooltip, TooltipContent, TooltipTrigger } from "../src/components/tooltip";
import { FileTree } from "../src/files/tree";
import { CodeLines } from "../src/files/code-lines";
import { Agent, ArrowLeft, ArrowRight, ArrowUp, ChevronRight, FilesGlyph, Plus, Sidebar, Tasks, X } from "../src/icons";
import { FileIcon } from "../src/icons/file-types";
import { WorkerGlyph } from "../src/icons/worker-glyphs";
import { LETTERS, type FileStatus } from "../src/panel/status";
import { Markdown } from "../src/thread/markdown";
import { finished, waiting, type Worker } from "../src/workers/chip";
import { TeamSentence } from "../src/workers/sentence";
import { WorkerHeader, WorkerThread } from "../src/workers/view";
import { ANSWER, DONE_TURN, EARLIER, HELD, LIMIT, PROGRESS, RECENT, RETRY, STATES } from "./workers";

// ── Fake data ────────────────────────────────────────────────────────────────

const TEAM: Worker[] = [HELD, RETRY, PROGRESS, LIMIT, STATES[10]!, STATES[8]!, STATES[6]!];
const NEEDS = TEAM.filter(waiting);
const WORKING = TEAM.filter((each) => each.kind === "working");
const DONE = TEAM.filter(finished);
const itemsOf = (worker: Worker) => (finished(worker) ? [...EARLIER, ...RECENT, ANSWER] : RECENT);

/** The last lines each worker's CLI printed, for the board's tails. */
const TAIL: Record<string, string[]> = {
  [HELD.id]: ["$ edit docs/upload.md", "Wants to run: pnpm docs:build", "Waiting for your approval"],
  [RETRY.id]: ["$ cargo test -p upload", "running 12 tests", "test retry::doubles_wait ... ok"],
  [PROGRESS.id]: ["edit src/upload/progress.rs", "+ pub fn bar(done: u64, total: u64)", "Writing…"],
  [LIMIT.id]: ["read src/schema.rs", "Usage limit reached", "Resumes at 15:10"],
};
const tailOf = (worker: Worker) => TAIL[worker.id] ?? (worker.kind === "failed" ? ["$ cargo test -p watch", "2 tests failed", "Failed"] : ["Committed 2 files", "All checks passed", worker.word]);

const FILES = ["Cargo.toml", "README.md", "docs/upload.md", "src/main.rs", "src/cli/args.rs", "src/cli/mod.rs", "src/upload/list.rs", "src/upload/mod.rs", "src/upload/progress.rs", "src/upload/retry.rs", "tests/retry.rs"];
type Changed = { path: string; status: FileStatus; added: number; removed: number; by: Worker; diff: string[] };
const CHANGED: Changed[] = [
  { path: "src/upload/retry.rs", status: "modified", added: 42, removed: 7, by: RETRY, diff: ["-    let wait = 1000;", "+    let mut wait = Duration::from_secs(1);", "+    for attempt in 0..5 {", "+        wait *= 2;"] },
  { path: "src/upload/progress.rs", status: "added", added: 18, removed: 0, by: PROGRESS, diff: ["+pub struct Progress {", "+    done: u64,", "+    total: u64,", "+}"] },
  { path: "tests/retry.rs", status: "added", added: 31, removed: 0, by: RETRY, diff: ["+#[test]", "+fn stops_on_4xx() {", "+    assert_eq!(tries(404), 1);", "+}"] },
  { path: "docs/upload.md", status: "modified", added: 6, removed: 2, by: HELD, diff: ["-Uploads fail on a dropped network.", "+Uploads retry 5 times, waiting", "+1, 2, 4, 8 and 16 s."] },
];
const MARKS = { files: Object.fromEntries(CHANGED.map((each) => [each.path, each.status])), folders: { src: "modified" as FileStatus, "src/upload": "modified" as FileStatus, tests: "added" as FileStatus, docs: "modified" as FileStatus } };
const LISTING = { state: "listed" as const, list: { files: FILES, truncated: false, ignored: [] } };
const CODE = `use std::time::Duration;

use crate::upload::{Upload, UploadError};

/// Retries a failed upload up to 5 times, doubling the wait from 1 s.
/// A 4xx is the server saying no: it stops at once.
pub async fn with_retry(upload: &Upload) -> Result<(), UploadError> {
    let mut wait = Duration::from_secs(1);
    for attempt in 0..5 {
        match upload.send().await {
            Ok(()) => return Ok(()),
            Err(UploadError::Client(code)) => return Err(UploadError::Client(code)),
            Err(error) if attempt == 4 => return Err(error),
            Err(_) => {
                tokio::time::sleep(wait).await;
                wait *= 2;
            }
        }
    }
    unreachable!()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn doubles_wait() {
        let upload = Upload::failing(3);
        assert!(with_retry(&upload).await.is_ok());
        assert_eq!(upload.tries(), 4);
    }
}
`;
const baseName = (path: string) => path.slice(path.lastIndexOf("/") + 1);
const dirName = (path: string) => path.slice(0, Math.max(0, path.lastIndexOf("/")));

// ── Shared parts ─────────────────────────────────────────────────────────────

/** +N −N, coloured as the thread's change counts. */
function Counts({ added = 0, removed = 0 }: { added?: number; removed?: number }) {
  return (
    <span className="shrink-0 font-mono text-xs tabular-nums">
      {added > 0 && <span className="text-success">+{added}</span>}
      {removed > 0 && <span className="ms-1 text-destructive">−{removed}</span>}
    </span>
  );
}

function StatusLetter({ status }: { status: FileStatus }) {
  const { letter, label, className } = LETTERS[status];
  return (
    <span title={label} className={cx("w-3 shrink-0 text-center font-mono text-xs", className)}>
      {letter}
    </span>
  );
}

/** A few diff lines, added and removed on their washes. */
function MiniDiff({ lines, className }: { lines: string[]; className?: string }) {
  return (
    <pre className={cx("overflow-hidden rounded-control bg-code-surface py-1 font-mono text-diff", className)}>
      {lines.map((line, index) => (
        <div key={index} className={cx("truncate px-2", line.startsWith("+") ? "bg-diff-added" : line.startsWith("-") ? "bg-diff-removed" : "")}>
          {line}
        </div>
      ))}
    </pre>
  );
}

/** A worker opened: its header and its thread, read only. */
function OneWorker({ worker, onBack, list }: { worker: Worker; onBack: () => void; list?: string }) {
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <WorkerHeader worker={worker} details onBack={onBack} list={list} />
      <WorkerThread worker={worker} items={itemsOf(worker)} turns={[DONE_TURN]} />
    </div>
  );
}

/** A file opened: its path and its lines. */
function OneFile({ path, onBack }: { path: string; onBack?: () => void }) {
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <header className="flex h-11.5 shrink-0 items-center gap-2 border-b border-border px-3">
        {onBack && (
          <TooltipIconButton tooltip="Back" onClick={onBack} className="rounded-icon-button">
            <ArrowLeft />
          </TooltipIconButton>
        )}
        <FileIcon name={baseName(path)} />
        <span className="truncate text-label font-medium">{baseName(path)}</span>
        <span className="truncate text-xs text-muted-foreground">{dirName(path)}</span>
      </header>
      <CodeLines text={CODE} path="retry.rs" active={false} />
    </div>
  );
}

/** One worker as a line: glyph, name, what it does now, its counts. */
function WorkerLine({ worker, picked, onOpen }: { worker: Worker; picked?: boolean; onOpen: () => void }) {
  return (
    <button type="button" onClick={onOpen} className={cx("flex min-w-0 cursor-pointer items-center gap-3 rounded-icon-button px-2 py-1.5 text-start hover:bg-fill-subtle focus-visible:focus-ring", picked && "bg-selection hover:bg-selection")}>
      <WorkerGlyph id={worker.id} working={worker.kind === "working"} className="size-6" />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-label">{worker.name}</span>
        <span className={cx("truncate text-xs", waiting(worker) ? "text-warning" : "text-muted-foreground")}>{worker.now ?? worker.word}</span>
      </span>
      <Counts added={worker.added} removed={worker.removed} />
    </button>
  );
}

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-0.5">
      <h3 className="px-2 pb-1 text-xs font-medium text-muted-foreground">{title}</h3>
      {children}
    </section>
  );
}

/** The thread every direction sits beside: the ask, the lead's answer, its workers starting and one waiting. */
function FakeThread() {
  return (
    <div className="mx-auto flex w-full max-w-reading flex-col gap-5 px-6 pt-6 pb-40 text-base">
      <div className="ms-auto max-w-[80%] rounded-thread bg-bubble px-3.5 py-2.25 ring-1 ring-bubble-edge ring-inset">
        Make uploads survive a flaky network: retry with backoff, show progress, and document it.
      </div>
      <Markdown keep="d-1" text={"I'll split this across workers: **retry** in `src/upload/retry.rs`, a **progress bar**, and the **docs**. Each works on its own branch and I'll merge them when the tests pass."} />
      <TeamSentence keep="d-2" word="started" workers={[RETRY, PROGRESS, HELD]} />
      <TeamSentence keep="d-3" word="waiting" workers={[HELD]} why="Waiting for your approval" />
      <Markdown keep="d-4" text={"Retry backoff is running the tests now. *Docs table* wants to run `pnpm docs:build`; approve it from its row or open it to see why."} />
    </div>
  );
}

function FakeComposer({ above, children }: { above?: ReactNode; children?: ReactNode }) {
  return (
    <div className="pointer-events-auto mx-auto flex w-full max-w-reading flex-col gap-2 px-6 pb-4">
      {above}
      <div className={cx("flex flex-col rounded-composer bg-composer shadow-composer ring-1 ring-glass-stroke ring-inset min-h-0", Boolean(children) && "shadow-overlay")}>
        {children}
        <div className="px-4 pt-3.5 text-base text-placeholder">Do anything</div>
        <div className="flex items-center justify-between px-2.5 pt-3 pb-2.5">
          <TooltipIconButton tooltip="Add" className="rounded-capsule">
            <Plus />
          </TooltipIconButton>
          <span className="flex size-8 items-center justify-center rounded-capsule bg-fill text-muted-foreground">
            <ArrowUp className="size-icon-md" />
          </span>
        </div>
      </div>
    </div>
  );
}

function FakeSidebar() {
  const row = "flex h-nav-row items-center gap-2 rounded-nav px-2.5 text-label";
  return (
    <nav className="flex w-60 shrink-0 flex-col gap-1 rounded-panel bg-card p-2 ring-1 ring-glass-stroke ring-inset">
      <div className={cx(row, "h-11 text-nav-title font-semibold")}>Brigadier</div>
      <div className={cx(row, "bg-fill-subtle")}>New chat</div>
      <div className="px-2.5 pt-4 pb-1 text-xs text-muted-foreground">Projects</div>
      <div className={row}>uploader</div>
      <div className={cx(row, "ps-6 bg-selection")}>Upload retries</div>
      <div className={cx(row, "ps-6 text-muted-foreground")}>CLI flags cleanup</div>
      <div className={cx(row, "ps-6 text-muted-foreground")}>Release notes</div>
    </nav>
  );
}

const DIRECTIONS = [
  { value: "drawer", label: "1 · Drawer" },
  { value: "stage", label: "2 · Stage" },
  { value: "dock", label: "3 · Dock" },
  { value: "board", label: "4 · Board" },
] as const;
type Direction = (typeof DIRECTIONS)[number]["value"];

/** The toolbar's pill: whatever the direction adds, then the right panel's toggle, white and lit. */
function ToolbarPill({ children }: { children?: ReactNode }) {
  return (
    <div className="app-no-drag flex h-7.5 shrink-0 items-center gap-0.5 rounded-capsule bg-control px-px ring-1 ring-glass-stroke ring-inset">
      <TitlebarTips>
        <TooltipIconButton look="pill" tooltip="Context">
          <Tasks />
        </TooltipIconButton>
        {children}
      </TitlebarTips>
    </div>
  );
}

/**
 * The window: history pill, the direction picker, the toolbar; the sidebar, the chat (with `inMain` over it) and
 * `beside` after it; `side` runs the window's full height at its end, through the tab bar.
 */
function Shell({ direction, onDirection, toolbar, composer, inMain, beside, side, over }: {
  direction: Direction;
  onDirection: (next: Direction) => void;
  toolbar?: ReactNode;
  composer?: ReactNode;
  inMain?: ReactNode;
  beside?: ReactNode;
  side?: ReactNode;
  over?: ReactNode;
}) {
  return (
    <div className="fixed inset-0 flex bg-background text-foreground">
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="app-drag flex h-tab-bar shrink-0 items-center gap-3 ps-traffic-lights pe-2">
          <div className="app-no-drag flex h-7.5 items-center rounded-capsule bg-control px-px ring-1 ring-glass-stroke ring-inset">
            <TitlebarTips>
              <TooltipIconButton look="pill" tooltip="Back">
                <ArrowLeft />
              </TooltipIconButton>
              <TooltipIconButton look="pill" tooltip="Forward">
                <ArrowRight />
              </TooltipIconButton>
              <TooltipIconButton look="pill" tooltip="Sidebar">
                <Sidebar />
              </TooltipIconButton>
            </TitlebarTips>
          </div>
          <span className="flex h-7.5 items-center rounded-session-tab bg-selection px-3 text-label">Upload retries</span>
          <div className="app-no-drag mx-auto">
            <Segmented label="Direction" value={direction} options={DIRECTIONS} onChange={onDirection} fill />
          </div>
          {!side && <ToolbarPill>{toolbar}</ToolbarPill>}
        </header>
        <div className="flex min-h-0 flex-1 gap-1 ps-1 pe-1 pb-1">
          <FakeSidebar />
          <main className="relative flex min-w-0 flex-1 flex-col">
            <div className="min-h-0 flex-1 overflow-y-auto">
              <FakeThread />
            </div>
            <div className="pointer-events-none absolute inset-x-0 bottom-0 z-10 flex max-h-full flex-col justify-end">{composer ?? <FakeComposer />}</div>
            {inMain}
          </main>
          {beside}
        </div>
      </div>
      {side}
      {over}
    </div>
  );
}

// ── 1 · Drawer: the work rises out of the composer ───────────────────────────

function Drawer(props: { direction: Direction; onDirection: (next: Direction) => void }) {
  const [open, setOpen] = useState<"workers" | "files" | null>("workers");
  const [worker, setWorker] = useState<string | null>(null);
  const [path, setPath] = useState<string[]>(["src", "upload"]);
  const [file, setFile] = useState<string | null>("src/upload/retry.rs");
  const picked = TEAM.find((each) => each.id === worker);
  const onHand = TEAM.filter((each) => !finished(each));

  // The dock above the composer: who's on hand, how many are done, and the changed files; each opens the drawer.
  const dock = (
    <div className="flex items-center gap-1 self-start rounded-capsule bg-control p-1 ring-1 ring-glass-stroke ring-inset">
      {onHand.map((each) => (
        <button key={each.id} type="button" onClick={() => (setOpen("workers"), setWorker(each.id))} className="flex h-7 cursor-pointer items-center whitespace-nowrap gap-1.5 rounded-capsule ps-1 pe-2.5 text-label hover:bg-fill">
          <WorkerGlyph id={each.id} working={each.kind === "working"} className="size-5" />
          {each.name}
          {waiting(each) && <span className="size-1.5 rounded-capsule bg-warning" />}
        </button>
      ))}
      <button type="button" onClick={() => (setOpen("workers"), setWorker(null))} className="flex h-7 cursor-pointer items-center whitespace-nowrap rounded-capsule px-2.5 text-label text-muted-foreground hover:bg-fill">
        {DONE.length} done
      </button>
      <span className="mx-0.5 h-4 w-px bg-divider" />
      <button type="button" onClick={() => setOpen("files")} className="flex h-7 cursor-pointer items-center whitespace-nowrap gap-1.5 rounded-capsule px-2.5 text-label hover:bg-fill">
        <FilesGlyph className="size-icon-md" />
        {CHANGED.length} changed
      </button>
    </div>
  );

  const workers = picked ? (
    <div className="flex min-h-0 flex-1">
      <div className="flex w-56 shrink-0 flex-col gap-0.5 overflow-y-auto border-e border-divider p-2">
        {TEAM.map((each) => <WorkerLine key={each.id} worker={each} picked={each.id === worker} onOpen={() => setWorker(each.id)} />)}
      </div>
      <OneWorker worker={picked} onBack={() => setWorker(null)} />
    </div>
  ) : (
    <div className="grid min-h-0 flex-1 auto-rows-min grid-cols-3 gap-2 overflow-y-auto p-3">
      {TEAM.map((each) => (
        <button key={each.id} type="button" onClick={() => setWorker(each.id)} className={cx("flex cursor-pointer flex-col gap-2 rounded-surface bg-fill-subtle p-3 text-start ring-1 ring-glass-stroke ring-inset hover:bg-fill-hover", finished(each) && "opacity-70")}>
          <span className="flex items-center gap-2">
            <WorkerGlyph id={each.id} working={each.kind === "working"} className="size-6" />
            <span className="min-w-0 flex-1 truncate text-label font-medium">{each.name}</span>
            <Counts added={each.added} removed={each.removed} />
          </span>
          <span className={cx("truncate text-xs", waiting(each) ? "text-warning" : "text-muted-foreground")}>{each.now ?? each.word}</span>
        </button>
      ))}
    </div>
  );

  // Files as Finder's columns: each folder opened adds a column; a file shows in the last.
  const columns = ["", ...path.map((_, i) => path.slice(0, i + 1).join("/"))];
  const entries = (folder: string) => {
    const under = FILES.filter((each) => dirName(each) === folder || (folder === "" ? !each.includes("/") : false));
    const folders = [...new Set(FILES.filter((each) => each.startsWith(folder ? `${folder}/` : "") && each.slice(folder ? folder.length + 1 : 0).includes("/")).map((each) => each.slice(folder ? folder.length + 1 : 0).split("/")[0]!))];
    return { folders: folders.toSorted(), files: under };
  };
  const files = (
    <div className="flex min-h-0 flex-1">
      {columns.map((folder, depth) => {
        const { folders, files: inside } = entries(folder);
        return (
          <div key={folder} className="flex w-36 shrink-0 flex-col gap-0.5 overflow-y-auto border-e border-divider p-1.5">
            {folders.map((name) => {
              const full = folder ? `${folder}/${name}` : name;
              return (
                <button key={name} type="button" onClick={() => (setPath([...path.slice(0, depth), name]), setFile(null))} className={cx("flex h-7 cursor-pointer items-center whitespace-nowrap gap-2 rounded-icon-button px-2 text-label hover:bg-fill-subtle", path[depth] === name && "bg-selection")}>
                  <span className="min-w-0 flex-1 truncate text-start">{name}</span>
                  {MARKS.folders[full as keyof typeof MARKS.folders] && <span className="size-1.5 rounded-capsule bg-warning" />}
                  <ChevronRight className="size-3 text-muted-foreground" />
                </button>
              );
            })}
            {inside.map((each) => (
              <button key={each} type="button" onClick={() => (setPath(path.slice(0, depth)), setFile(each))} className={cx("flex h-7 cursor-pointer items-center whitespace-nowrap gap-2 rounded-icon-button px-2 text-label hover:bg-fill-subtle", file === each && "bg-selection")}>
                <FileIcon name={baseName(each)} size="sm" />
                <span className="min-w-0 flex-1 truncate text-start">{baseName(each)}</span>
                {MARKS.files[each] && <StatusLetter status={MARKS.files[each]} />}
              </button>
            ))}
          </div>
        );
      })}
      {file ? <OneFile path={file} /> : <div className="flex flex-1 items-center justify-center text-label text-muted-foreground">Pick a file</div>}
    </div>
  );

  return (
    <Shell
      {...props}
      toolbar={
        <TooltipIconButton look="pill" className="drop-shadow-toggle-glow" tooltip="Work drawer" onClick={() => setOpen(open ? null : "workers")}>
          <Sidebar className="rotate-90" />
        </TooltipIconButton>
      }
      inMain={open && <div onClick={() => setOpen(null)} className="absolute inset-0 bg-dialog-backdrop" />}
      composer={
        <FakeComposer above={!open && dock}>
          {open && (
            <div className="flex h-[min(34rem,62vh)] min-h-0 flex-col border-b border-divider">
              <div className="flex h-11.5 shrink-0 items-center gap-2 px-3">
                <Segmented label="Show" value={open} onChange={setOpen} options={[{ value: "workers", label: `Workers · ${TEAM.length}` }, { value: "files", label: `Files · ${CHANGED.length} changed` }]} />
                <TooltipIconButton tooltip="Close" className="ms-auto" onClick={() => setOpen(null)}>
                  <X />
                </TooltipIconButton>
              </div>
              {open === "workers" ? workers : files}
            </div>
          )}
        </FakeComposer>
      }
    />
  );
}

// ── 2 · Stage: a second column of its own, through the tab bar ───────────────

type StageTab = { kind: "files" } | { kind: "team" } | { kind: "worker"; id: string } | { kind: "file"; path: string };
const tabKey = (tab: StageTab) => (tab.kind === "worker" ? tab.id : tab.kind === "file" ? tab.path : tab.kind);

function Stage(props: { direction: Direction; onDirection: (next: Direction) => void }) {
  const [tabs, setTabs] = useState<StageTab[]>([{ kind: "team" }, { kind: "files" }, { kind: "worker", id: RETRY.id }]);
  const [active, setActive] = useState(RETRY.id);
  const open = (tab: StageTab) => {
    if (!tabs.some((each) => tabKey(each) === tabKey(tab))) setTabs([...tabs, tab]);
    setActive(tabKey(tab));
  };
  const close = (key: string) => {
    const next = tabs.filter((each) => tabKey(each) !== key);
    setTabs(next);
    if (active === key) setActive(tabKey(next[next.length - 1] ?? { kind: "team" }));
  };
  const shown = tabs.find((each) => tabKey(each) === active) ?? tabs[0]!;

  const label = (tab: StageTab) => {
    if (tab.kind === "team") return <><Agent className="size-icon-md" />Team</>;
    if (tab.kind === "files") return <><FilesGlyph className="size-icon-md" />Files</>;
    if (tab.kind === "file") return <><FileIcon name={baseName(tab.path)} size="sm" />{baseName(tab.path)}</>;
    const worker = TEAM.find((each) => each.id === tab.id)!;
    return <><WorkerGlyph id={worker.id} working={worker.kind === "working"} className="size-4" />{worker.name}</>;
  };

  const body = (() => {
    if (shown.kind === "worker") {
      const worker = TEAM.find((each) => each.id === shown.id)!;
      return <OneWorker worker={worker} list="Team" onBack={() => setActive("team")} />;
    }
    if (shown.kind === "file") return <OneFile path={shown.path} />;
    if (shown.kind === "files")
      return (
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="flex flex-col gap-0.5 border-b border-divider p-2">
            <h3 className="px-2 pb-1 text-xs font-medium text-muted-foreground">Changed in this chat</h3>
            {CHANGED.map((each) => (
              <button key={each.path} type="button" onClick={() => open({ kind: "file", path: each.path })} className="flex h-8 cursor-pointer items-center gap-2 rounded-icon-button px-2 text-label hover:bg-fill-subtle">
                <FileIcon name={baseName(each.path)} />
                <span className="truncate">{baseName(each.path)}</span>
                <span className="min-w-0 flex-1 truncate text-start text-xs text-muted-foreground">{dirName(each.path)}</span>
                <WorkerGlyph id={each.by.id} className="size-4" />
                <Counts added={each.added} removed={each.removed} />
              </button>
            ))}
          </div>
          <FileTree scope="directions-stage" listing={LISTING} marks={MARKS} results={null} onQuery={() => {}} onOpen={(path) => open({ kind: "file", path })} />
        </div>
      );
    return (
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-3">
        <Group title={`Needs you · ${NEEDS.length}`}>{NEEDS.map((each) => <WorkerLine key={each.id} worker={each} onOpen={() => open({ kind: "worker", id: each.id })} />)}</Group>
        <Group title={`Working · ${WORKING.length}`}>{WORKING.map((each) => <WorkerLine key={each.id} worker={each} onOpen={() => open({ kind: "worker", id: each.id })} />)}</Group>
        <Group title={`Done · ${DONE.length}`}>{DONE.map((each) => <WorkerLine key={each.id} worker={each} onOpen={() => open({ kind: "worker", id: each.id })} />)}</Group>
      </div>
    );
  })();

  return (
    <Shell
      {...props}
      side={
        <section aria-label="Stage" className="flex h-full w-[42%] shrink-0 flex-col border-s border-divider bg-card">
          <div className="app-drag flex h-tab-bar shrink-0 items-center gap-1 ps-2 pe-2">
            <div className="app-no-drag flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
              {tabs.map((tab) => {
                const key = tabKey(tab);
                const pinned = tab.kind === "team" || tab.kind === "files";
                return (
                  <span key={key} className={cx("group/tab flex h-7.5 shrink-0 items-center rounded-session-tab text-label", active === key ? "bg-selection text-foreground" : "text-muted-foreground hover:bg-fill-subtle")}>
                    <button type="button" onClick={() => setActive(key)} className="flex h-full cursor-pointer items-center gap-1.5 ps-2.5 pe-2.5 [&>svg]:shrink-0">
                      {label(tab)}
                    </button>
                    {!pinned && (
                      <button type="button" aria-label="Close" onClick={() => close(key)} className="-ms-1.5 me-1 flex size-5 cursor-pointer items-center justify-center rounded-capsule opacity-0 group-hover/tab:opacity-100 hover:bg-fill">
                        <X className="size-3" />
                      </button>
                    )}
                  </span>
                );
              })}
            </div>
            <ToolbarPill>
              <TooltipIconButton look="pill" className="drop-shadow-toggle-glow" tooltip="Stage">
                <Sidebar className="-scale-x-100" />
              </TooltipIconButton>
            </ToolbarPill>
          </div>
          <div className="flex min-h-0 flex-1 flex-col border-t border-divider">{body}</div>
        </section>
      }
    />
  );
}

// ── 3 · Dock: a rail of who's working, an inspector that floats over the chat on demand ───────────

function Dock(props: { direction: Direction; onDirection: (next: Direction) => void }) {
  const [open, setOpen] = useState<string | null>(HELD.id);
  const [diff, setDiff] = useState<string | null>(CHANGED[0]!.path);
  const [file, setFile] = useState<string | null>(null);
  const picked = TEAM.find((each) => each.id === open);
  const onHand = TEAM.filter((each) => !finished(each));
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && setOpen(null);
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, []);

  const railButton = (id: string, tip: ReactNode, child: ReactNode, mark?: ReactNode) => (
    <Tooltip key={id}>
      <TooltipTrigger
        render={
          <button type="button" aria-pressed={open === id} onClick={() => setOpen(open === id ? null : id)} className="relative flex size-9 cursor-pointer items-center justify-center rounded-capsule hover:bg-fill aria-pressed:bg-selection aria-pressed:ring-1 aria-pressed:ring-glass-stroke">
            {child}
            {mark}
          </button>
        }
      />
      <TooltipContent side="left">{tip}</TooltipContent>
    </Tooltip>
  );

  const rail = (
    <div className="absolute end-2 top-1/2 z-10 flex -translate-y-1/2 flex-col items-center gap-1 rounded-capsule bg-rail-glass p-1 shadow-overlay ring-1 ring-glass-stroke ring-inset backdrop-blur-material">
      {railButton("files", `Files · ${CHANGED.length} changed`, <FilesGlyph className="size-icon-md" />, <span className="absolute -end-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-capsule bg-fill-active px-1 text-badge font-medium">{CHANGED.length}</span>)}
      <span className="my-0.5 h-px w-5 bg-divider" />
      {onHand.map((each) =>
        railButton(
          each.id,
          <span className="flex flex-col gap-0.5 py-0.5">
            <span className="font-medium">{each.name}</span>
            <span className="text-muted-foreground">{each.now ?? each.word}</span>
          </span>,
          <WorkerGlyph id={each.id} working={each.kind === "working"} className="size-6" />,
          waiting(each) && <span className="absolute end-0.5 top-0.5 size-2 rounded-capsule bg-warning ring-2 ring-rail-glass" />,
        ),
      )}
      <span className="my-0.5 h-px w-5 bg-divider" />
      {railButton("done", `${DONE.length} done`, <span className="text-xs text-muted-foreground">+{DONE.length}</span>)}
    </div>
  );

  const files = file ? (
    <OneFile path={file} onBack={() => setFile(null)} />
  ) : (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex h-11.5 shrink-0 items-center gap-2 border-b border-border px-3">
        <span className="text-label font-medium">Changes</span>
        <span className="text-label text-muted-foreground">{CHANGED.length} files</span>
      </header>
      <div className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto p-2">
        {CHANGED.map((each) => (
          <div key={each.path} className="flex flex-col">
            <button type="button" onClick={() => setDiff(diff === each.path ? null : each.path)} onDoubleClick={() => setFile(each.path)} className="flex h-8 cursor-pointer items-center gap-2 rounded-icon-button px-2 text-label hover:bg-fill-subtle">
              <ChevronRight className={cx("size-3 text-muted-foreground transition-transform", diff === each.path && "rotate-90")} />
              <FileIcon name={baseName(each.path)} size="sm" />
              <span className="truncate">{baseName(each.path)}</span>
              <span className="min-w-0 flex-1 truncate text-start text-xs text-muted-foreground">{dirName(each.path)}</span>
              <Counts added={each.added} removed={each.removed} />
            </button>
            {diff === each.path && (
              <button type="button" onClick={() => setFile(each.path)} className="cursor-pointer ps-7 pe-1 pb-1 text-start">
                <MiniDiff lines={each.diff} />
                <span className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
                  <WorkerGlyph id={each.by.id} className="size-3.5" />
                  {each.by.name} · open the file
                </span>
              </button>
            )}
          </div>
        ))}
        <h3 className="px-2 pt-3 pb-1 text-xs font-medium text-muted-foreground">All files</h3>
        <div className="flex min-h-64 flex-col">
          <FileTree scope="directions-dock" listing={LISTING} marks={MARKS} results={null} onQuery={() => {}} onOpen={(path) => setFile(path)} />
        </div>
      </div>
    </div>
  );

  const inspector = open && (
    <div role="dialog" aria-label="Inspector" className="absolute end-15 top-2 bottom-2 z-10 flex w-[26rem] flex-col overflow-hidden rounded-overlay bg-popover shadow-overlay ring-1 ring-popover-edge ring-inset backdrop-blur-popover motion-safe:animate-fade-in">
      {open === "files" ? (
        files
      ) : open === "done" ? (
        <div className="flex flex-col gap-0.5 p-2">
          <Group title={`Done · ${DONE.length}`}>{DONE.map((each) => <WorkerLine key={each.id} worker={each} onOpen={() => setOpen(each.id)} />)}</Group>
        </div>
      ) : (
        picked && <OneWorker worker={picked} list="the chat" onBack={() => setOpen(null)} />
      )}
    </div>
  );

  return (
    <Shell
      {...props}
      toolbar={
        <TooltipIconButton look="pill" className="drop-shadow-toggle-glow" tooltip="Dock">
          <Sidebar className="-scale-x-100" />
        </TooltipIconButton>
      }
      inMain={
        <>
          {rail}
          {inspector}
        </>
      }
    />
  );
}

// ── 4 · Board: the team and its files on a layer of their own ───────────────

function Board(props: { direction: Direction; onDirection: (next: Direction) => void }) {
  const [shown, setShown] = useState(true);
  const [view, setView] = useState<"team" | "files">("team");
  const [focus, setFocus] = useState<string | null>(null);
  const picked = TEAM.find((each) => each.id === focus);
  const file = view === "files" ? focus : null;
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && (focus ? setFocus(null) : setShown(false));
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [focus]);

  const card = (worker: Worker) => (
    <button key={worker.id} type="button" onClick={() => setFocus(worker.id)} className={cx("flex cursor-pointer flex-col gap-2.5 rounded-surface bg-card p-3 text-start ring-1 ring-glass-stroke ring-inset hover:ring-resize-edge", focus === worker.id && "ring-resize-edge")}>
      <span className="flex items-center gap-2">
        <WorkerGlyph id={worker.id} working={worker.kind === "working"} className="size-6" />
        <span className="min-w-0 flex-1 truncate text-label font-medium">{worker.name}</span>
        <Counts added={worker.added} removed={worker.removed} />
      </span>
      {!focus && <MiniDiff lines={tailOf(worker).map((line) => ` ${line}`)} className="text-muted-foreground" />}
      <span className={cx("truncate text-xs", waiting(worker) ? "text-warning" : "text-muted-foreground")}>
        {worker.word} · {worker.model}
      </span>
    </button>
  );
  const column = (title: string, workers: Worker[]) => (
    <section key={title} className="flex min-w-0 flex-1 flex-col gap-2">
      <h3 className="px-1 text-label font-medium text-muted-foreground">
        {title} <span className="text-faint-foreground">{workers.length}</span>
      </h3>
      {workers.map(card)}
    </section>
  );

  const team = picked ? (
    <div className="flex min-h-0 flex-1 gap-3">
      <div className="flex w-64 shrink-0 flex-col gap-2 overflow-y-auto">{TEAM.map(card)}</div>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-surface bg-background ring-1 ring-glass-stroke ring-inset">
        <OneWorker worker={picked} list="the board" onBack={() => setFocus(null)} />
      </div>
    </div>
  ) : (
    <div className="flex min-h-0 flex-1 gap-3 overflow-y-auto">{[column("Needs you", NEEDS), column("Working", WORKING), column("Done", DONE)]}</div>
  );
  const files = file ? (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-surface bg-background ring-1 ring-glass-stroke ring-inset">
      <OneFile path={file} onBack={() => setFocus(null)} />
    </div>
  ) : (
    <div className="grid min-h-0 flex-1 auto-rows-min grid-cols-2 gap-3 overflow-y-auto">
      {CHANGED.map((each) => (
        <button key={each.path} type="button" onClick={() => setFocus(each.path)} className="flex cursor-pointer flex-col gap-2 rounded-surface bg-card p-3 text-start ring-1 ring-glass-stroke ring-inset hover:ring-resize-edge">
          <span className="flex items-center gap-2">
            <FileIcon name={baseName(each.path)} />
            <span className="truncate text-label font-medium">{baseName(each.path)}</span>
            <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{dirName(each.path)}</span>
            <Counts added={each.added} removed={each.removed} />
          </span>
          <MiniDiff lines={each.diff} />
          <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <WorkerGlyph id={each.by.id} className="size-3.5" />
            {each.by.name}
          </span>
        </button>
      ))}
    </div>
  );

  return (
    <Shell
      {...props}
      toolbar={
        <TooltipIconButton look="pill" className="drop-shadow-toggle-glow" tooltip="Board" onClick={() => setShown(!shown)}>
          <Agent />
        </TooltipIconButton>
      }
      composer={<FakeComposer above={<button type="button" onClick={() => setShown(true)} className="flex cursor-pointer items-center gap-2 self-start rounded-capsule bg-control py-1 ps-1.5 pe-3 text-label ring-1 ring-glass-stroke ring-inset hover:bg-fill"><span className="flex -space-x-1">{TEAM.filter((each) => !finished(each)).map((each) => <WorkerGlyph key={each.id} id={each.id} className="size-5" />)}</span>{NEEDS.length} need you · {WORKING.length} working · open the board</button>} />}
      over={
        shown && (
          <div className="fixed inset-x-0 top-tab-bar bottom-0 z-20 flex flex-col bg-dialog-backdrop px-8 pb-6 backdrop-blur-material motion-safe:animate-fade-in" onClick={(event) => event.target === event.currentTarget && setShown(false)}>
            <div className="flex min-h-0 flex-1 flex-col gap-4 rounded-alert bg-popover p-5 shadow-overlay ring-1 ring-popover-edge ring-inset">
              <div className="flex items-center gap-3">
                <h2 className="text-nav-title font-semibold">Upload retries</h2>
                <Segmented label="Board" value={view} onChange={(next) => (setView(next), setFocus(null))} options={[{ value: "team", label: `Team · ${TEAM.length}` }, { value: "files", label: `Files · ${CHANGED.length}` }]} />
                <span className="ms-auto text-xs text-muted-foreground">Esc to go back to the chat</span>
                <TooltipIconButton tooltip="Close" onClick={() => setShown(false)}>
                  <X />
                </TooltipIconButton>
              </div>
              {view === "team" ? team : files}
            </div>
          </div>
        )
      }
    />
  );
}

/** The four directions, switched from the tab bar or with 1–4. */
export function Directions() {
  const [direction, setDirection] = useState<Direction>(() => (sessionStorage.getItem("direction") as Direction | null) ?? "drawer");
  const pick = (next: Direction) => (sessionStorage.setItem("direction", next), setDirection(next));
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const next = DIRECTIONS[Number(event.key) - 1];
      if (next && !(event.target instanceof HTMLInputElement)) pick(next.value);
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, []);
  const props = { direction, onDirection: pick };
  if (direction === "stage") return <Stage {...props} />;
  if (direction === "dock") return <Dock {...props} />;
  if (direction === "board") return <Board {...props} />;
  return <Drawer {...props} />;
}
