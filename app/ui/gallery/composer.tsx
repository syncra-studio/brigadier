// The composer in full, live: the field with its @ and / menus, chips and attachments, the + menu, the permission
// and model pickers, the context ring and send/stop; over it the workers strip, notices, the message queue, the
// question card and Home's project, Work in and branch pickers; the approval card in its place, and a sent message's
// edit box. Rust's stand-in answers here; the toggles are what only Rust would change.
import { useRef, useState } from "react";

import { Button } from "../src/components/button";
import { CheckboxRow } from "../src/components/checkbox-row";
import { type ApprovalDecision, ApprovalSlot, MoreWaiting, type PendingApproval } from "../src/components/composer/approval";
import { type Attachment, AttachmentsContext, AttachmentTiles } from "../src/components/composer/attachments";
import { ContextRing, EditComposer, SharedComposer } from "../src/components/composer/composer";
import { type Draft, isEmpty, plainText, sendMode } from "../src/components/composer/draft";
import { ComposerField, type ComposerFieldHandle } from "../src/components/composer/field";
import { fuzzyMatch, type Mention, type MentionGroup, type Mentions, PlusMenu, type SlashCommand } from "../src/components/composer/menus";
import { ModelPill } from "../src/components/composer/model-pill";
import { type PermissionLevel, PermissionPicker } from "../src/components/composer/pickers";
import { type Given, type PendingQuestion, QuestionCard } from "../src/components/composer/question";
import { QueueCard, type QueuedMessage } from "../src/components/composer/queue";
import { Notices, PausedSendDialog, RailItem, WaitingRow } from "../src/components/composer/rail";
import { SendButton } from "../src/components/composer/send-button";
import { UserBubble } from "../src/components/thread/message";
import { showToast, Toaster } from "../src/components/toast";
import { duration, useSecond } from "../src/thread/words";
import type { Worker } from "../src/workers/chip";
import { WorkersStrip } from "../src/workers/strip";
import { Section } from "./parts";
import { BranchToggles, ProjectBar, useLiveModel } from "./pickers";
import picture from "./sample.svg?no-inline";

const draft = (...parts: Draft["parts"]): Draft => ({ parts, attachmentIds: [] });
const later = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));
const words = (d: Draft) => d.parts.map((part) => (typeof part === "string" ? part : `@${part.kind}`)).join("");

/** Rust's stand-in for opening what a chip names. */
const openChip = (kind: string, id: string) => showToast(`Open ${kind} ${id}`);

const FILES: Mention[] = [
  { id: "f1", type: "file", label: "app/ui/src/components/composer/field.tsx", name: "field.tsx", detail: "app/ui/src/components/composer" },
  { id: "f2", type: "file", label: "app/ui/src/components/composer/menus.tsx", name: "menus.tsx", detail: "app/ui/src/components/composer" },
  { id: "f3", type: "folder", label: "app/ui/src/components/composer", name: "composer", detail: "app/ui/src/components" },
  { id: "f4", type: "file", label: "../brigadier-plan/PLAN.md", name: "PLAN.md", detail: "docs" },
  { id: "f5", type: "file", label: "app/ui/src/theme.css", name: "theme.css", detail: "app/ui/src" },
  { id: "f6", type: "file", label: "docs/spec.pdf", name: "spec.pdf", detail: "docs" },
  { id: "f7", type: "file", label: "data/usage.csv", name: "usage.csv", detail: "data" },
  { id: "f8", type: "file", label: "design/roadmap.pptx", name: "roadmap.pptx", detail: "design" },
  { id: "f9", type: "file", label: "app/ui/gallery/sample.svg", name: "sample.svg", detail: "app/ui/gallery" },
  { id: "f10", type: "file", label: "crates/core/src/state.rs", name: "state.rs", detail: "crates/core/src" },
  { id: "f11", type: "file", label: "package.json", name: "package.json", detail: "" },
];
const CHATS: Mention[] = [
  { id: "c1", type: "chat", label: "Fix the queue's drag order", hint: "2h" },
  { id: "c2", type: "chat", label: "Composer slice 3", hint: "yesterday" },
];
const COMMANDS: SlashCommand[] = [
  { id: "compact", kind: "command", label: "/compact", description: "Save the context so far", instant: true },
  { id: "review", kind: "command", label: "/review", description: "Review the changes", instant: false },
  { id: "model", kind: "command", label: "/model", description: "Pick another model", disabled: true, hint: "While working", instant: true },
  { id: "skill-docs", kind: "skill", label: "/docs", description: "Write the docs for a change", instant: false },
  { id: "skill-kit", kind: "skill", label: "/kit", description: "Port a component to the kit", instant: false },
  { id: "mcp-triage", kind: "mcp", source: "issues", label: "/issues:triage", description: "Sort the new issues by area and urgency", instant: false },
];

