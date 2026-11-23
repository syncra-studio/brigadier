// Mockup fixture, fake data: Remove project's branch choice up front and the summary after [mockup round 1].
// ?v=A|B|C picks the variant. Never imported by the app.
import { type ReactNode, useState } from "react";
import { createRoot } from "react-dom/client";

import { Button } from "../../src/components/button";
import { CheckboxRow } from "../../src/components/checkbox-row";
import { ConfirmForm } from "../../src/components/confirm-dialog";
import { CopyButton } from "../../src/components/copy-button";
import { cx } from "../../src/components/cx";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../../src/components/dialog";
import { Radio, RadioGroup } from "../../src/components/radio";
import { Segmented } from "../../src/components/segmented";
import { Select } from "../../src/components/select";
import { TooltipProvider } from "../../src/components/tooltip";
import { Branch, Chats, CheckCircle, Folder, Spinner, StickyNote } from "../../src/icons";
import "../../src/theme.css";
import "../fixtures.css";

const NAME = "brigadier";
const REPO = "~/code/brigadier";
const BRANCHES = [
  { branch: "brigadier/lid-flicker", title: "Lid switch flickers" },
  { branch: "brigadier/remove-project", title: "Remove project dialog" },
  { branch: "brigadier/pr-inbox-sort", title: "Sort the PR inbox" },
  { branch: "brigadier/fork-offer", title: "Fork offer copy" },
  { branch: "brigadier/mcp-retry", title: "MCP server retries" },
];
type Fate = "keep" | "delete" | "pick";
const command = (branches: string[]) => `git -C ${REPO} branch -D ${branches.join(" ")}`;

/** A dialog held open inside its own box, so several sit side by side. */
function Held({ label, height, children }: { label: string; height: string; children: ReactNode }) {
  const [box, setBox] = useState<HTMLDivElement | null>(null);
  return (
    <figure className="flex flex-col gap-2">
      <figcaption className="text-label text-muted-foreground">{label}</figcaption>
      <div ref={setBox} data-held className={cx("relative w-150 translate-0 overflow-hidden rounded-surface bg-sidebar", height)}>
        {box && (
          <Dialog open modal={false}>
            <DialogContent container={box} initialFocus={false} showCloseButton={false} frame="project-dialog max-w-project-dialog gap-5 p-6">
              {children}
            </DialogContent>
          </Dialog>
        )}
      </div>
    </figure>
  );
}

function SummaryRow({ icon, label, detail }: { icon: ReactNode; label: ReactNode; detail: ReactNode }) {
  return (
    <li className="flex min-h-11 items-center gap-3 px-3.5">
      <span className="flex shrink-0 text-muted-foreground svg:size-icon-md">{icon}</span>
      <span className="min-w-0 flex-1 truncate text-foreground">{label}</span>
      <span className="shrink-0 text-label text-muted-foreground">{detail}</span>
    </li>
  );
}
const List = ({ children }: { children: ReactNode }) => <ul className="flex flex-col divide-y divide-divider rounded-surface bg-fill-subtle">{children}</ul>;
const WHAT = [
  <SummaryRow key="s" icon={<Chats />} label="14 sessions" detail="Can't be undone" />,
  <SummaryRow key="n" icon={<StickyNote />} label="3 notes" detail="With their chats" />,
  <SummaryRow key="w" icon={<Folder />} label="6 worktrees" detail="1.4 GB" />,
  <SummaryRow key="m" icon={<Branch />} label="4 merged branches" detail="Already landed" />,
];

/** Pick's list: one checkbox per branch with work that never landed. */
function PickList({ picked, onPicked, className }: { picked: ReadonlySet<string>; onPicked: (next: ReadonlySet<string>) => void; className?: string }) {
  return (
    <div className={cx("flex flex-col gap-2", className)}>
      {BRANCHES.map(({ branch, title }) => (
        <CheckboxRow
          key={branch}
          label={`Delete ${branch}`}
          note={`“${title}”`}
          checked={picked.has(branch)}
          onCheckedChange={(on) => {
            const next = new Set(picked);
            if (on) next.add(branch);
            else next.delete(branch);
            onPicked(next);
          }}
        />
      ))}
    </div>
  );
}

