// Step 2.13 on fake data: the PR tab, the two thread rows and the sidebar chip [D1017, D1018, D1031].
import { useState } from "react";

import { NavList } from "../src/components/nav";
import type { AgentChip } from "../src/landing/agent-chip";
import type { PrChipState } from "../src/landing/pr-chip";
import type { Sends } from "../src/landing/pr-parts";
import { type PrView, PrTab } from "../src/landing/pr-tab";
import { blockers, eventWords } from "../src/landing/pr-words";
import { type PrSend, type PullRequest, sendKey } from "../src/landing/pull-requests";
import { ChecksFailedRow, MergedRow, type Revert } from "../src/landing/thread-rows";
import { SessionRowItem } from "../src/sidebar/row";
import type { SessionRow } from "../src/sidebar/words";
import { ChipsComposer, TabFrame } from "./landing-parts";
import { Held, Row, Section, State } from "./parts";
import { PROJECTS } from "./sidebar";

const NOW = new Date(2026, 10, 10, 14, 32).getTime();
const min = (n: number) => NOW - n * 60_000;
const LOG = "FAIL src/upload/retry.test.ts > backs off between tries\n  expected 200 to be 400 // the second wait\n  at retry.test.ts:41:18";

const FAILING: PullRequest = {
  id: "pr12",
  number: 12,
  title: "Retry failed uploads",
  host: "GitHub",
  state: "open",
  ci: "failing",
  review: "changes_requested",
  changesBy: ["sam-k"],
  mergeable: true,
  branch: "brigadier/912a9469/session",
  base: "main",
  openedBy: "the agent",
  openedAtMs: min(14),
  checkedAtMs: NOW - 20_000,
  problem: null,
  checks: [
    { id: "k1", name: "test (ubuntu-latest)", state: "failed", durationMs: 133_000, logTail: LOG },
    { id: "k2", name: "deploy-preview", state: "running", durationMs: 62_000, logTail: null },
    { id: "k3", name: "lint", state: "passed", durationMs: 31_000, logTail: null },
    { id: "k4", name: "build", state: "passed", durationMs: 108_000, logTail: null },
  ],
  comments: [
    { id: "m1", author: "sam-k", path: "client.ts", line: 88, body: "Don't retry on a 4xx: those won't get better.", atMs: min(6) },
    { id: "m2", author: "sam-k", path: "retry.ts", line: 12, body: "Cap the wait, or a long outage waits minutes.", atMs: min(5) },
  ],
  events: [
    { id: "e5", atMs: min(4), kind: "changes_requested", actor: "sam-k", detail: "2 comments" },
    { id: "e4", atMs: min(6), kind: "checks_failed", actor: "CI", detail: "test (ubuntu-latest)" },
    { id: "e3", atMs: min(12), kind: "pushed", actor: "the agent", detail: "2 commits" },
    { id: "e1", atMs: min(14), kind: "opened", actor: "the agent", detail: null },
  ],
};
const passed = FAILING.checks.map((check) => ({ ...check, state: "passed" as const, logTail: null, durationMs: check.durationMs ?? 40_000 }));
const READY: PullRequest = {
  ...FAILING,
  ci: "passing",
  review: "approved",
  changesBy: [],
  checks: passed,
  comments: [],
  events: [{ id: "e6", atMs: min(2), kind: "approved", actor: "sam-k", detail: null }, { id: "e7", atMs: min(3), kind: "checks_passed", actor: "CI", detail: null }, ...FAILING.events.slice(2)],
};
const MERGED: PullRequest = { ...READY, state: "merged", events: [{ id: "e8", atMs: min(1), kind: "merged", actor: "you", detail: "squash" }, ...READY.events] };
const STALE: PullRequest = {
  ...FAILING,
  ci: "pending",
  review: "required",
  changesBy: [],
  comments: [],
  checkedAtMs: min(5),
  problem: "GitHub CLI is signed out. Run gh auth login, then Check now.",
  checks: FAILING.checks.map((check) => ({ ...check, state: "running" as const, logTail: null })),
};
const FRESH: PullRequest = { ...FAILING, ci: "none", review: "required", changesBy: [], checks: [], comments: [], events: [] };

