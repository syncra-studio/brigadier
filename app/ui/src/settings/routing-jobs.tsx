import { DragDropProvider } from "@dnd-kit/react";
import { isSortable, useSortable } from "@dnd-kit/react/sortable";
import { type ComponentType, type ReactNode, useState } from "react";

import { Button } from "../components/button";
import type { ModelGroup } from "../components/composer/model-picker";
import { cx } from "../components/cx";
import { ErrorLine } from "../components/error-line";
import { TooltipIconButton } from "../components/icon-button";
import { Input } from "../components/input";
import { RowText, SettingsCard } from "../components/settings-card";
import { Bolt, Code, Globe, type IconProps, MagnifyingGlassSearch, Nodes, Pencil, Plus, ShieldExclamation, Sparkle, X } from "../icons";
import { SettingsSection } from "./parts";
import { type Entry, type Job, type Offer, ROUTING_ROWS } from "./routing";
import { OrderList } from "./routing-order";

/** The job reviews run on: it can't be renamed or deleted (spec §2). */
const REVIEW_JOB = "Review";

/** An offer's answer (C5): Use it, Not now (7 days), Don't offer again. */
export type Answer = "use" | "later" | "never";

/** A seed job keeps its icon by its name; any other job has the plain one [D392 P2]. */
const ICONS: Readonly<Record<string, ComponentType<IconProps>>> = {
  "Write code": Code,
  "Look into the codebase": MagnifyingGlassSearch,
  "Research the web": Globe,
  "Plan and orchestrate": Nodes,
  "Quick actions": Bolt,
  [REVIEW_JOB]: ShieldExclamation,
};

const BLANK: Job = { name: "", for: "", entries: [] };

/**
 * Jobs: one card, each job a block, its header (dragged to reorder), its editor when open, its offer, then its order,
 * always open [D383, D388 Q22]. New job adds a block with its editor; Rust's refusals show in the editor [D388 Q14].
 * A job-less offer is a quiet line under the card [D386]. A taken offer reads its `done` with Undo until the page
 * closes; Undo saves the job's order from before.
 */
export function Jobs({
  jobs,
  offers,
  groups,
  failed,
  editing,
  draft,
  onEditing,
  onDraft,
  onSave,
  onAnswer,
}: {
  jobs: Job[];
  offers: Offer[];
  groups: ModelGroup[];
  failed: string | null;
  editing: string | null;
  draft: Job | null;
  onEditing: (job: string | null) => void;
  onDraft: (job: Job | null) => void;
  onSave: (jobs: Job[]) => Promise<boolean>;
  onAnswer: (offer: Offer, answer: Answer) => Promise<boolean>;
}) {
  const [used, setUsed] = useState<{ offer: Offer; before: Entry[] }[]>([]);
  // A refused rename's typed job, kept in its editor beside Rust's words while they show [U1].
  const [refused, setRefused] = useState<{ from: string; typed: Job } | null>(null);
  const forget = (offer: Offer) => setUsed((now) => now.filter((each) => each.offer !== offer));
  const put = (name: string, next: Job) => onSave(jobs.map((job) => (job.name === name ? next : job)));
  const move = (from: number, to: number) => {
    const rest = jobs.filter((_, index) => index !== from);
    rest.splice(to, 0, jobs[from]!);
    void onSave(rest);
  };
  const add = (job: Job) => {
    onDraft(null);
    void onSave([...jobs, job]).then((ok) => ok || onDraft(job));
  };
  return (
    <SettingsSection
      title={ROUTING_ROWS.jobs.label}
      description={ROUTING_ROWS.jobs.description}
      setting={ROUTING_ROWS.jobs.label}
      actions={
        <Button
          variant="soft"
          size="sm"
          data-slot="new-job"
          onClick={() => {
            onEditing(null);
            onDraft(BLANK);
          }}
        >
          <Plus aria-hidden />
          New job
        </Button>
      }
    >
      <SettingsCard inset data-slot="jobs">
        <DragDropProvider
          // Blocks differ in height, and dnd-kit keeps their places from before a move it didn't make (↑ ↓, Undo): start afresh.
          key={jobs.map((job) => job.name).join("\n")}
          onDragEnd={({ operation, canceled }) => {
            const { source } = operation;
            if (!canceled && isSortable(source) && source.index !== source.initialIndex) move(source.initialIndex, source.index);
          }}
        >
          {jobs.map((job, index) => {
            const open = editing === job.name;
            const offer = offers.find((each) => each.job === job.name);
            const taken = used.find((each) => each.offer.job === job.name);
            return (
              <SortableJob
                key={job.name}
                job={job}
                index={index}
                count={jobs.length}
                open={open}
                onMove={(to) => move(index, to)}
                onEdit={() => {
                  onDraft(null);
                  onEditing(open ? null : job.name);
                }}
              >
                {open && (
                  <JobEditor
                    job={job}
                    typed={failed && refused?.from === job.name ? refused.typed : job}
                    error={failed}
                    onCommit={(next) => {
                      if (next.name !== job.name) onEditing(next.name);
                      void put(job.name, next).then((ok) => {
                        if (ok) return;
                        setRefused({ from: job.name, typed: next });
                        onEditing(job.name);
                      });
                    }}
                    actions={
                      job.name !== REVIEW_JOB && (
                        <Button
                          variant="soft-destructive"
                          size="sm"
                          onClick={() => {
                            onEditing(null);
                            void onSave(jobs.filter((other) => other !== job));
                          }}
                        >
                          Delete job
                        </Button>
                      )
                    }
                  />
                )}
                {taken ? (
                  <Strip title={taken.offer.done} done>
                    <Button
                      variant="link-blue"
                      size="inline"
                      onClick={() => {
                        forget(taken.offer);
                        void put(job.name, { ...job, entries: taken.before });
                      }}
                    >
                      Undo
                    </Button>
                  </Strip>
                ) : (
                  offer && (
                    <OfferStrip
                      offer={offer}
                      onAnswer={(answer) => {
                        if (answer === "use") setUsed((now) => [...now, { offer, before: job.entries }]);
                        void onAnswer(offer, answer).then((ok) => ok || forget(offer));
                      }}
                    />
                  )
                )}
                <OrderList title={job.name} order={job.entries} groups={groups} onSave={(entries) => void put(job.name, { ...job, entries })} />
              </SortableJob>
            );
          })}
        </DragDropProvider>
        {draft && (
          <div data-slot="job" className="flex flex-col">
            <JobHead job={draft} />
            <JobEditor
              job={draft}
              error={failed}
              onType={onDraft}
              onCommit={add}
              actions={
                <>
                  <Button variant="soft" size="sm" type="submit">
                    Add job
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => onDraft(null)}>
                    Cancel
                  </Button>
                </>
              }
            />
            <OrderList title={draft.name} order={draft.entries} groups={groups} onSave={(entries) => onDraft({ ...draft, entries })} />
          </div>
        )}
      </SettingsCard>
      {offers
        .filter((offer) => offer.job === null)
        .map((offer) => (
          <p key={offer.id} data-slot="quiet-offer" className="flex items-center gap-3 px-1 text-label text-quiet-foreground">
            <span className="min-w-0 flex-1">{offer.title}</span>
            <button type="button" aria-label="Dismiss" onClick={() => void onAnswer(offer, "never")} className="shrink-0 cursor-pointer text-muted-foreground hover:text-foreground">
              <X aria-hidden className="size-3.75" />
            </button>
          </p>
        ))}
    </SettingsSection>
  );
}