/** Rust's stand-in search: files, folders and chats matching the query, each under its heading; with nothing typed, a hint for files. */
function search(query: string): MentionGroup[] {
  const matching = (items: Mention[]) => items.filter((item) => fuzzyMatch(item.name ?? item.label, query));
  const files = matching(FILES.filter((item) => item.type === "file"));
  return [
    query === "" ? { title: "Files", items: [], note: "Type to search files" } : { title: "Files", items: files },
    { title: "Folders", items: matching(FILES.filter((item) => item.type === "folder")) },
    { title: "Chats", items: matching(CHATS) },
  ];
}

const LONG = "pnpm --filter @brigadier/ui exec vite build --mode production --outDir /tmp/brigadier-dist --emptyOutDir && node scripts/bundle-size.mjs --budget 450 --report /tmp/brigadier-dist/size.json && rm -rf /tmp/brigadier-dist";

const ALL: PendingApproval[] = [
  { id: "a1", action: "command", reason: "Run the type checker to see what broke", command: "pnpm typecheck" },
  { id: "a2", action: "command", reason: null, command: "rm -rf node_modules/.cache", cwd: "/Users/me/other-project", paths: ["write /Users/me/other-project"] },
  { id: "a3", action: "command", reason: "Check the bundle stays under budget", command: LONG },
  { id: "a4", action: "edit", reason: null, paths: ["app/ui/src/components/composer/approval.tsx", "app/ui/src/theme.css", "README.md"] },
  { id: "a5", action: "network", reason: null, host: "registry.npmjs.org" },
  { id: "a6", action: "land", reason: null, branch: "main", files: [{ path: "app/ui/src/theme.css", insertions: 12, deletions: 3, binary: false }, { path: "app/ui/public/mark.png", insertions: 0, deletions: 0, binary: true }] },
  { id: "a7", action: "plan", reason: "Rebuild the approval card from the old app", body: "1. Port the card's parts\n2. Add the `ApprovalSlot`\n3. Show every state in the gallery" },
  { id: "a8", action: "message", reason: null, to: "Fix the queue's drag order", body: "The drop target moved to `queue.tsx`; rebase before you push." },
  { id: "a9", action: "browser", reason: "Sign in to the staging dashboard?", body: "Fills the login form at staging.example.com with the saved test account." },
  { id: "a10", action: "permission", reason: null, input: '{"tool": "write_memory", "key": "build-steps"}' },
  { id: "g1", action: "command", reason: null, command: "pnpm test --filter thread", grant: { scope: "command", pattern: "pnpm test" } },
  { id: "g2", action: "edit", reason: null, paths: ["app/ui/src/theme.css"], grant: { scope: "edits", pattern: "/Users/me/brigadier/app/ui" } },
  { id: "g3", action: "network", reason: null, host: "registry.npmjs.org", grant: { scope: "network", pattern: "registry.npmjs.org" } },
];

const MANAGER = { text: "Which package manager should the scripts use?", options: [{ label: "pnpm" }, { label: "npm" }, { label: "yarn" }], recommended: null, multiSelect: false };
const STORAGE = {
  text: "Where should the drafts be stored?",
  options: [
    { label: "In the session's folder", description: "Kept with `sessions/<id>/`, removed with the session." },
    { label: "In one shared file", description: "One `drafts.json` for every session." },
    { label: "Only in memory", description: "Gone when the app quits." },
  ],
  recommended: 0,
  multiSelect: false,
};
const CHECKS = { text: "Which checks should run before each push?", options: [{ label: "Typecheck" }, { label: "Lint" }, { label: "`scripts/limits`" }, { label: "Bundle check" }], recommended: null, multiSelect: true };
const NAME = { text: "What should the new command be called?", options: [], recommended: null, multiSelect: false };

const ask = (id: string, items: PendingQuestion["items"], title?: string): PendingQuestion => ({ id, title, items });
const QUESTIONS = [ask("l1", [STORAGE]), ask("l2", [MANAGER, CHECKS, NAME], "Release setup"), ask("l3", [CHECKS])];

type Notice = Parameters<typeof Notices>[0]["notices"][number];