const deleted = (fate: Fate, picked: ReadonlySet<string>) => (fate === "delete" ? BRANCHES.length : fate === "pick" ? picked.size : 0);
const fateLine = (fate: Fate, picked: ReadonlySet<string>) => {
  const n = deleted(fate, picked);
  return n === 0 ? "All 5 are kept, with their work." : n === BRANCHES.length ? "All 5 are deleted, with their work." : `${n} deleted, ${BRANCHES.length - n} kept.`;
};

/** The form, its branch question in the variant's look. */
function Form({ question }: { question: ReactNode }) {
  return (
    <ConfirmForm title={`Remove “${NAME}”?`} description={`The repository at ${REPO} stays exactly as it is.`} confirm="Remove" destructive onConfirm={() => {}} onCancel={() => {}}>
      <div className="scroll-gutter -mx-6 flex min-h-0 flex-col gap-5 overflow-y-auto ps-6 pe-3.5">
        <p className="text-sm text-muted-foreground">Only what Brigadier made for this project is deleted:</p>
        {question}
      </div>
    </ConfirmForm>
  );
}

/** The kept branches' one action: deletes them all, then says so. */
function useDeleteKept() {
  const [state, setState] = useState<"idle" | "deleting" | "done">("idle");
  const go = () => {
    setState("deleting");
    setTimeout(() => setState("done"), 900);
  };
  return { state, go };
}

/** The command, copyable, on one line that scrolls sideways. */
function Command({ text }: { text: string }) {
  return (
    <div className="flex min-w-0 items-center gap-1 rounded-control bg-fill-subtle ps-3 pe-1">
      <code className="min-w-0 flex-1 overflow-x-auto py-2 font-mono text-xs whitespace-nowrap text-muted-foreground select-text">{text}</code>
      <CopyButton text={text} tooltip="Copy command" size="icon-sm" variant="ghost" />
    </div>
  );
}

// ——— A: a segmented Keep all · Delete all · Pick under the list; after, the same list as what happened.

function FormA({ start = "keep" }: { start?: Fate }) {
  const [fate, setFate] = useState<Fate>(start);
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set(start === "pick" ? [BRANCHES[0]!.branch, BRANCHES[3]!.branch] : []));
  return (
    <Form
      question={
        <>
          <List>{WHAT}</List>
          <div className="flex flex-col gap-2.5">
            <p className="text-xs text-muted-foreground">5 branches have work that never landed. {fateLine(fate, picked)}</p>
            <Segmented
              label="Branches with work that never landed"
              fill
              value={fate}
              onChange={setFate}
              options={[
                { value: "keep", label: "Keep all" },
                { value: "delete", label: "Delete all" },
                { value: "pick", label: "Pick" },
              ]}
            />
            {fate === "pick" && <PickList picked={picked} onPicked={setPicked} className="pt-1" />}
          </div>
        </>
      }
    />
  );
}

function RemovedA() {
  const kept = BRANCHES.map(({ branch }) => branch);
  const { state, go } = useDeleteKept();
  return (
    <>
      <DialogHeader>
        <DialogTitle>“{NAME}” was removed</DialogTitle>
        <DialogDescription>Its repository was not touched.</DialogDescription>
      </DialogHeader>
      <List>
        <SummaryRow icon={<Chats />} label="14 sessions, 3 notes" detail="Deleted" />
        <SummaryRow icon={<Folder />} label="6 worktrees" detail="1.4 GB freed" />
        <SummaryRow icon={<Branch />} label="4 merged branches" detail="Deleted" />
        <SummaryRow
          icon={state === "done" ? <CheckCircle /> : <Branch />}
          label={state === "done" ? "5 kept branches" : "5 branches kept"}
          detail={state === "done" ? "Deleted" : "Unmerged work"}
        />
      </List>
      {state !== "done" && (
        <div className="flex flex-col gap-1.5">
          <p className="text-xs text-muted-foreground">Or delete them yourself later:</p>
          <Command text={command(kept)} />
        </div>
      )}
      <DialogFooter>
        {state !== "done" && (
          <Button variant="soft-destructive" disabled={state === "deleting"} onClick={go}>
            {state === "deleting" && <Spinner className="size-icon-xs animate-spin motion-reduce:animate-none" />}
            Delete 5 kept branches
          </Button>
        )}
        <Button onClick={() => {}}>Done</Button>
      </DialogFooter>
    </>
  );
}

