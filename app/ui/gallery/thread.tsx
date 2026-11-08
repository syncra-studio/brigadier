// Slice 4's thread rows in every state, on fake items. The live copies tick: the
// answer streams, the work header counts, the group's running step changes, the shell output grows.
import { type ReactNode, useEffect, useRef, useState } from "react";

import { Body } from "../src/components/thread/body";
import { JumpSign, UserBubble } from "../src/components/thread/message";
import { GroupRow, WorkHeader, WorkingLine } from "../src/components/thread/work";
import type { FileChange, Item, Progress, StepKind, Turn } from "../src/thread/item";
import type { Group } from "../src/thread/lines";
import "../src/thread/markdown.css";
import { Row, Section, State } from "./parts";

const NOW = Date.now();
const RUNNING: Turn = { id: "t-run", status: "running", startedAt: NOW - 12_000, endedAt: null };
const DONE: Turn = { id: "t-done", status: "done", startedAt: NOW - 184_000, endedAt: NOW };
const WORK = { turnId: DONE.id, ms: 184_000, folded: [0, 0] as [number, number] };
const noop = () => {};

const base = (id: string, turn = DONE) => ({ id, turnId: turn.id });
const tool = (id: string, step: StepKind, name: string, input: string, progress: Progress, more: Partial<Extract<Item, { kind: "tool" }>> = {}): Item => ({
  ...base(id),
  kind: "tool",
  step,
  name,
  input,
  output: "",
  progress,
  exitCode: null,
  ...more,
});
const file = (path: string, change: FileChange["change"], added: number | null, removed: number | null, from: string | null = null): FileChange => ({
  path,
  change,
  from,
  added,
  removed,
  diff: DIFF,
});

const DIFF = `--- a/src/blocks.ts
+++ b/src/blocks.ts
@@ -12,7 +12,9 @@ export function blocks(text: string) {
   const tokens = lexer(text);
-  return tokens.map(draw);
+  // Only the last block draws again while a reply streams.
+  const shown = tokens.filter((token) => token.type !== "space");
+  return shown.map(draw);
 }`;

/** A diff long enough to fold. */
const LONG_DIFF = `--- a/src/thread/rows.tsx
+++ b/src/thread/rows.tsx
@@ -1,20 +1,22 @@
${Array.from({ length: 20 }, (_, i) => (i % 5 === 2 ? `-  const old${i} = draw(${i});\n+  const row${i} = draw(${i}, { keep });` : `   const line${i} = ${i};`)).join("\n")}`;

const OUTPUT = Array.from({ length: 24 }, (_, i) => `✓ test ${i + 1} passes (${(i * 7) % 40}ms)`).join("\n");
const LONG_OUTPUT = Array.from({ length: 900 }, (_, i) => `line ${i + 1}`).join("\n");

const REPLY = `## What changed

The list now draws **only the last block** while a reply streams, so long answers stay smooth. See [the plan](https://example.com) and \`rows.tsx\`.

- Blocks split with \`marked\`, drawn with react-markdown
- Code blocks fold past 14 lines

> Folded code draws only the lines on show.

| File | Change |
| --- | --- |
| blocks.ts | +2 −1 |
| rows.tsx | new |

\`\`\`ts
export function blocks(text: string) {
  const tokens = lexer(text);
  return tokens.map(draw);
}
\`\`\``;

const LONG_CODE = "```bash\n" + Array.from({ length: 30 }, (_, i) => `echo "step ${i + 1}"`).join("\n") + "\n```";

/** A running subagent's own steps, one a second. */
const SUBAGENT_STEPS: { step: StepKind; input: string }[] = [
  { step: "read", input: "src/thread/lines.ts" },
  { step: "search", input: "“toLines” in src" },
  { step: "read", input: "src/thread/item.ts" },
  { step: "run", input: "pnpm typecheck" },
];
/** A subagent that ran from a minute ago for 1m 2s in 12 steps, with its answer; each state overrides what it lacks. */
const agent = (id: string, progress: Progress): Extract<Item, { kind: "childAgent" }> => ({
  ...base(id, progress === "running" || progress === "pending" ? RUNNING : DONE),
  kind: "childAgent",
  sessionId: "s2",
  title: "Find the parser",
  progress,
  startedAt: NOW - 60_000,
  endedAt: NOW + 2_000,
  current: null,
  steps: 12,
  answer: "The parser lives in src/thread/lines.ts: `toLines` folds items into lines, and `workKey` names a turn's fold.",
});