/** What a Send leaves: the chip's words come from the PR's data. Gallery only until the composer carries chips. */
function chipFor(pr: PullRequest, send: PrSend): AgentChip {
  const id = sendKey(send);
  if (send.kind === "fix") return { id, kind: "fix", pr: pr.number, reasons: (blockers(pr) ?? "").replace("Can't merge yet: ", "").replace(/\.$/, "") };
  if (send.kind === "check") return { id, kind: "check", pr: pr.number, name: pr.checks.find((check) => check.id === send.id)?.name ?? "" };
  if (send.kind === "comment") {
    const comment = pr.comments.find((each) => each.id === send.id)!;
    return { id, kind: "comment", pr: pr.number, author: comment.author, where: comment.path && `${comment.path}:${comment.line}`, body: comment.body };
  }
  const event = pr.events.find((each) => each.id === send.id)!;
  return { id, kind: "event", pr: pr.number, what: eventWords(event), detail: [event.actor, event.detail].filter(Boolean).join(" · ") };
}

const sends = (added: string[] = [], offline = false): Sends => ({ now: NOW, offline, added: new Set(added), onSend: () => {}, onOpen: () => {} });
const noop = () => {};

/** The tab live: each Send adds its chip and reads Added; Merge asks, then merges a moment later. */
function Live() {
  const [pr, setPr] = useState(FAILING);
  const [chips, setChips] = useState<AgentChip[]>([]);
  const [merging, setMerging] = useState(false);
  const live: Sends = {
    ...sends(chips.map((chip) => chip.id)),
    onSend: (send) => setChips((now) => (now.some((chip) => chip.id === sendKey(send)) ? now : [...now, chipFor(pr, send)])),
  };
  return (
    <div className="flex flex-col gap-3">
      <div className="flex gap-2">
        {([["Checks failed", FAILING], ["Ready", READY]] as const).map(([label, next]) => (
          <button key={label} type="button" className="rounded-control bg-fill px-2 py-1 text-xs" onClick={() => setPr(next)}>
            {label}
          </button>
        ))}
      </div>
      <TabFrame tall>
        <PrTab
          pr={pr}
          merging={merging}
          sends={live}
          onMerge={() => {
            setMerging(true);
            setTimeout(() => {
              setMerging(false);
              setPr(MERGED);
            }, 1000);
          }}
        />
      </TabFrame>
      <ChipsComposer chips={chips} onRemove={(id) => setChips((now) => now.filter((chip) => chip.id !== id))} />
    </div>
  );
}

function Tab({ pr, view, ...rest }: { pr: PullRequest | undefined; view?: PrView; error?: string; offline?: boolean; added?: string[]; merging?: boolean; mergeError?: string }) {
  return (
    <TabFrame tall>
      <PrTab pr={pr} view={view} error={rest.error} merging={rest.merging} mergeError={rest.mergeError} sends={sends(rest.added, rest.offline)} onMerge={noop} />
    </TabFrame>
  );
}

const sessionRow = (id: string, title: string, pr: PrChipState | null): SessionRow => ({ id, title, state: "idle", mark: null, resets: null, sent: 0, finished: 0, project: "p1", pr });
const CHIPS: [string, PrChipState][] = [
  ["Retry failed uploads", { chip: "checks_failed", prs: [{ number: 12, mark: "checks_failed" }] }],
  ["Fix the login form", { chip: "changes_asked", prs: [{ number: 9, mark: "changes_asked" }] }],
  ["Add dark mode", { chip: "ready", prs: [{ number: 7, mark: "ready" }] }],
  ["Upload progress in tray", { chip: "merged", prs: [{ number: 5, mark: "merged" }] }],
];
const TWO: PrChipState = { chip: "checks_failed", prs: [{ number: 14, mark: "checks_failed" }, { number: 12, mark: "merged" }] };

function SideRow({ row, held }: { row: SessionRow; held?: HTMLElement }) {
  return <SessionRowItem row={row} project={PROJECTS[0]} tone={0} active={false} held={held} onOpen={noop} onRename={noop} />;
}