// ——— B: three radio choices with what each means; after, one sentence and a box for what stayed.

function FormB({ start = "keep" }: { start?: Fate }) {
  const [fate, setFate] = useState<Fate>(start);
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set(start === "pick" ? [BRANCHES[0]!.branch, BRANCHES[3]!.branch] : []));
  const choice = (value: Fate, label: string, hint: string) => (
    <label className="flex cursor-pointer items-start gap-2.5">
      <Radio value={value} className="mt-px" />
      <span className="grid gap-0.5">
        <span className="text-label leading-4">{label}</span>
        <span className="text-xs leading-3.75 text-quiet-foreground">{hint}</span>
      </span>
    </label>
  );
  return (
    <Form
      question={
        <>
          <List>{WHAT}</List>
          <fieldset className="flex flex-col gap-3">
            <legend className="mb-3 text-label font-medium text-foreground">5 branches have work that never landed</legend>
            <RadioGroup value={fate} onValueChange={(value) => setFate(value as Fate)} className="flex flex-col gap-3">
              {choice("keep", "Keep all 5", `They stay in ${REPO}; you can delete them later.`)}
              {choice("delete", "Delete all 5", "Their commits are gone for good.")}
              {choice("pick", "Pick which go", fate === "pick" ? fateLine(fate, picked) : "Choose branch by branch.")}
            </RadioGroup>
            {fate === "pick" && <PickList picked={picked} onPicked={setPicked} className="ms-6.5" />}
          </fieldset>
        </>
      }
    />
  );
}

function RemovedB() {
  const kept = BRANCHES.map(({ branch }) => branch);
  const { state, go } = useDeleteKept();
  return (
    <>
      <DialogHeader>
        <DialogTitle>“{NAME}” was removed</DialogTitle>
        <DialogDescription>14 sessions, 3 notes, 6 worktrees (1.4 GB) and 4 merged branches are gone. Its repository was not touched.</DialogDescription>
      </DialogHeader>
      <section className="flex flex-col gap-3 rounded-surface bg-fill-subtle p-3.5">
        {state === "done" ? (
          <p className="flex items-center gap-2 text-sm">
            <CheckCircle className="size-icon-md text-muted-foreground" />
            The 5 kept branches were deleted.
          </p>
        ) : (
          <>
            <div className="flex items-start justify-between gap-3">
              <div className="flex min-w-0 flex-col gap-1">
                <h3 className="text-label font-medium">5 branches kept with unmerged work</h3>
                <p className="text-xs leading-4.25 text-muted-foreground">{kept.map((each) => each.replace("brigadier/", "")).join(", ")}</p>
              </div>
              <Button variant="soft-destructive" size="sm" className="shrink-0" disabled={state === "deleting"} onClick={go}>
                {state === "deleting" && <Spinner className="size-icon-xs animate-spin motion-reduce:animate-none" />}
                Delete 5 kept branches
              </Button>
            </div>
            <Command text={command(kept)} />
          </>
        )}
      </section>
      <DialogFooter>
        <Button onClick={() => {}}>Done</Button>
      </DialogFooter>
    </>
  );
}

// ——— C: the branches are a row of the list with its own menu; after, the list ticks off and the kept row acts.

