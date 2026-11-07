// Slice 4's thread rows in every state, Current beside Old app, on fake items. The live copies tick: the
// answer streams, the work header counts, the group's running step changes, the shell output grows.
import { type ReactNode, useEffect, useRef, useState } from "react";

import { Body } from "../src/components/thread/body";
import { UserBubble } from "../src/components/thread/message";
import { GroupRow, WorkHeader, WorkingLine } from "../src/components/thread/work";
import type { FileChange, Item, Progress, StepKind, Turn } from "../src/thread/item";
import type { Group } from "../src/thread/lines";
import "../src/thread/markdown.css";
import { Compare, Section, State } from "./parts";
import { ProposedStep, type Step } from "./proposed-tool";

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

/** Opened tool steps, as real ones read: a file, matches, pages, a subagent's answer, another tool's arguments. */
const STEPS: Step[] = [
  { id: "o-read", kind: "read", name: "read", input: "src/thread/kept.ts", output: Array.from({ length: 17 }, (_, i) => `${String(i + 1).padStart(3)}  ${["import { useSyncExternalStore } from \"react\";", "", "const kept = new Map<string, boolean>();", "export function useKept(id: string) {"][i % 4]}`).join("\n") },
  { id: "o-search", kind: "search", name: "rg", input: "“useKept” in src", output: "src/thread/kept.ts:4: export function useKept(id: string) {\nsrc/components/thread/activity-row.tsx:62:   const [open, setOpen] = useKept(keep);\nsrc/components/thread/tool.tsx:118:   const [whole, setWhole] = useKept(`${keep}:command`);" },
  { id: "o-web", kind: "web", name: "web_search", input: "base ui collapsible", output: "Collapsible · Base UI — base-ui.com/react/components/collapsible\nBase UI v1 release notes — base-ui.com/react/overview/releases\nAnimating height with Collapsible — github.com/mui/base-ui/discussions" },
  { id: "o-agent", kind: "agent", name: "task", input: "Find the parser", output: "The parser lives in src/thread/lines.ts: `toLines` folds items into lines, and `workKey` names a turn's fold. Nothing else parses events in the UI." },
  { id: "o-other", kind: "other", name: "linear.search_issues", input: '{ "query": "thread rows", "limit": 3 }', output: '[\n  { "id": "BRG-41", "title": "Thread rows match the old app" },\n  { "id": "BRG-44", "title": "Shell box copy output" }\n]' },
  { id: "o-fail", kind: "other", name: "linear.search_issues", input: '{ "query": "thread" }', output: "", failed: true },
];