const retry = (
  <Button variant="link-blue" size="xs" className="-my-0.5">
    Retry
  </Button>
);
const LOAD_ERROR = { level: "warning", text: "Couldn’t load messages", action: retry } as const;
const LONG_NOTICE = {
  level: "error",
  text: "The agent stopped: its process exited (code 1). The last thing it printed was: error: could not compile `brigadier-core` (lib) due to 3 previous errors; warning: build failed, waiting for other jobs to finish. Check the terminal for the full log.",
} as const;
const NOTICE_SAMPLES: Omit<Notice, "id">[] = [
  { level: "warning", text: "Git isn't set up in this folder, so changes can't be reviewed." },
  { level: "info", text: "The model changed to a smaller one for this turn." },
  { level: "error", text: "The agent stopped: its process exited (code 1)." },
  LOAD_ERROR,
  LONG_NOTICE,
];

const NOW = Date.now();
const worker = (id: string, name: string, kind: Worker["kind"], word: string, more: Partial<Worker> = {}): Worker => ({
  id,
  name,
  kind,
  word,
  startedAt: NOW - 130_000,
  lastAt: NOW - 4 * 60_000,
  model: "Large model",
  brief: "Retry failed uploads 5 times with doubling waits from 1 s; stop at once on a 4xx.",
  receipt: "Write code → Large model · Medium · Work (5-hour 40%, resets 15:10)",
  ...more,
});
const WORKERS = [
  worker("w-retry", "Retry backoff", "working", "Working", { now: "Running cargo test", added: 42, removed: 7 }),
  worker("w-progress", "Progress bar", "working", "Working", { now: "Writing…", startedAt: NOW - 210_000, added: 18, model: "Fast model" }),
  worker("w-held", "Docs table", "needsYou", "Needs you", { startedAt: NOW - 240_000 }),
];
const HELD = draft("Rename the field to Message");
const EDITED = draft("Fix the Enter key in the composer");