function FormC({ start = "keep" }: { start?: Fate }) {
  const [fate, setFate] = useState<Fate>(start);
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set(start === "pick" ? [BRANCHES[0]!.branch, BRANCHES[3]!.branch] : []));
  const n = deleted(fate, picked);
  return (
    <Form
      question={
        <ul className="flex flex-col divide-y divide-divider rounded-surface bg-fill-subtle">
          {WHAT}
          <li className="flex flex-col">
            <div className="flex min-h-11 items-center gap-3 px-3.5">
              <span className="flex shrink-0 text-muted-foreground svg:size-icon-md">
                <Branch />
              </span>
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-foreground">5 unmerged branches</span>
              </span>
              <Select
                label="Unmerged branches"
                value={fate}
                onChange={setFate}
                options={[
                  { value: "keep", label: "Keep all", hint: "Their work stays in the repository" },
                  { value: "delete", label: "Delete all", hint: "Their commits are gone for good" },
                  { value: "pick", label: "Pick…", shown: n ? `Delete ${n} of 5` : "Pick…", hint: "Choose branch by branch" },
                ]}
              />
            </div>
            {fate === "pick" && <PickList picked={picked} onPicked={setPicked} className="border-t border-divider px-3.5 py-3" />}
          </li>
        </ul>
      }
    />
  );
}

function RemovedC() {
  const kept = BRANCHES.map(({ branch }) => branch);
  const { state, go } = useDeleteKept();
  const done = <CheckCircle className="text-muted-foreground" />;
  return (
    <>
      <DialogHeader>
        <DialogTitle>“{NAME}” was removed</DialogTitle>
        <DialogDescription>Its repository was not touched.</DialogDescription>
      </DialogHeader>
      <ul className="flex flex-col divide-y divide-divider rounded-surface bg-fill-subtle">
        <SummaryRow icon={done} label="14 sessions" detail="Deleted" />
        <SummaryRow icon={done} label="3 notes" detail="Deleted" />
        <SummaryRow icon={done} label="6 worktrees" detail="1.4 GB freed" />
        <SummaryRow icon={done} label="4 merged branches" detail="Deleted" />
        {state === "done" ? (
          <SummaryRow icon={done} label="5 kept branches" detail="Deleted" />
        ) : (
          <li className="flex flex-col gap-2.5 px-3.5 py-2.5">
            <div className="flex items-center gap-3">
              <span className="flex shrink-0 text-muted-foreground svg:size-icon-md">
                <Branch />
              </span>
              <span className="min-w-0 flex-1 truncate">5 branches kept, unmerged</span>
              <Button variant="soft-destructive" size="sm" disabled={state === "deleting"} onClick={go}>
                {state === "deleting" && <Spinner className="size-icon-xs animate-spin motion-reduce:animate-none" />}
                Delete 5 kept branches
              </Button>
            </div>
            <Command text={command(kept)} />
          </li>
        )}
      </ul>
      <DialogFooter>
        <Button onClick={() => {}}>Done</Button>
      </DialogFooter>
    </>
  );
}

const VARIANTS = {
  A: { name: "Segmented choice", Form: FormA, Removed: RemovedA },
  B: { name: "Radio choices", Form: FormB, Removed: RemovedB },
  C: { name: "Row with menu", Form: FormC, Removed: RemovedC },
};
const v = (new URLSearchParams(location.search).get("v") ?? "A") as keyof typeof VARIANTS;
const { name, Form: VForm, Removed: VRemoved } = VARIANTS[v] ?? VARIANTS.A;
document.title = `${v} · ${name} · Remove project`;

createRoot(document.getElementById("root")!).render(
  <TooltipProvider>
    {/* Shrinks to show the three side by side in a narrow frame. */}
    <main className="flex items-start gap-6 p-6" style={{ zoom: Math.min(1, innerWidth / 1990) }}>
      <Held label="Before · the choice up front" height="h-150">
        <VForm />
      </Held>
      <Held label="Before · Pick" height="h-190">
        <VForm start="pick" />
      </Held>
      <Held label="After · 5 branches kept" height="h-130">
        <VRemoved />
      </Held>
    </main>
  </TooltipProvider>,
);
