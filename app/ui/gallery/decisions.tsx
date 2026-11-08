// The composer's decisions (slice 4): approvals in every kind and state, frozen, plus one live copy.
import { type ReactNode, useEffect, useRef, useState } from "react";

import { type ApprovalDecision, ApprovalSlot, type PendingApproval } from "../src/components/composer/approval";
import { ComposerCard, ComposerFooter, ComposerTools, PlusButton } from "../src/components/composer/composer";
import { ComposerField } from "../src/components/composer/field";
import { ComposerRail } from "../src/components/composer/rail";
import { SendButton } from "../src/components/composer/send-button";
import { ModelPill } from "./composer";
import { Row, Section, State } from "./parts";

const LONG = "pnpm --filter @brigadier/ui exec vite build --mode production --outDir /tmp/brigadier-dist --emptyOutDir && node scripts/bundle-size.mjs --budget 450 --report /tmp/brigadier-dist/size.json && rm -rf /tmp/brigadier-dist";

const KINDS: [string, PendingApproval][] = [
  ["Terminal, the agent's reason", { id: "a1", action: "command", reason: "Run the type checker to see what broke", command: "pnpm typecheck" }],
  ["Terminal, no reason, outside the session, beyond its sandbox", { id: "a2", action: "command", reason: null, command: "rm -rf node_modules/.cache", cwd: "/Users/me/other-project", paths: ["write /Users/me/other-project"] }],
  ["Terminal, a long command (Expand)", { id: "a3", action: "command", reason: "Check the bundle stays under budget", command: LONG }],
  ["Edit files", { id: "a4", action: "edit", reason: null, paths: ["app/ui/src/components/composer/approval.tsx", "app/ui/src/theme.css", "README.md"] }],
  ["Internet access, a host", { id: "a5", action: "network", reason: null, host: "registry.npmjs.org" }],
  ["Land a change", { id: "a6", action: "land", reason: null, branch: "main", files: [{ path: "app/ui/src/theme.css", insertions: 12, deletions: 3, binary: false }, { path: "app/ui/public/mark.png", insertions: 0, deletions: 0, binary: true }] }],
  ["Plan (no Deny)", { id: "a7", action: "plan", reason: "Rebuild the approval card from the old app", body: "1. Port the card's parts\n2. Add the `ApprovalSlot`\n3. Show every state in the gallery" }],
  ["Message to another session", { id: "a8", action: "message", reason: null, to: "Fix the queue's drag order", body: "The drop target moved to `queue.tsx`; rebase before you push." }],
  ["Browser", { id: "a9", action: "browser", reason: "Sign in to the staging dashboard?", body: "Fills the login form at staging.example.com with the saved test account." }],
  ["Ask permission, raw input", { id: "a10", action: "permission", reason: null, input: '{"tool": "write_memory", "key": "build-steps"}' }],
];

const GRANTS: [string, PendingApproval][] = [
  ["A command prefix", { id: "g1", action: "command", reason: null, command: "pnpm test --filter thread", grant: { scope: "command", pattern: "pnpm test" } }],
  ["A folder", { id: "g2", action: "edit", reason: null, paths: ["app/ui/src/theme.css"], grant: { scope: "edits", pattern: "/Users/me/brigadier/app/ui" } }],
  ["A host", { id: "g3", action: "network", reason: null, host: "registry.npmjs.org", grant: { scope: "network", pattern: "registry.npmjs.org" } }],
];

const later = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));
const never = () => new Promise<void>(() => {});
const refuse = () => Promise.reject(new Error("The session ended before the answer reached it"));

/** A card as it waits in the composer's place. */
function Slot({ approvals, onAnswer = () => later(600), width = "w-reading" }: { approvals: PendingApproval[]; onAnswer?: (id: string, decision: ApprovalDecision) => Promise<void>; width?: string }) {
  return (
    <div className={width}>
      <ApprovalSlot approvals={approvals} onAnswer={onAnswer} onReply={() => {}} />
    </div>
  );
}