function Live() {
  const field = useRef<ComposerFieldHandle>(null);
  const next = useRef(1);
  const [empty, setEmpty] = useState(true);
  const live = useLiveModel();
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [stopped, setStopped] = useState(false);
  const [offline, setOffline] = useState(false);
  const [paused, setPaused] = useState(false);
  const [queue, setQueue] = useState<QueuedMessage[]>([]);
  const [notices, setNotices] = useState<Notice[]>([]);
  const [held, setHeld] = useState<Draft | null>(null);
  const [asking, setAsking] = useState<Draft | null>(null);
  const [approvals, setApprovals] = useState<PendingApproval[]>([]);
  const [questions, setQuestions] = useState<PendingQuestion[]>([]);
  const [aside, setAside] = useState(false);
  const [answered, setAnswered] = useState(false);
  const [workers, setWorkers] = useState(false);
  const [home, setHome] = useState(false);
  const [editing, setEditing] = useState(false);
  const [branchesLoading, setBranchesLoading] = useState(false);
  const [branchesFailed, setBranchesFailed] = useState(false);
  const [level, setLevel] = useState<PermissionLevel>("auto");
  const [results, setResults] = useState<Mentions["results"]>(null);
  const [attachments, setAttachments] = useState<ReadonlyMap<string, Attachment>>(new Map());
  const [tiles, setTiles] = useState<string[]>([]);
  const [sent, setSent] = useState<Draft["parts"][]>([]);
  const [log, setLog] = useState<string[]>([]);
  const running = startedAt !== null;
  const now = useSecond(running);
  const say = (line: string) => setLog((lines) => [...lines.slice(-4), line]);

  const put = (attachment: Attachment) => setAttachments((all) => new Map(all).set(attachment.id, attachment));
  // Rust's stand-in: stored a moment later; images then show the sample picture.
  const attach = (id: string, file: File, inText: boolean) => {
    const base = { id, name: file.name, mime: file.type };
    put({ ...base, state: "uploading" });
    if (!inText) setTiles((list) => [...list, id]);
    setTimeout(() => put({ ...base, state: "ready", url: file.type.startsWith("image/") ? picture : undefined }), 900);
  };
  const commands = { commands: COMMANDS, onMenu: () => {}, onRun: (command: SlashCommand) => say(`ran ${command.label}`) };

  const take = (): Draft => {
    const d = { parts: field.current!.parts(), attachmentIds: tiles };
    field.current!.set([]);
    setTiles([]);
    return d;
  };
  /** Sent: shown as a bubble, and a turn starts. */
  const deliver = (d: Draft) => {
    setSent((list) => [...list, d.parts]);
    setStopped(false);
    setStartedAt(Date.now());
  };
  const enqueue = (d: Draft) => {
    const id = `live${next.current++}`;
    setQueue((list) => [...list, { id, state: "local", draft: d }]);
    setTimeout(() => setQueue((list) => list.map((each) => (each.id === id ? { ...each, state: "queued" } : each))), 800);
  };
  const send = (other = false) => {
    if (offline || isEmpty({ parts: field.current!.parts(), attachmentIds: tiles })) return;
    if (paused && queue.length > 0) return setAsking(take());
    const mode = sendMode(running, "queue", other, true);
    if (mode === "now") return deliver(take());
    if (mode === "steer") return say(`steered · ${words(take())}`);
    enqueue(take());
  };
  /** The turn ends: the first queued message goes, unless Stop paused the queue. */
  const end = () => {
    setStartedAt(null);
    const first = queue[0];
    if (paused || !first) return;
    setQueue((list) => list.slice(1));
    deliver(first.draft);
  };
  const pull = (id: string) => {
    const found = queue.find((each) => each.id === id);
    if (!found || !isEmpty(draft(...field.current!.parts()))) return false;
    setQueue((list) => list.filter((each) => each.id !== id));
    field.current!.set(found.draft.parts);
    return true;
  };
  const answerApproval = async (id: string, decision: ApprovalDecision, reason?: string) => {
    await later(500);
    setApprovals((list) => list.filter((each) => each.id !== id));
    say(`${decision}${reason ? ` “${reason}”` : ""} · ${id}`);
  };
  const answerQuestion = async (answers: Given[]) => {
    await later(500);
    setQuestions((list) => list.slice(1));
    setAnswered(true);
    say(answers.map((each) => (typeof each === "string" ? each : each ? plainText(each.parts) || "(files)" : "(skipped)")).join(" · "));
  };
  const question = questions[0];

  return (
    <div className="flex w-full max-w-reading flex-col gap-3 pt-80">
      <ol className="flex flex-col gap-1 text-sm text-muted-foreground">
        {log.map((line, at) => (
          <li key={at} className="truncate">
            {line}
          </li>
        ))}
      </ol>
      {/* Sent, it shows as the composer showed it [D2107]. */}
      <AttachmentsContext value={attachments}>
        {sent.map((parts, at) =>
          editing && at === sent.length - 1 ? (
            <EditComposer
              key={at}
              initial={draft(...parts)}
              onCancel={() => setEditing(false)}
              onSend={(next) => {
                setEditing(false);
                setSent((list) => [...list.slice(0, -1), next]);
                setStopped(false);
                setStartedAt(Date.now());
              }}
            />
          ) : (
            <UserBubble key={at} keep={`composer-sent-${at}`} text={plainText(parts)} owner="gallery" parts={parts} />
          ),
        )}
      </AttachmentsContext>
      <AttachmentsContext value={attachments}>
        <SharedComposer
          rail={
            <>
              {workers && <WorkersStrip workers={WORKERS} act={() => Promise.resolve()} />}
              <Notices notices={notices} onDismiss={(id) => setNotices((list) => list.filter((each) => each.id !== id))} />
              <QueueCard
                items={queue}
                paused={paused}
                steer={running}
                canEdit={empty}
                notSent={
                  held && {
                    draft: held,
                    reason: "the session ended before it went",
                    onRestore: () => {
                      if (!isEmpty(draft(...field.current!.parts()))) return say("clear the field to restore it");
                      field.current!.set(held.parts);
                      setHeld(null);
                    },
                    onDiscard: () => setHeld(null),
                  }
                }
                onResume={() => {
                  setPaused(false);
                  if (!running) end();
                }}
                onSteer={(id) => {
                  say(`steered · ${words(queue.find((each) => each.id === id)!.draft)}`);
                  setQueue((list) => list.filter((each) => each.id !== id));
                }}
                onRemove={(id) => setQueue((list) => list.filter((each) => each.id !== id))}
                onEdit={pull}
                onToSession={(id) => setQueue((list) => list.map((each) => (each.id === id ? { ...each, to: undefined } : each)))}
                onMove={(id, to) =>
                  setQueue((list) => {
                    const rest = list.filter((each) => each.id !== id);
                    rest.splice(to, 0, list.find((each) => each.id === id)!);
                    return rest;
                  })
                }
              />
              {question && aside && <WaitingRow count={questions.length} onShow={() => setAside(false)} />}
              {question && !aside && (
                <RailItem variant="decision" label="Waiting for you">
                  <QuestionCard
                    key={question.id}
                    session=""
                    run={async () => ({ ok: true })}
                    question={question}
                    onAnswer={answerQuestion}
                    onDismiss={() => setAside(true)}
                    stagger={answered}
                    footer={<MoreWaiting more={questions.length - 1} />}
                  />
                </RailItem>
              )}
              {home && (
                <RailItem label="Composer utility bar">
                  <ProjectBar loading={branchesLoading} failed={branchesFailed} />
                </RailItem>
              )}
            </>
          }
          above={approvals.length > 0 && <ApprovalSlot approvals={approvals} onAnswer={answerApproval} />}
          // Kept while an approval has its place, so the draft and its caret stay.
          hidden={approvals.length > 0}
          tiles={<AttachmentTiles ids={tiles} onRemove={(id) => setTiles((list) => list.filter((each) => each !== id))} />}
          plus={<PlusMenu field={field} commands={commands} chats={CHATS} onFiles={(files) => files.forEach((file) => attach(crypto.randomUUID(), file, false))} />}
          level={<PermissionPicker value={level} onChange={setLevel} />}
          ring={<ContextRing usedTokens={45_000} windowTokens={258_000} />}
          model={<ModelPill {...live} />}
          send={
            <SendButton
              empty={empty && tiles.length === 0}
              running={running}
              canStop={running && !offline}
              canResume={stopped}
              blocked={offline ? "Reconnecting…" : undefined}
              onSend={() => send()}
              onStop={() => {
                setStartedAt(null);
                setStopped(true);
                setPaused(queue.length > 0);
              }}
              onResume={() => {
                setStopped(false);
                setStartedAt(Date.now());
              }}
            />
          }
          after={
            <PausedSendDialog
              waiting={asking && queue.length}
              onClose={() => setAsking(null)}
              onKeepPaused={() => {
                enqueue(asking!);
                setAsking(null);
              }}
              onSendNow={() => {
                deliver(asking!);
                setAsking(null);
              }}
            />
          }
        >
          <ComposerField
            ref={field}
            placeholder={offline ? "Reconnecting…" : running ? `Working for ${duration(now - startedAt)}` : "Do anything"}
            attachments={attachments}
            // Rust's stand-in answers a moment later, echoing the query.
            mentions={{ results, onQuery: (query) => query !== null && setTimeout(() => setResults({ query, groups: search(query) }), 120) }}
            commands={commands}
            prompts={sent.map((parts) => draft(...parts))}
            onAttach={attach}
            onOpen={openChip}
            onChange={(parts) => setEmpty(isEmpty(draft(...parts)))}
            onSubmit={send}
            onPullQueued={() => {
              const last = queue.findLast((each) => each.state !== "local");
              return last ? pull(last.id) : false;
            }}
          />
        </SharedComposer>
      </AttachmentsContext>
      <div className="flex flex-wrap items-center gap-4">
        <CheckboxRow label="A turn runs" checked={running} onCheckedChange={(on) => (on ? setStartedAt(Date.now()) : end())} />
        <CheckboxRow label="Reconnecting" checked={offline} onCheckedChange={setOffline} />
        <CheckboxRow label="Approvals waiting" checked={approvals.length > 0} onCheckedChange={(on) => setApprovals(on ? ALL : [])} />
        <CheckboxRow
          label="Questions waiting"
          checked={questions.length > 0}
          onCheckedChange={(on) => {
            setAside(false);
            setQuestions(on ? QUESTIONS : []);
          }}
        />
        <CheckboxRow label="Workers" checked={workers} onCheckedChange={setWorkers} />
        <CheckboxRow label="At Home" checked={home} onCheckedChange={setHome} />
        <CheckboxRow
          label="Edit and resend"
          checked={editing}
          onCheckedChange={(on) => {
            // With nothing sent yet, a sample message to edit.
            if (on && sent.length === 0) setSent([EDITED.parts]);
            setEditing(on);
          }}
        />
        {home && <BranchToggles loading={branchesLoading} failed={branchesFailed} onLoading={setBranchesLoading} onFailed={setBranchesFailed} />}
        <Button size="sm" variant="outline" onClick={() => setNotices((list) => [...list, { id: next.current++, ...NOTICE_SAMPLES[next.current % NOTICE_SAMPLES.length]! }])}>
          Add a notice
        </Button>
        <Button size="sm" variant="outline" onClick={() => setHeld(HELD)}>
          Hold a message
        </Button>
      </div>
    </div>
  );
}

export function ComposerGallery() {
  return (
    <Section title="Composer">
      {/* Its field keeps an empty menu anchor open: held, so the approval card keeps its keys. */}
      <div data-held className="contents">
        <Live />
      </div>
      <Toaster />
    </Section>
  );
}
