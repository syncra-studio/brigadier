import { type ReactNode, useState } from "react";

import { PrListView, type View } from "../src/landing/pr-list";
import type { Sends } from "../src/landing/pr-parts";
import { PrTab } from "../src/landing/pr-tab";
import type { PrCheck, PullRequest } from "../src/landing/pull-requests";
import type { Pr } from "../src/panel/types";
import { Section } from "./parts";

const NOW = Date.parse("2026-11-17T13:00:00Z");
const WEEK = NOW - 7 * 86400_000;

const CLOSED: [number, string][] = [
  [865, "A worker's hand-off reaches its session with no extra turn and needs no prompt; rows show the 200k point; token totals count compactions"],
  [864, "A reply Claude writes as a second thinking block shows in the thread and in brigadier transcript"],
  [863, "Workers follow the thread's cycle at 200k and never lose their task; state shows real token counts"],
  [859, "A hang left behind by a command reads Stalled even beside a chatty watcher; a worker ends its turn on its shown result; a faked load says so"],
  [858, "A stalled background command and a starved build show on the worker's row and wake its orchestrator once; workers are told a running result comes first"],
  [855, "A first launch no longer stalls on the startup screen while its window is covered"],
  [856, "A queued compile takes whichever build slot frees first instead of waiting behind one busy slot"],
  [851, "The sidebar is one list with a View control: group by project, choose what shows, and see each project's own icon"],
  [854, "Plugins gets a Refresh that asks about new and gone skills and MCP servers, and new ones stay off until you choose"],
  [853, "MCP sign-in works for servers that advertise a parent URL as their resource, such as Steady"],
  [850, "The MCP sign-in sync stops causing Keychain password prompts for Claude's login items, and repairs the items it already broke"],
  [848, "Worker and Background row buttons lay over the row on hover, worker files sit right under their row in Source, and they show at once on coming back to the tab"],
  [847, "The nightly's computer-use format check passes again, and CI now runs it on every pull request"],
  [842, "A message sent to a worker during a hand-off survives a restart, a usage limit or a hung note turn, and pause and switch stop answering try again forever"],
  [845, "A turn that ends during its send stays reported, an extra account's MCP header on a login variable reaches its server, and a Claude settings file doesn't outlive a failed start or exit"],
  [838, "A context refresh while workers run leaves one live work block, and a follow-up to a paused or stopped block goes right in"],
  [844, "An app preview started with pnpm tauri:dev now reads as ready once its window opens"],
];

const row = (number: number, title: string, state: Pr["state"], draft = false): Pr => ({
  number,
  title,
  state,
  draft,
  health: "ready",
  failed: 0,
  author: "stephen-golban",
  createdAtMs: WEEK,
  updatedAtMs: WEEK,
});
const OPEN_ROWS = [row(862, "Rebuild the in-app browser on Electron", "open", true)];
const CLOSED_ROWS = CLOSED.map(([n, t]) => row(n, t, "merged"));

const checks = (names: string[], state: PrCheck["state"]): PrCheck[] => names.map((name) => ({ id: name, name, state, durationMs: null, logTail: null, url: null }));
const PASS_8 = checks(["Clippy (Windows)", "Computer use live test (Linux)", "Linux app, launch smoke check", "Format, bindings, typecheck, lint", "App tests", "Rust tests (Linux)", "Clippy (Linux)", "Approval before code"], "passed");

const base: PullRequest = {
  id: "865",
  number: 865,
  repo: "syncra-studio/brigadier-ai",
  title: CLOSED[0][1],
  url: "",
  head: "abc",
  host: "GitHub",
  state: "merged",
  status: "merged",
  blockers: null,
  branch: "brigadier/05966928/task-4-proof-run-fixes",
  base: "main",
  openedBy: "stephen-golban",
  openedAtMs: WEEK,
  checkedAtMs: NOW - 120_000,
  problem: null,
  checks: PASS_8,
  comments: [],
  events: [],
  body: [
    "Fixes from the live runs of the workers' 200k cycle.",
    "",
    '- A paused worker\'s line reads "Paused", since the session may have paused it and not the user.',
    "- A worker's hand-off reaches its session on the next wake, as one line, with no turn of its own.",
    "- A worker writes its own hand-off note unasked at every permission level. Only `handoff/<digits>.md` in its own record folder and an exact `mkdir -p` of that folder pass; anything else still asks.",
    "- Worker rows show context against the 200k point, not the CLI's window.",
    "- Claude's compaction calls count in token totals, from the gap in cumulative `modelUsage`.",
    "- A Codex resume no longer records the previous call again.",
    "",
    "Limits:",
    "",
    "- Codex reports nothing for its compaction calls, and the token table says so.",
    "- A Claude compaction in a CLI process's first turn stays uncounted.",
  ].join("\n"),
  additions: 497,
  deletions: 43,
  files: 17,
  commitCount: 6,
  commits: [],
  reviewers: [],
  mergeState: null,
  onBranch: false,
};