const USER = "Can you make the thread rows match the old app, and check the shell box against a failing test?";
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
    box.current?.querySelector<HTMLElement>('[aria-expanded="false"]')?.click();
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
    <div className="flex w-full min-w-0 flex-col gap-2">
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
        <Compare name="working (ticking) · waiting (ticking) · worked, shut · worked and waited · open · hover · focus">
          <Wide label="running">
            <WorkHeader turn={RUNNING} work={undefined} open={null} onToggle={noop} />
          </Wide>
          <Wide label="waiting on your answer">
            <WorkHeader turn={RUNNING} work={undefined} open={null} onToggle={noop} waitingSince={NOW - 63_000} />
          </Wide>
          <Wide label="done, shut">
            <WorkHeader turn={DONE} work={WORK} open={false} onToggle={noop} />
          </Wide>
          <Wide label="done, waited">
            <WorkHeader turn={DONE} work={WORK} open={false} onToggle={noop} waited={62_000} />
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
        </Compare>
        <Compare name="group: shut · open · hover · focus · live (its running step, changing each second)">
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
        </Compare>
        <Compare name="working line: live · stalled · interrupted · disconnected · thinking · thinking with a heading">
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
        </Compare>
      </Section>
      <Section title="Thread · tool steps · shell box">
        <Compare name="steps by kind: read · search · web · subagent · other · failed · stopped · waiting · in an opened group">
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
        </Compare>
        <Compare
          name="opened: read · search · web · subagent · other tool · failed"
          proposed={
            <>
              <Wide label="A · hanging: output under the words on a hairline, no box">
                <div className="flex flex-col gap-1">
                  {STEPS.map((step) => (
                    <Opened key={step.id}>
                      <ProposedStep step={step} look="hanging" />
                    </Opened>
                  ))}
                </div>
              </Wide>
              <Wide label="B · block: one quiet block, no labels">
                <div className="flex flex-col gap-1">
                  {STEPS.map((step) => (
                    <Opened key={step.id}>
                      <ProposedStep step={step} look="block" />
                    </Opened>
                  ))}
                </div>
              </Wide>
            </>
          }
        >
          <Wide label="opened">
            <div className="flex flex-col gap-1">
              {STEPS.map((step) => (
                <Opened key={step.id}>{item(tool(step.id, step.kind, step.name, step.input, step.failed ? "failed" : "done", { output: step.output }))}</Opened>
              ))}
            </div>
          </Wide>
        </Compare>
        <Compare name="shell box: success · exit code · running (output growing) · stopped · no output · 900 lines">
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
        </Compare>
      </Section>
      <Section title="Thread · file changes · diff card">
        <Compare name="edited · created · deleted · renamed · counts not reported · editing · waiting · rejected · failed · open">
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
        </Compare>
      </Section>
      <Section title="Thread · messages">
        <Compare name="user: hover (time, copy) · long (Show more) · sending · not sent · dimmed · system line">
          <Wide label="hover" frozen="hover">
            {item({ ...base("u1"), kind: "message", role: "user", text: USER, streaming: false, sentAt: NOW - 3 * 60_000 })}
          </Wide>
          <Wide label="long">{item({ ...base("u2"), kind: "message", role: "user", text: LONG_USER, streaming: false })}</Wide>
          <Wide label="sending · not sent · dimmed (look only: the states session sets them)">
            <Bubbles />
          </Wide>
          <Wide label="system line">{item({ ...base("u3"), kind: "message", role: "user", origin: "system", text: "Continued from the last session.", streaming: false })}</Wide>
        </Compare>
        <Compare name="answer: streaming (live) · finished with its actions · a long code block">
          <Wide label="streaming">{item({ ...base("a1", RUNNING), kind: "message", role: "assistant", text: streamed, streaming: true }, RUNNING)}</Wide>
          <Wide label="finished">{item({ ...base("a2"), kind: "message", role: "assistant", text: REPLY, streaming: false, sentAt: NOW - 60_000 })}</Wide>
          <Wide label="long code, folded">{item({ ...base("a3"), kind: "message", role: "assistant", text: LONG_CODE, streaming: false })}</Wide>
        </Compare>
      </Section>
      <Section title="Thread · approvals · questions · subagents · compaction · notices · unknown">
        <Compare name="approval: waiting · allowed · denied">
          <Wide label="waiting">{item({ ...base("p1", RUNNING), kind: "approval", title: "Allow this command?", detail: "rm -rf dist", decision: null, action: "command" }, RUNNING)}</Wide>
          <Wide label="allowed">{item({ ...base("p2"), kind: "approval", title: "Run a command that reaches outside?", detail: "curl https://registry.npmjs.org/@base-ui/react", decision: "approved", action: "network" })}</Wide>
          <Wide label="denied">{item({ ...base("p3"), kind: "approval", title: "Allow editing this file?", detail: "~/.zshrc", decision: "denied", action: "edit" })}</Wide>
        </Compare>
        <Compare name="question: waiting · answered (open) · withdrawn · subagent: waiting · running · done · failed · stopped">
          <Wide label="question">
            <div className="flex flex-col gap-1">
              {item({ ...base("q1", RUNNING), kind: "question", question: "Which branch?", options: ["main", "ui/kit"], answer: null }, RUNNING)}
              {item({ ...base("q3"), kind: "question", question: "Which branch?", options: ["main"], answer: null })}
            </div>
          </Wide>
          <Wide label="answered, open" open>
            {item({ ...base("q2"), kind: "question", question: "Land on main now?", options: ["Yes", "No"], answer: "Yes, after CI is green." })}
          </Wide>
          <Wide label="subagent">
            <div className="flex flex-col gap-1">
              {(["pending", "running", "done", "failed", "cancelled"] as const).map((progress) => (
                <div key={progress}>{item({ ...base(`c-${progress}`, RUNNING), kind: "childAgent", sessionId: "s2", title: "Find the parser", progress }, RUNNING)}</div>
              ))}
            </div>
          </Wide>
        </Compare>
        <Compare name="compaction: waiting · running · done · failed · not reported · notices: note · warning · error · unknown (shut, open)">
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
        </Compare>
      </Section>
    </>
  );
}

/** The bubble's look-only send states. */
function Bubbles() {
  return (
    <div className="flex flex-col gap-4">
      <UserBubble keep="look-sending" text="Ship the thread rows." sending />
      <UserBubble keep="look-failed" text="Ship the thread rows." failed="the daemon isn't reachable" onRetry={noop} onDiscard={noop} />
      <UserBubble keep="look-dimmed" text="Ship the thread rows." dimmed />
    </div>
  );
}