/** A job's header: its icon, name and line; `handle` drags it, and the pencil opens its editor. */
function JobHead({ job, handle, children }: { job: Job; handle?: { ref: (element: Element | null) => void; onMove: (by: number) => void }; children?: ReactNode }) {
  const Icon = ICONS[job.name] ?? Sparkle;
  const words = (
    <>
      <Icon aria-hidden className="size-4 shrink-0 text-quiet-foreground" />
      <RowText title={job.name || "New job"} line={job.for} />
    </>
  );
  return (
    <div data-slot="job-head" className="flex items-center gap-3.5 py-3.5">
      {handle ? (
        <button
          ref={handle.ref}
          type="button"
          data-job={job.name}
          title="Drag to reorder, or focus and press ↑ ↓"
          onKeyDown={(event) => {
            const by = event.key === "ArrowUp" ? -1 : event.key === "ArrowDown" ? 1 : 0;
            if (!by) return;
            event.preventDefault();
            handle.onMove(by);
            // Moving the block draws it afresh; give its header focus back so ↑ ↓ keep going.
            const card = event.currentTarget.closest("[data-slot=jobs]");
            requestAnimationFrame(() => card?.querySelector<HTMLElement>(`[data-job="${CSS.escape(job.name)}"]`)?.focus());
          }}
          className="flex min-w-0 flex-1 cursor-grab touch-none items-center gap-3.5 text-start active:cursor-grabbing"
        >
          {words}
        </button>
      ) : (
        <span className="flex min-w-0 flex-1 items-center gap-3.5">{words}</span>
      )}
      {children}
    </div>
  );
}

