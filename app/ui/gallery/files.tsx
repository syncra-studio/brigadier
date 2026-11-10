// The right panel's Files and Search, and the file viewer [D1002, D1003]: each state frozen on fake data, plus live copies.
import { useState, type ReactNode } from "react";

import { ConfirmForm } from "../src/components/confirm-dialog";
import { Dialog, DialogContent } from "../src/components/dialog";
import { CAPPED, FILES, fakeRead, findFiles, IGNORED, LONG_FILE, MARKS, searchFake } from "../src/files/fake";
import { EMPTY_FORM, replaceDescription, replaceTitle, SearchPanel, searchQuery, type SearchForm } from "../src/files/search";
import { FileTree } from "../src/files/tree";
import type { SearchResults } from "../src/files/types";
import { FileViewer } from "../src/files/viewer";
import { FilesView, SearchView } from "./files-live";
import { Held, Row, Section, State } from "./parts";

const noop = () => {};
const never = () => new Promise<never>(noop);

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

const form = (change: Partial<SearchForm>): SearchForm => ({ ...EMPTY_FORM, ...change });
const found = (search: SearchForm, change: Partial<SearchResults> = {}): SearchResults => ({ ...searchFake(searchQuery(search)!), ...change });
const RETRY = form({ text: "retry", replace: "withRetry" });
const RETRY_FOUND = found(RETRY);
const RETRY_MATCHES = RETRY_FOUND.files.reduce((sum, file) => sum + file.matches, 0);

function search(label: string, fields: SearchForm, results: SearchResults | null, change: Partial<Parameters<typeof SearchPanel>[0]> = {}) {
  return (
    <Panel label={label}>
      <SearchPanel form={fields} onForm={noop} results={results} onSearch={noop} onReplace={never} onDismiss={noop} onOpen={noop} {...change} />
    </Panel>
  );
}

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
          <Tab label="opened at line 42, from a search result" wide>
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
      <Section title="Search">
        <Row name="Live: type, options, dismiss, Replace all (fake checkout)">
          <Panel label="live">
            <SearchView owner="g-search-live" />
          </Panel>
        </Row>
        <Row name="Kit · menu · empty, results, filters shown: the options icon's dot while any option is on [D1106]">
          {search("empty", form({}), null)}
          {search("results", RETRY, found(RETRY))}
          {search("filters shown, match case on", form({ text: "retry", matchCase: true, include: "src/upload", details: true }), found(form({ text: "retry", matchCase: true, include: "src/upload", details: true })))}
          {search("searching", form({ text: "upload" }), { query: { ...form({ text: "upload" }), text: "upload" }, files: [], done: null, error: null, filteredFiles: 0 })}
        </Row>
        <Row name="Replace all · confirm, done, refused">
          <State label="confirm, in the old words">
            <Held className="h-56 w-120 overflow-hidden rounded-surface">
              {(box) => (
                <Dialog open modal={false}>
                  <DialogContent container={box} initialFocus={false}>
                    <ConfirmForm title={replaceTitle(RETRY_MATCHES, RETRY_FOUND.files.length)} description={replaceDescription("withRetry")} confirm="Replace" onConfirm={noop} onCancel={noop} />
                  </DialogContent>
                </Dialog>
              )}
            </Held>
          </State>
          {search("replaced", RETRY, found(RETRY), { defaultOutcome: { files: RETRY_FOUND.files.length, matches: RETRY_MATCHES, skipped: [], unrestored: [] } })}
          {search("a file changed since the search", RETRY, found(RETRY), {
            defaultOutcome: {
              files: 0,
              matches: 0,
              skipped: [{ path: "src/upload/client.ts", reason: "it changed since the search" }],
              unrestored: [{ path: "src/upload/retry.ts", reason: "its text from before is in src/upload/.retry.ts.replaced-1" }],
            },
          })}
        </Row>
        <Row name="Empty and errors">
          {search("no results", form({ text: "nowhere" }), found(form({ text: "nowhere" })))}
          {search("all dismissed", RETRY, { ...found(RETRY), files: [], filteredFiles: 2 })}
          {search("capped", RETRY, found(RETRY, { done: { capped: true } }))}
          {search("an invalid pattern", form({ text: "(", regex: true }), found(form({ text: "(", regex: true })))}
        </Row>
      </Section>
    </>
  );
}
