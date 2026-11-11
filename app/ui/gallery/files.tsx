// The right panel's Files and the file viewer [D1002]: each state frozen on fake data, plus live copies.
import { useState, type ReactNode } from "react";

import { CAPPED, FILES, fakeRead, findFiles, IGNORED, LONG_FILE, MARKS } from "../src/files/fake";
import { FileTree } from "../src/files/tree";
import { FileViewer } from "../src/files/viewer";
import { FilesView } from "./files-live";
import { Row, Section, State } from "./parts";

const noop = () => {};

/** The panel's column, as wide as the old one opened. */
function Panel({ label, children }: { label: string; children: ReactNode }) {
  return (
    <State label={label}>
      <div className="flex h-112 w-80 flex-col overflow-hidden rounded-surface border border-border bg-background">{children}</div>
    </State>
  );
}

/** A main-area file tab's room: a tab panel, as tab-views mounts it, so the thread's ⌘F leaves its keys alone. */
function Tab({ label, wide, children }: { label: string; wide?: boolean; children: ReactNode }) {
  return (
    <State label={label}>
      <div role="tabpanel" aria-label="File" className={`flex ${wide ? "h-120 w-200" : "h-64 w-120"} flex-col overflow-hidden rounded-surface border border-border bg-background`}>{children}</div>
    </State>
  );
}

const tree = (scope: string, change: Partial<Parameters<typeof FileTree>[0]> = {}) => (
  <FileTree scope={scope} listing={{ state: "listed", list: FILES }} marks={MARKS} results={null} onQuery={noop} onOpen={noop} {...change} />
);

/** The live tree beside the viewer: a click opens the file there, as the file tab will. */
function LiveFiles() {
  const [open, setOpen] = useState("src/pipeline.ts");
  return (
    <>
      <Panel label="live: open folders, search, click a file">
        <FilesView owner="g-files-live" shown={open} onOpen={(path) => setOpen(path)} />
      </Panel>
      <Tab label="live: the file it opened · ⌘F find · ⌃G go to line" wide>
        <FileViewer path={open} read={fakeRead(open)} active onReveal={noop} />
      </Tab>
    </>
  );
}

export function FilesGallery() {
  return (
    <>
      <Section title="Files">
        <Row name="Live">
          <LiveFiles />
        </Row>
        <Row name="Tree · change marks, folder dots, deleted struck through, ignored dimmed, the open file lit">
          <Panel label="marks and an ignored folder opened">
            {tree("g-files-marks", { defaultOpen: ["src", "src/upload", "src/tray", "docs", "node_modules"], loaded: IGNORED, shown: "src/upload/retry.ts" })}
          </Panel>
          <Panel label="closed folders">{tree("g-files-closed")}</Panel>
          <Panel label="capped: the old cap line">{tree("g-files-capped", { listing: { state: "listed", list: CAPPED } })}</Panel>
        </Row>
        <Row name="Filename search · name before path, ↑↓ and Enter">
          <Panel label="“retry”">{tree("g-files-search", { defaultQuery: "retry", results: findFiles(FILES, "retry") })}</Panel>
          <Panel label="no match">{tree("g-files-nomatch", { defaultQuery: "zzz", results: [] })}</Panel>
        </Row>
        <Row name="Loading, failed, empty [D30]">
          <Panel label="loading">{tree("g-files-loading", { listing: { state: "loading" } })}</Panel>
          <Panel label="failed: never “No files”">{tree("g-files-failed", { listing: { state: "failed", error: "git ls-files exited with status 128" } })}</Panel>
          <Panel label="an empty repo">{tree("g-files-empty", { listing: { state: "listed", list: { files: [], truncated: false, ignored: [] } }, marks: { files: {}, folders: {} } })}</Panel>
        </Row>
      </Section>
      <Section title="File viewer">
        <Row name="A long file: virtualised, coloured with pierre-dark, find and go to line">
          <Tab label="find “upload”: 1 of N, the current match stronger" wide>
            <FileViewer path="src/pipeline.ts" read={fakeRead("src/pipeline.ts")} active={false} onReveal={noop} defaultFind="upload" />
          </Tab>
          <Tab label="go to line (⌃G)" wide>
            <FileViewer path="src/pipeline.ts" read={fakeRead("src/pipeline.ts")} active={false} onReveal={noop} defaultGoing />
          </Tab>
          <Tab label="opened at line 42" wide>
            <FileViewer path="src/pipeline.ts" read={fakeRead("src/pipeline.ts")} line={42} active={false} onReveal={noop} />
          </Tab>
        </Row>
        <Row name="Messages · in the old words">
          <Tab label="truncated">
            <FileViewer path="src/pipeline.ts" read={fakeRead("src/pipeline.ts", { size: LONG_FILE.length * 4, truncated: true })} active={false} onReveal={noop} />
          </Tab>
          <Tab label="binary">
            <FileViewer path="assets/splash.png" read={{ state: "read", file: { size: 48_213, text: null, truncated: false } }} active={false} onReveal={noop} />
          </Tab>
          <Tab label="deleted or moved">
            <FileViewer path="src/old.ts" read={{ state: "gone", carried: false }} active={false} onReveal={noop} />
          </Tab>
          <Tab label="not in this session's copy">
            <FileViewer path="src/local-only.ts" read={{ state: "gone", carried: true }} active={false} onReveal={noop} />
          </Tab>
          <Tab label="failed">
            <FileViewer path="src/upload/retry.ts" read={{ state: "failed", error: "Couldn't read src/upload/retry.ts: permission denied" }} active={false} onReveal={noop} />
          </Tab>
          <Tab label="loading [D30]">
            <FileViewer path="src/upload/retry.ts" read={{ state: "loading" }} active={false} onReveal={noop} />
          </Tab>
        </Row>
      </Section>
    </>
  );
}