const USER = "Can you make the thread rows match the old app, and check the shell box against a failing test?";
const MD_USER = "Two things:\n1. Make **the bubble** render `inline code`\n2. Keep each line\nas typed";
const CODE_USER = [
  ...Array.from({ length: 16 }, (_, i) => `Line ${i + 1} before the code.`),
  "```ts",
  ...Array.from({ length: 8 }, (_, i) => `const step${i + 1} = ${i + 1};`),
  "```",
  "After the code.",
].join("\n");
const LONG_USER = Array.from({ length: 28 }, (_, i) => `Line ${i + 1} of a long pasted message.`).join("\n");

/** Ticks once a second while the gallery is open: the live copies' clock. */
function useTick(): number {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const timer = window.setInterval(() => setTick((t) => t + 1), 1000);
    return () => window.clearInterval(timer);
  }, []);
  return tick;
}

/** Holds its row open: clicks the closed toggle inside it once, as a user would. */
function Opened({ children }: { children: ReactNode }) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // A moment later: a toggle that shows only once its row has measured itself (a long message's Show more).
    const timer = setTimeout(() => box.current?.querySelector<HTMLElement>('[aria-expanded="false"]')?.click(), 200);
    return () => clearTimeout(timer);
  }, []);
  return (
    <div ref={box} className="w-full">
      {children}
    </div>
  );
}

/** A state as wide as the thread's column allows. */
function Wide({ label, frozen, open, children }: { label: string; frozen?: string; open?: boolean; children: ReactNode }) {
  return (
    <div className="flex w-full max-w-reading min-w-0 flex-col gap-2">
      <span className="text-2xs text-muted-foreground">{label}</span>
      <div data-frozen={frozen} className="flex w-full min-w-0 flex-col">
        {open ? <Opened>{children}</Opened> : children}
      </div>
    </div>
  );
}

const item = (it: Item, turn: Turn = DONE, step = false) => <Body item={it} turn={turn} step={step} />;

const GROUP: Group = { ...base("g1"), kind: "group", steps: [{ kind: "read", n: 4 }, { kind: "edit", n: 3 }, { kind: "run", n: 2 }], span: [0, 0] };
const LIVE_STEPS: Item[] = [
  tool("live-1", "read", "read", "src/thread/blocks.ts", "running"),
  tool("live-2", "search", "rg", "“useKept” in src", "running"),
  tool("live-3", "run", "shell", "pnpm typecheck", "running"),
  { ...base("live-4"), kind: "fileChange", progress: "running", changes: [file("src/thread/rows.tsx", "modified", null, null)] },
];