export function PullRequestsGallery() {
  const [revert, setRevert] = useState<Revert>({ state: "none" });
  const [archived, setArchived] = useState(false);
  return (
    <Section title="Pull requests: tab, thread rows, sidebar chip (step 2.13)">
      <Row name="live: every Send and Fix with agent leaves a chip and sends nothing; Merge asks first">
        <State label="the PR tab and the composer">
          <Live />
        </State>
      </Row>
      <Row name="the tab's four parts, on a PR whose checks failed and whose reviewer asked for changes">
        {(["overview", "checks", "comments", "timeline"] as const).map((view) => (
          <State key={view} label={view}>
            <Tab pr={FAILING} view={view} />
          </State>
        ))}
      </Row>
      <Row name="ready · merging · merge failed · merged · sends already added">
        <State label="ready">
          <Tab pr={READY} />
        </State>
        <State label="merging">
          <Tab pr={READY} merging />
        </State>
        <State label="merge failed">
          <Tab pr={READY} mergeError="the base branch moved; Check now, then try again" />
        </State>
        <State label="merged · timeline">
          <Tab pr={MERGED} view="timeline" />
        </State>
        <State label="Fix and a comment added">
          <Tab pr={FAILING} added={["fix", "comment:m1"]} />
        </State>
      </Row>
      <Row name="loading · couldn't load · can't watch (last state, its age, why) · just opened, nothing yet · disconnected">
        <State label="loading">
          <Tab pr={undefined} />
        </State>
        <State label="couldn't load">
          <Tab pr={undefined} error="Couldn't read #12: the host didn't answer" />
        </State>
        <State label="can't watch">
          <Tab pr={STALE} />
        </State>
        <State label="empty · checks">
          <Tab pr={FRESH} view="checks" />
        </State>
        <State label="empty · timeline">
          <Tab pr={FRESH} view="timeline" />
        </State>
        <State label="disconnected">
          <Tab pr={FAILING} offline />
        </State>
      </Row>
      <Row name="thread rows: checks failed (Send to agent, Open) · merged (Revert, Archive), live">
        <State label="checks failed">
          <ChecksFailedRow number={12} checks={["test (ubuntu-latest)"]} onSend={noop} onOpen={noop} />
        </State>
        <State label="its chip added">
          <ChecksFailedRow number={12} checks={["test (ubuntu-latest)"]} added onSend={noop} onOpen={noop} />
        </State>
        <State label="disconnected">
          <ChecksFailedRow number={12} checks={["test (ubuntu-latest)", "lint"]} offline onSend={noop} onOpen={noop} />
        </State>
        <State label="merged, live: Revert, then Archive">
          <MergedRow
            base="main"
            commits={3}
            revert={revert}
            archived={archived}
            onRevert={() => {
              setRevert({ state: "pending" });
              setTimeout(() => setRevert({ state: "done" }), 1000);
            }}
            onArchive={() => setArchived(true)}
          />
        </State>
        <State label="revert failed">
          <MergedRow base="main" commits={1} revert={{ state: "failed", error: "it conflicts in src/upload/retry.ts" }} onRevert={noop} onArchive={noop} />
        </State>
      </Row>
      <Row name="sidebar chip: each state · two PRs, the one that needs you wins and the hover lists both · merged, then seen">
        <State label="each state">
          <NavList className="w-60">
            {CHIPS.map(([title, pr], at) => (
              <SideRow key={title} row={sessionRow(`c${at}`, title, pr)} />
            ))}
            <SideRow row={sessionRow("c9", "Speed up cold start", null)} />
          </NavList>
        </State>
        <State label="two PRs, hovered">
          <Held className="h-40 w-140">
            {(box) => (
              <NavList className="w-60">
                <SideRow row={sessionRow("two", "Retry failed uploads", TWO)} held={box} />
              </NavList>
            )}
          </Held>
        </State>
        <State label="merged, then seen or new work: gone">
          <NavList className="w-60">
            <SideRow row={sessionRow("m1", "Retry failed uploads", CHIPS[3]![1])} />
            <SideRow row={sessionRow("m2", "Retry failed uploads", null)} />
          </NavList>
        </State>
      </Row>
    </Section>
  );
}