/** A job in the card, dragged by its header. */
function SortableJob({
  job,
  index,
  count,
  open,
  onMove,
  onEdit,
  children,
}: {
  job: Job;
  index: number;
  count: number;
  open: boolean;
  onMove: (to: number) => void;
  onEdit: () => void;
  children: ReactNode;
}) {
  const { ref, handleRef, isDragging } = useSortable({ id: job.name, index, disabled: count < 2 });
  const handle = {
    ref: handleRef,
    onMove: (by: number) => {
      const to = index + by;
      if (!isDragging && to >= 0 && to < count) onMove(to);
    },
  };
  return (
    <div ref={ref} data-slot="job" className={cx("flex flex-col", isDragging && "bg-fill-hover")}>
      <JobHead job={job} handle={handle}>
        <TooltipIconButton tooltip="Edit job" aria-label={`Edit ${job.name}`} aria-expanded={open} onClick={onEdit} className="shrink-0 text-muted-foreground">
          <Pencil />
        </TooltipIconButton>
      </JobHead>
      {children}
    </div>
  );
}

/**
 * The editor, in the block over its order: Name and "Use this for", nothing else [D384, D387]. A field saves as it's
 * left or on Enter (`onCommit`); a new job's on Add job or Enter. Review's name can't change, and says why.
 * `typed` opens it on what was typed, not yet saved.
 */
function JobEditor({
  job,
  typed: first = job,
  error,
  onType,
  onCommit,
  actions,
}: {
  job: Job;
  typed?: Job;
  error: string | null;
  onType?: (job: Job) => void;
  onCommit: (job: Job) => void;
  actions: ReactNode;
}) {
  const [typed, setTyped] = useState(first);
  const type = (next: Job) => {
    setTyped(next);
    onType?.(next);
  };
  // Only the two fields over the job as it is now: its order may have changed since this opened. What it opened on, a
  // refused rename, isn't sent again as it's left, so the user can still leave it for another editor.
  const changed = (from: Job) => typed.name !== from.name || typed.for !== from.for;
  const commit = () => (onType || (changed(job) && changed(first))) && onCommit({ ...job, name: typed.name, for: typed.for });
  const fixed = job.name === REVIEW_JOB && !onType;
  const leave = onType ? undefined : commit;
  return (
    <form
      data-slot="job-editor"
      className="flex flex-col gap-2 ps-7.5 pb-3"
      onSubmit={(event) => {
        event.preventDefault();
        commit();
      }}
    >
      <label className="flex flex-col gap-2">
        <span className="text-label text-quiet-foreground">Name</span>
        <Input value={typed.name} readOnly={fixed} onValueChange={(name) => type({ ...typed, name })} onBlur={leave} />
      </label>
      {fixed && <p className="text-xs text-quiet-foreground">Adversarial review runs on this job by its name, so it can't be renamed or deleted.</p>}
      <label className="flex flex-col gap-2 pt-2">
        <span className="text-label text-quiet-foreground">Use this for · what your agents read to pick it</span>
        <Input value={typed.for} onValueChange={(line) => type({ ...typed, for: line })} onBlur={leave} />
      </label>
      <ErrorLine error={error} />
      {/* A job's own editor saves as it's left, with no Save to draw: Enter needs a submit button to submit a form. */}
      {!onType && <button type="submit" hidden />}
      {actions && <div className="flex items-center gap-2 pt-2">{actions}</div>}
      <p className="pt-4 text-label text-quiet-foreground">Models, tried in order · the next runs only when one is out of quota</p>
    </form>
  );
}

/** An offer on its job: what it is, its facts in grey, then Use it · Not now · Don't offer again; an alias notice, OK [D386]. */
function OfferStrip({ offer, onAnswer }: { offer: Offer; onAnswer: (answer: Answer) => void }) {
  const alias = offer.kind === "alias";
  return (
    <Strip title={offer.title} facts={alias ? undefined : offer.facts}>
      {alias ? (
        <Button variant="soft" size="sm" onClick={() => onAnswer("never")}>
          OK
        </Button>
      ) : (
        <>
          <Button variant="soft" size="sm" onClick={() => onAnswer("use")}>
            Use it
          </Button>
          <Button variant="ghost" size="sm" onClick={() => onAnswer("later")}>
            Not now
          </Button>
          <Button variant="ghost" size="sm" onClick={() => onAnswer("never")}>
            Don't offer again
          </Button>
        </>
      )}
    </Strip>
  );
}

/** The offer's box under the header: a blue sparkle, its line, its grey facts, its buttons. A taken one: its `done` · Undo. */
function Strip({ title, facts, done = false, children }: { title: string; facts?: string; done?: boolean; children: ReactNode }) {
  return (
    <div data-slot="offer" className="ms-7.5 mb-1.5 flex gap-2.5 rounded-settings bg-fill-subtle px-3.5 py-3">
      <Sparkle aria-hidden className="mt-0.5 size-4 shrink-0 text-link" />
      {done ? (
        <p className="min-w-0 flex-1 text-label">
          {title} · {children}
        </p>
      ) : (
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <p className="text-label font-medium">{title}</p>
          {facts && <p className="text-xs text-quiet-foreground">{facts}</p>}
          <div className="flex items-center gap-1 pt-1.5">{children}</div>
        </div>
      )}
    </div>
  );
}