export function Thread() {
  const tick = useTick();
  const streamed = REPLY.slice(0, Math.min(REPLY.length, ((tick % 30) + 1) * 40));
  const grown = OUTPUT.split("\n")
    .slice(0, (tick % 24) + 1)
    .join("\n");
  return (
    <>
      <Section title="Thread · work header · group · working line">
        <Row name="working (ticking) · waiting (ticking) · worked, shut · worked and waited · open · hover · focus">
          <Wide label="running">
            <WorkHeader turn={RUNNING} work={undefined} open={null} onToggle={noop} />
          </Wide>
          <Wide label="waiting on your answer">
            <WorkHeader turn={{ ...RUNNING, waitingSince: NOW - 63_000 }} work={undefined} open={null} onToggle={noop} />
          </Wide>
          <Wide label="done, shut">
            <WorkHeader turn={DONE} work={WORK} open={false} onToggle={noop} />
          </Wide>
          <Wide label="done, waited">
            <WorkHeader turn={{ ...DONE, waitedMs: 62_000 }} work={WORK} open={false} onToggle={noop} />
          </Wide>
          <Wide label="done, open">
            <WorkHeader turn={DONE} work={WORK} open onToggle={noop} />
          </Wide>
          <Wide label="hover" frozen="hover">
            <WorkHeader turn={DONE} work={WORK} open={false} onToggle={noop} />
          </Wide>
          <Wide label="focus" frozen="focus">
            <WorkHeader turn={DONE} work={WORK} open={false} onToggle={noop} />
          </Wide>
        </Row>
        <Row name="group: shut · open · hover · focus · live (its running step, changing each second)">
          <State label="shut">
            <GroupRow item={GROUP} live={undefined} open={false} onToggle={noop} />
          </State>
          <State label="open">
            <GroupRow item={GROUP} live={undefined} open onToggle={noop} />
          </State>
          <State label="hover" frozen="hover">
            <GroupRow item={GROUP} live={undefined} open={false} onToggle={noop} />
          </State>
          <State label="focus" frozen="focus">
            <GroupRow item={GROUP} live={undefined} open={false} onToggle={noop} />
          </State>
          <State label="live">
            <GroupRow item={GROUP} live={LIVE_STEPS[tick % LIVE_STEPS.length]} open={false} onToggle={noop} />
          </State>
        </Row>
        <Row name="working line: live · stalled · interrupted · disconnected · thinking · thinking with a heading">
          <State label="live">
            <WorkingLine state="live">Thinking</WorkingLine>
          </State>
          <State label="stalled">
            <WorkingLine state="stalled">No reply for 2m · still waiting</WorkingLine>
          </State>
          <State label="interrupted">
            <WorkingLine state="interrupted">Interrupted after 12s</WorkingLine>
          </State>
          <State label="disconnected">
            <WorkingLine state="disconnected">{`Unknown · last seen working ${12 + tick}s ago`}</WorkingLine>
          </State>
          <State label="thinking">{item({ ...base("r1", RUNNING), kind: "reasoning", text: "", streaming: true }, RUNNING)}</State>
          <State label="heading">{item({ ...base("r2", RUNNING), kind: "reasoning", text: "", streaming: true, heading: "Checking the row recipe" }, RUNNING)}</State>
        </Row>
      </Section>
      <Section title="Thread · tool steps · shell box">
        <Row name="steps by kind: read · search · web · subagent · other · failed · stopped · waiting · in an opened group">
          <Wide label="done, by kind; hover; focus">
            <div className="flex flex-col gap-1">
              {item(tool("k-read", "read", "read", "src/thread/blocks.ts", "done", { output: "…" }))}
              {item(tool("k-search", "search", "rg", "“useKept” in src", "done", { output: "3 matches" }))}
              {item(tool("k-web", "web", "web_search", "base ui collapsible", "done", { output: "8 pages" }))}
              {item(tool("k-agent", "agent", "task", "Find the parser", "done", { output: "Found it in lines.ts" }))}
              {item(tool("k-other", "other", "linear.search_issues", "{ \"query\": \"thread\" }", "done", { output: "[]" }))}
              <div data-frozen="hover">{item(tool("k-hover", "read", "read", "src/thread/rows.tsx", "done", { output: "…" }))}</div>
              <div data-frozen="focus">{item(tool("k-focus", "read", "read", "src/thread/rows.tsx", "done", { output: "…" }))}</div>
            </div>
          </Wide>
          <Wide label="running · failed · stopped · waiting · in a group (in 41s)">
            <div className="flex flex-col gap-1">
              {item(tool("s-run", "read", "read", "src/thread/words.ts", "running"), RUNNING)}
              {item(tool("s-fail", "other", "linear.search_issues", "", "failed"))}
              {item(tool("s-stop", "read", "read", "src/huge.log", "cancelled"))}
              {item(tool("s-wait", "run", "shell", "pnpm build", "pending"), RUNNING)}
              {item(tool("s-step", "run", "shell", "pnpm test", "done", { exitCode: 0, output: OUTPUT, startedAt: NOW - 41_000, endedAt: NOW }), DONE, true)}
            </div>
          </Wide>
        </Row>
        <Row
          name="shell box: success · exit code · running (output growing) · stopped · no output · 900 lines"
        >
          <Wide label="success" open>
            {item(tool("sh-ok", "run", "shell", "pnpm test --filter thread", "done", { exitCode: 0, output: OUTPUT }))}
          </Wide>
          <Wide label="exit code 1, hover" frozen="hover" open>
            {item(tool("sh-exit", "run", "shell", "pnpm typecheck && pnpm exec eslint app/ui/src --max-warnings 0", "failed", { exitCode: 1, output: "src/rows.tsx(4,1): error TS2307: Cannot find module './kept'." }))}
          </Wide>
          <Wide label="running" open>
            {item(tool("sh-live", "run", "shell", "pnpm test", "running", { output: grown }), RUNNING)}
          </Wide>
          <Wide label="stopped · no output" open>
            {item(tool("sh-stop", "run", "shell", "sleep 600", "cancelled"))}
          </Wide>
          <Wide label="900 lines (the last 400 drawn)" open>
            {item(tool("sh-long", "run", "shell", "seq 900", "done", { exitCode: 0, output: LONG_OUTPUT }))}
          </Wide>
          <Wide label="another tool, open" open>
            {item(tool("t-other", "other", "linear.search_issues", '{ "query": "thread rows" }', "done", { output: '[{ "id": "BRG-12", "title": "Thread rows" }]' }))}
          </Wide>
        </Row>
      </Section>
      <Section title="Thread · file changes · diff card">
        <Row
          name="edited · created · deleted · renamed · counts not reported · editing · waiting · rejected · failed · open"
        >
          <Wide label="by change; hover shows the counts' colours">
            <div className="flex flex-col gap-1">
              {item({
                ...base("f1"),
                kind: "fileChange",
                progress: "done",
                changes: [file("src/thread/blocks.ts", "modified", 7, 2), file("src/thread/kept.ts", "added", 17, 0), file("src/old.ts", "deleted", 0, 40), file("src/rows.tsx", "renamed", 3, 3, "src/draft-rows.tsx"), file("src/words.ts", "modified", null, null)],
              })}
              <div data-frozen="hover">{item({ ...base("f2"), kind: "fileChange", progress: "done", changes: [file("src/thread/blocks.ts", "modified", 7, 2)] })}</div>
              {item({ ...base("f3", RUNNING), kind: "fileChange", progress: "running", changes: [file("src/thread/rows.tsx", "modified", null, null)] }, RUNNING)}
              {item({ ...base("f3w", RUNNING), kind: "fileChange", progress: "pending", changes: [file("src/thread/body.tsx", "added", null, null)] }, RUNNING)}
              {item({ ...base("f4"), kind: "fileChange", progress: "cancelled", changes: [file("src/main.ts", "modified", 1, 1)] })}
              {item({ ...base("f5"), kind: "fileChange", progress: "failed", changes: [file("src/locked.ts", "modified", null, null)] })}
            </div>
          </Wide>
          <Wide label="open: the diff card" open>
            {item({ ...base("f6"), kind: "fileChange", progress: "done", changes: [file("src/thread/blocks.ts", "modified", 3, 1)] })}
          </Wide>
          <Wide label="open: a long diff, folded" open>
            {item({ ...base("f7"), kind: "fileChange", progress: "done", changes: [{ ...file("src/thread/rows.tsx", "modified", 4, 4), diff: LONG_DIFF }] })}
          </Wide>
        </Row>
      </Section>
      <Section title="Thread · messages">
        <Row name="user: first (dated) · hover (time, copy) · long (Show more) · markdown · code block across the cut · opened · system line">
          <Wide label="dated (first, or over an hour after the last): today · last week">
            <Body item={{ ...base("u0"), kind: "message", role: "user", text: USER, streaming: false, sentAt: NOW - 3 * 60_000 }} turn={DONE} step={false} dated />
            <Body item={{ ...base("u0b"), kind: "message", role: "user", text: USER, streaming: false, sentAt: NOW - 4 * 86_400_000 }} turn={DONE} step={false} dated />
          </Wide>
          <Wide label="hover" frozen="hover">
            {item({ ...base("u1"), kind: "message", role: "user", text: USER, streaming: false, sentAt: NOW - 3 * 60_000 })}
          </Wide>
          <Wide label="long">{item({ ...base("u2"), kind: "message", role: "user", text: LONG_USER, streaming: false })}</Wide>
          <Wide label="markdown, line breaks kept">{item({ ...base("u4"), kind: "message", role: "user", text: MD_USER, streaming: false })}</Wide>
          <Wide label="long, a code block across the cut (cut after it)">{item({ ...base("u5"), kind: "message", role: "user", text: CODE_USER, streaming: false })}</Wide>
          <Wide label="long, opened" open>{item({ ...base("u2o"), kind: "message", role: "user", text: LONG_USER, streaming: false })}</Wide>
          <Wide label="system line">{item({ ...base("u3"), kind: "message", role: "user", origin: "system", text: "Continued from the last session.", streaming: false })}</Wide>
        </Row>
        <Row name="user: sending · not sent · unconfirmed · dimmed (owner's own states, D59/D84-D88: no old equivalent)">
          <Wide label="look only: the states session sets them">
            <Bubbles />
          </Wide>
        </Row>
        <Row name="answer: streaming (live) · latest (time always) · older (time on hover) · older, hover · long code block">
          <Wide label="streaming">{item({ ...base("a1", RUNNING), kind: "message", role: "assistant", text: streamed, streaming: true }, RUNNING)}</Wide>
          <Wide label="latest">
            <Body item={{ ...base("a2"), kind: "message", role: "assistant", text: REPLY, streaming: false, sentAt: NOW - 60_000 }} turn={DONE} step={false} latest />
          </Wide>
          <Wide label="older">{item({ ...base("a2b"), kind: "message", role: "assistant", text: REPLY, streaming: false, sentAt: NOW - 60_000 })}</Wide>
          <Wide label="older, hover" frozen="hover">
            {item({ ...base("a2c"), kind: "message", role: "assistant", text: REPLY, streaming: false, sentAt: NOW - 60_000 })}
          </Wide>
          <Wide label="long code, folded">{item({ ...base("a3"), kind: "message", role: "assistant", text: LONG_CODE, streaming: false })}</Wide>
        </Row>
      </Section>
      <Section title="Thread · jump to the latest">
        <Row name="idle · streaming (dots, live) · streaming, hover (↓) · streaming, focus">
          {(
            [
              ["idle", false, undefined],
              ["streaming", true, undefined],
              ["streaming, hover", true, "hover"],
              ["streaming, focus", true, "focus"],
            ] as const
          ).map(([label, running, frozen]) => (
            <State key={label} label={label} frozen={frozen}>
              <button
                type="button"
                aria-label="Jump to the latest"
                className="group/jump flex size-control-md items-center justify-center rounded-capsule bg-popover text-foreground shadow-overlay focus-visible:focus-ring"
              >
                <JumpSign running={running} />
              </button>
            </State>
          ))}
        </Row>
      </Section>
      <Section title="Thread · approvals · questions · subagents · compaction · notices · unknown">
        <Row
          name="approval: waiting · allowed (open) · denied · withdrawn"
        >
          <Wide label="waiting · withdrawn">
            <div className="flex flex-col gap-1">
              {item({ ...base("p1", RUNNING), kind: "approval", title: "Allow this command?", detail: "rm -rf dist", decision: null, action: "command" }, RUNNING)}
              {item({ ...base("p4"), kind: "approval", title: "Allow this command?", detail: "rm -rf dist", decision: null, action: "command" })}
            </div>
          </Wide>
          <Wide label="allowed, open" open>
            {item({ ...base("p2"), kind: "approval", title: "Run a command that reaches outside?", detail: "curl https://registry.npmjs.org/@base-ui/react", decision: "approved", action: "network" })}
          </Wide>
          <Wide label="denied">{item({ ...base("p3"), kind: "approval", title: "Allow editing this file?", detail: "~/.zshrc", decision: "denied", action: "edit" })}</Wide>
        </Row>
        <Row name="question: waiting · answered (open) · withdrawn">
          <Wide label="question">
            <div className="flex flex-col gap-1">
              {item({ ...base("q1", RUNNING), kind: "question", question: "Which branch?", options: ["main", "ui/kit"], answer: null }, RUNNING)}
              {item({ ...base("q3"), kind: "question", question: "Which branch?", options: ["main"], answer: null })}
            </div>
          </Wide>
          <Wide label="answered, open" open>
            {item({ ...base("q2"), kind: "question", question: "Land on main now?", options: ["Yes", "No"], answer: "Yes, after CI is green." })}
          </Wide>
        </Row>
        <Row
          name="subagent: waiting · running (live) · done (open) · failed · stopped · without its step and count"
        >
          <Wide label="waiting · running (its step changes each second)">
            <div className="flex flex-col gap-1">
              {item({ ...agent("c-wait", "pending"), startedAt: undefined, endedAt: null, steps: null, answer: null }, RUNNING)}
              {item({ ...agent("c-run", "running"), endedAt: null, current: SUBAGENT_STEPS[tick % SUBAGENT_STEPS.length], answer: null }, RUNNING)}
            </div>
          </Wide>
          <Wide label="done, open · failed · stopped" open>
            <div className="flex flex-col gap-1">
              {item(agent("c-done", "done"))}
              {item({ ...agent("c-fail", "failed"), endedAt: NOW - 51_000, steps: 2, answer: null })}
              {item({ ...agent("c-stop", "cancelled"), endedAt: NOW - 40_000, steps: 4, answer: null })}
            </div>
          </Wide>
          <Wide label="no step or count reported: running · done">
            <div className="flex flex-col gap-1">
              {item({ ...agent("c-run-bare", "running"), endedAt: null, current: null, steps: null, answer: null }, RUNNING)}
              {item({ ...agent("c-done-bare", "done"), steps: null, answer: null })}
            </div>
          </Wide>
        </Row>
        <Row name="compaction: waiting · running · done · failed · not reported · notices: note · warning · error · unknown (shut, open)">
          <Wide label="compaction">
            <div className="flex w-full flex-col">
              {(["pending", "running", "done", "failed", undefined] as const).map((progress) => (
                <div key={String(progress)}>{item({ ...base(`m-${String(progress)}`), kind: "compaction", summary: null, progress })}</div>
              ))}
            </div>
          </Wide>
          <Wide label="notices">
            <div className="flex flex-col gap-1">
              {item({ ...base("n1"), kind: "notice", level: "info", text: "Model changed from a large model to a fast one." })}
              {item({ ...base("n2"), kind: "notice", level: "warning", text: "Usage is close to its limit · resets 9:39 PM" })}
              {item({ ...base("n3"), kind: "notice", level: "error", text: "The connection dropped before the reply finished." })}
            </div>
          </Wide>
          <Wide label="unknown">{item({ ...base("x1"), kind: "unknown", raw: { type: "provider.event", data: { a: 1 } } })}</Wide>
          <Wide label="unknown, open" open>
            {item({ ...base("x2"), kind: "unknown", raw: { type: "provider.event", data: { a: 1 } } })}
          </Wide>
        </Row>
      </Section>
    </>
  );
}

/** The bubble's look-only send states, and a narrow failed one. */
function Bubbles() {
  return (
    <div className="flex flex-col gap-4">
      <UserBubble keep="look-sending" text="Ship the thread rows." sending />
      <UserBubble keep="look-failed" text="Ship the thread rows." time={NOW} failed="the daemon isn't reachable" onRetry={noop} onDiscard={noop} />
      <div className="w-72 self-end">
        <UserBubble
          keep="look-failed-long"
          text="Ship the thread rows."
          time={NOW}
          failed="the agent refused it: its provider answered 529, overloaded"
          onRetry={noop}
          onDiscard={noop}
        />
      </div>
      <UserBubble keep="look-unconfirmed" text="Ship the thread rows." unconfirmed />
      <UserBubble keep="look-dimmed" text="Ship the thread rows." dimmed />
    </div>
  );
}
