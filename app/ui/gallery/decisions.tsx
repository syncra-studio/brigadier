// The composer's decisions (slice 4): one live copy of the approval card and of the question card.
import { useState } from "react";

import { type ApprovalDecision, ApprovalSlot, type PendingApproval } from "../src/components/composer/approval";
import { ComposerCard, ComposerFooter, ComposerTools, PlusButton } from "../src/components/composer/composer";
import { ComposerField } from "../src/components/composer/field";
import { SendButton } from "../src/components/composer/send-button";
import { LevelPill, ModelPill } from "./composer";
import { QuestionGallery } from "./questions";
import { Section } from "./parts";

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

const later = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));
/** Approvals coming and answered: Rust's stand-in takes each answer a moment later. */
function Live() {
  const [approvals, setApprovals] = useState(ALL);
  const [log, setLog] = useState<string[]>([]);
  const answer = async (id: string, decision: ApprovalDecision, reason?: string) => {
    await later(500);
    setApprovals((list) => list.filter((each) => each.id !== id));
    setLog((lines) => [...lines.slice(-3), `${decision}${reason ? ` “${reason}”` : ""} · ${id}`]);
  };
  const again = () => setApprovals((list) => [...list, ...ALL.map((each) => ({ ...each, id: crypto.randomUUID() }))]);
  const slot = approvals.length > 0;
  return (
    <div className="flex w-reading flex-col gap-3">
      <ol className="flex flex-col gap-1 text-sm text-muted-foreground">
        {log.map((line, at) => (
          <li key={at}>{line}</li>
        ))}
        <li>
          <button type="button" className="cursor-pointer text-link hover:underline" onClick={again}>
            Every kind again
          </button>
        </li>
      </ol>
      <div>
        {slot && <ApprovalSlot approvals={approvals} onAnswer={answer} />}
        {/* Kept while an approval has its place, so the draft and its caret stay. */}
        <ComposerCard className={slot ? "hidden" : undefined}>
          <ComposerField placeholder="Do anything" />
          <ComposerFooter>
            <ComposerTools>
              <PlusButton />
              <LevelPill />
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
    <>
      <Section title="Approval card">
        <Live />
      </Section>
      <QuestionGallery />
    </>
  );
}