const DRAFT: PullRequest = {
  ...base,
  id: "862",
  number: 862,
  title: "Rebuild the in-app browser on Electron",
  state: "draft",
  status: "checks_failed",
  branch: "brigadier/825c4fad/session",
  checks: [
    ...checks(["Real pages (macOS Intel)", "Rust tests (Linux)", "Clippy (Windows)", "App tests", "Clippy (Linux)", "Format, bindings, typecheck, lint"], "failed"),
    ...checks(["Real pages (macOS Apple silicon)", "Real pages (Linux)", "Real pages (Windows)", "Linux app, launch smoke check", "Computer use live test (Linux)", "Approval before code"], "passed"),
  ],
  body: [
    "Work in progress, not for merging yet: Brigadier's in-app browser rebuilt on an Electron shell, with the Rust core and React interface kept. This PR exists so CI runs on Windows and Linux.",
    "",
    "Landed so far: the shell move, section 1 (a live browser), section 2 (Brigadier drives a tab), section 3 (no passwords for agents), section 4 (profiles), Google sign-in, the page security boundary, and the helper and DMG size cuts.",
    "",
    "Still to come: import, passwords and bookmarks, the rest of sign-ins, site permissions, development tools, everyday data, and security and shipping, which includes real-page CI on all three OSes.",
  ].join("\n"),
};

/** An open PR with reviews and line comments, for the sections drawn empty. */
const REVIEWED: PullRequest = {
  ...base,
  id: "870",
  number: 870,
  title: "Pull requests and a pull request, drawn in this layout",
  state: "open",
  status: "changes_requested",
  blockers: { failedChecks: 1, changesBy: ["mira-k"], conflicts: false },
  branch: "brigadier/w70/pr-tabs",
  checks: [...checks(["App tests"], "failed"), ...checks(["Rust tests (Linux)"], "running"), ...PASS_8.slice(0, 5)],
  reviewers: [
    { login: "mira-k", state: "changes" },
    { login: "dan-ortiz", state: "approved" },
    { login: "lee-park", state: "requested" },
  ],
  comments: [
    { id: "c1", author: "mira-k", path: "app/ui/src/landing/pr-list-view.tsx", line: 42, body: "The row's time should be the last update, not when it was opened.", atMs: NOW - 3 * 3600_000, url: null },
    { id: "c2", author: "dan-ortiz", path: "crates/core/src/host/search.rs", line: 21, body: "`additions deletions` cost nothing in the same read; fine to add.", atMs: NOW - 2 * 3600_000, url: null },
    { id: "r1", author: "mira-k", path: null, line: null, body: "One thing before this lands.", atMs: NOW - 3 * 3600_000, url: null },
    { id: "c3", author: "lee-park", path: null, line: null, body: "Is the narrow layout's menu in the gallery too?", atMs: NOW - 3600_000, url: null },
  ],
  labels: ["enhancement", "ui"],
  timeline: [
    { kind: "review", id: "r1", atMs: NOW - 3 * 3600_000, actor: "mira-k", state: "changes", was: null, said: true, threads: [{ id: "t1", path: "app/ui/src/landing/pr-list.tsx", resolved: false, outdated: false, comments: ["c1"] }] },
    { kind: "review", id: "r2", atMs: NOW - 2 * 3600_000, actor: "dan-ortiz", state: "approved", was: null, said: false, threads: [{ id: "t2", path: "crates/core/src/host/search.rs", resolved: true, outdated: false, comments: ["c2"] }] },
    { kind: "comment", id: "c3", atMs: NOW - 3600_000, actor: "lee-park" },
  ],
  body: "The Pull requests tab and the Pull request tab take this layout, in our kit [D609].",
  additions: 412,
  deletions: 268,
  files: 6,
};

const SENDS: Sends = { now: NOW, offline: false, onOpen: () => {} };
type Found = { query: string; okAt: number | null; error: string | null; prs: Pr[]; next: string | null };
const found = (prs: Pr[], more = false): Found => ({ query: "", okAt: NOW - 120_000, error: null, prs, next: more ? "next" : null });

function Still({ name, children, height = "h-160" }: { name: string; children: ReactNode; height?: string }) {
  return (
    <div data-still={name} className={`flex w-275 flex-col overflow-hidden rounded-surface border border-border bg-background ${height}`}>
      {children}
    </div>
  );
}

function List({ list, closed = false, view = "all", busy = false }: { list: Found | null; closed?: boolean; view?: View; busy?: boolean }) {
  const [v, setV] = useState<View>(view);
  const [c, setC] = useState(closed);
  const [linked, setLinked] = useState(false);
  const [text, setText] = useState("");
  return (
    <PrListView
      found={list}
      now={NOW}
      view={v}
      linked={linked}
      closed={c}
      text={text}
      busy={busy}
      more={false}
      sessions={[]}
      onView={setV}
      onLinked={setLinked}
      onClosed={setC}
      onText={setText}
      onRefresh={() => {}}
      onMore={() => {}}
      onOpen={() => {}}
    />
  );
}

const tab = (pr: PullRequest) => <PrTab owner="gallery" target={String(pr.number)} pr={pr} row={undefined} checking={false} sends={SENDS} onCheck={() => {}} onBring={() => {}} />;

/** The Pull requests tab and a Pull request tab, on sample PRs [D609, D613]. */
export function PrsGallery() {
  return (
    <Section title="Pull requests in this layout">
      <Still name="list-open">
        <List list={found(OPEN_ROWS)} />
      </Still>
      <Still name="list-closed">
        <List list={found(CLOSED_ROWS, true)} closed />
      </Still>
      <Still name="list-empty">
        <List list={found([])} view="review" />
      </Still>
      <Still name="list-loading">
        <List list={null} busy />
      </Still>
      <Still name="list-error">
        <List list={{ ...found([]), okAt: null, error: "gh: Could not resolve to a Repository" }} />
      </Still>
      <Still name="pr-merged" height="h-220">
        {tab(base)}
      </Still>
      <Still name="pr-draft-checks-failed" height="h-220">
        {tab(DRAFT)}
      </Still>
      <Still name="pr-open-reviewed" height="h-275">
        {tab(REVIEWED)}
      </Still>
    </Section>
  );
}