/** Presses the card's Allow once as it mounts, to hold the sending or error state still. */
function Pressed({ children }: { children: ReactNode }) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const buttons = box.current!.querySelectorAll<HTMLButtonElement>("[data-slot=action-card] button");
    buttons[buttons.length - 1]?.click();
  }, []);
  return <div ref={box}>{children}</div>;
}

/** Approvals coming, answered, Reply… and back: Rust's stand-in takes each answer a moment later. */
function Live() {
  const [approvals, setApprovals] = useState<PendingApproval[]>(KINDS.slice(0, 3).map(([, each]) => each));
  const [replying, setReplying] = useState(false);
  const [log, setLog] = useState<string[]>([]);
  const answer = async (id: string, decision: ApprovalDecision) => {
    await later(500);
    setApprovals((list) => list.filter((each) => each.id !== id));
    setLog((lines) => [...lines.slice(-3), `${decision} · ${id}`]);
  };
  const more = () => setApprovals((list) => [...list, ...KINDS.slice(3, 6).map(([, each]) => ({ ...each, id: `${each.id}-${list.length}` }))]);
  const slot = approvals.length > 0 && !replying;
  if (replying && approvals.length === 0) setReplying(false);
  return (
    <div className="flex w-reading flex-col gap-3">
      <ol className="flex flex-col gap-1 text-sm text-muted-foreground">
        {log.map((line, at) => (
          <li key={at}>{line}</li>
        ))}
        <li>
          <button type="button" className="cursor-pointer text-link hover:underline" onClick={more}>
            Three more approvals
          </button>
        </li>
      </ol>
      <div>
        <ComposerRail>{replying && <ApprovalSlot placement="rail" approvals={approvals} onAnswer={answer} />}</ComposerRail>
        {slot && <ApprovalSlot approvals={approvals} onAnswer={answer} onReply={() => setReplying(true)} />}
        {/* Kept while an approval has its place, so the draft and its caret stay. */}
        <ComposerCard className={slot ? "hidden" : undefined}>
          <ComposerField placeholder="Do anything" />
          <ComposerFooter>
            <ComposerTools>
              <PlusButton />
            </ComposerTools>
            <ModelPill />
            <SendButton empty running={false} canStop={false} onSend={() => {}} onStop={() => {}} />
          </ComposerFooter>
        </ComposerCard>
      </div>
    </div>
  );
}

export function DecisionsGallery() {
  return (
    <Section title="Composer decisions">
      <Row name="Approval, by kind">
        {KINDS.map(([label, approval]) => (
          <State key={approval.id} label={label}>
            <Slot approvals={[approval]} />
          </State>
        ))}
      </Row>
      <Row name="Allow for this session (hover it for its tip)">
        {GRANTS.map(([label, approval]) => (
          <State key={approval.id} label={label}>
            <Slot approvals={[approval]} />
          </State>
        ))}
      </Row>
      <Row name="Several waiting, narrow, sending, refused">
        <State label="1 of 3">
          <Slot approvals={KINDS.slice(0, 3).map(([, each]) => each)} />
        </State>
        <State label="Narrow: the buttons stack">
          <Slot approvals={[GRANTS[0]![1]]} width="w-96" />
        </State>
        <State label="Sending">
          <Pressed>
            <Slot approvals={[KINDS[0]![1]]} onAnswer={never} />
          </Pressed>
        </State>
        <State label="Refused">
          <Pressed>
            <Slot approvals={[KINDS[0]![1]]} onAnswer={refuse} />
          </Pressed>
        </State>
      </Row>
      <Row name="On the rail, after Reply…">
        <State label="With more waiting">
          <div className="w-reading">
            <ComposerRail>
              <ApprovalSlot placement="rail" approvals={KINDS.slice(0, 2).map(([, each]) => each)} onAnswer={() => later(600)} />
            </ComposerRail>
            <ComposerCard>
              <ComposerField placeholder="Do anything" initial={{ parts: ["Use the other config instead"], attachmentIds: [] }} />
            </ComposerCard>
          </div>
        </State>
      </Row>
      <Row name="Live">
        <Live />
      </Row>
    </Section>
  );
}
