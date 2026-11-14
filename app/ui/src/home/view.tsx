import { type ReactNode, useEffect, useRef, useState } from "react";

import { Button } from "../components/button";
import { SharedComposer } from "../components/composer/composer";
import { type Draft, isEmpty, plainText } from "../components/composer/draft";
import { ComposerField, type ComposerFieldHandle } from "../components/composer/field";
import { type ModelChoice, type ModelGroup, ModelPicker } from "../components/composer/model-picker";
import { ChipContext, ComposerChip } from "../components/composer/chip";
import { NoticeRow, RailItem } from "../components/composer/rail";
import { SendButton } from "../components/composer/send-button";
import { showToast } from "../components/toast";
import { openThread } from "../daemon";
import { BrigadierMark } from "../onboarding/mark";
import { daemonRun } from "../session/composer";
import { HOME_DRAFT } from "../session/draft";
import { useComposerCommands } from "../session/commands";
import { payload, useComposerFiles } from "../session/files";
import { BranchPicker, type RepoState } from "./branch";
import { type DraftProject, ProjectPicker, UtilityBar, type WorkIn, WorkInPicker } from "./pills";

/** "Good morning" from five until noon, "Good afternoon" until six, else "Good evening" (the old app's). */
function greeting(now: number): string {
  const hour = new Date(now).getHours();
  return hour < 5 || hour >= 18 ? "Good evening" : hour < 12 ? "Good morning" : "Good afternoon";
}

/** The hour's greeting, kept current while it shows. */
function useGreeting(on: boolean): string {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!on) return;
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, [on]);
  return greeting(now);
}

export type HomeProps = {
  /** The name onboarding asked for; no greeting without one. */
  name: string;
  /** undefined while the projects load. */
  projects: readonly DraftProject[] | undefined;
  project: DraftProject | null;
  onProject: (id: string) => void;
  /** Opens Add project, on a typed folder if any. */
  onAddProject: (path: string) => void;
  /** "Don't work in a project": the draft becomes a chat [D388]. */
  onNoProject: () => void;
  workIn: WorkIn;
  onWorkIn: (next: WorkIn) => void;
  /** The session already in the project's own folder, Rust's: Local checkout waits for a worktree [D306]. */
  localHolder?: { id: string; title: string };
  /** The project's branches and worktrees. */
  repo: RepoState;
  /** The base branch picked here; null: the checked-out one [D392]. */
  base: string | null;
  onBase: (branch: string) => void;
  /** The existing worktree picked here. */
  worktree: string | null;
  onWorktree: (path: string) => void;
  /** null while the first list loads. */
  groups: ModelGroup[] | null;
  model: ModelChoice | null;
  onModel: (choice: ModelChoice) => void;
  onSetUp?: (provider: string) => void;
  /** Why the models can't be listed. */
  modelError?: string | null;
  /** The permission level pill, 1t's LevelPicker, mounted by the caller. */
  level?: ReactNode;
  offline: boolean;
  /** The draft's text as last left. */
  initial?: Draft;
  onDraft?: (draft: Draft) => void;
  /** The words Rust kept across a restart, if any. */
  loadDraft?: () => Promise<Draft | null>;
  /** `parts`: the draft as Rust takes it, when it holds more than words [D109]. */
  onSend: (text: string, parts?: string) => void;
  /** Changed to put the cursor back in the field (⌘N on Home). */
  focus?: number;
};

/**
 * Home: a new session's draft [D161]. The old app's hero ("What should we build in {project}?", the name a
 * picker) over the composer, whose rail holds the project, Work in and branch pills [D160, D388]; the model pill
 * sits in its footer. With no project it starts a chat. Nothing is made until Send. What needs saying goes on the
 * rail, never under the card, so the composer doesn't move [D388].
 */
export function HomeView(props: HomeProps) {
  const { name, projects, project, offline } = props;
  const salutation = useGreeting(Boolean(name));
  const [empty, setEmpty] = useState(() => !props.initial || isEmpty(props.initial));
  const noModel = props.groups !== null && !props.model;
  const noWorktree = project && props.workIn === "existing" && !props.worktree;
  const holder = project ? props.localHolder : undefined;
  const blocked = offline ? "Reconnecting…" : !projects ? "Loading your projects…" : !props.model ? "Pick a model first" : noWorktree ? "Pick a worktree first" : holder ? "Start in a new worktree" : undefined;
  const field = useRef<ComposerFieldHandle>(null);
  // What the field last reported, for drawing: reading the field mid-draw flushes its update into the draw (React error 520).
  const typed = useRef(props.initial?.parts ?? []);
  const model = props.groups?.find((group) => group.provider === props.model?.provider)?.models.find((each) => each.id === props.model?.model);
  const files = useComposerFiles({ owner: HOME_DRAFT, run: daemonRun, field, backend: props.model?.provider, project: project?.id, images: model?.images !== false, onTiles: (tiles) => props.onDraft?.({ parts: field.current?.parts() ?? [], attachmentIds: tiles }) });
  // Asked once the project and model are known, and again once the project is trusted, whose folder it then reads [D178].
  const extras = useComposerCommands({ owner: HOME_DRAFT, run: daemonRun, field, backend: !projects ? undefined : noModel ? null : props.model?.provider, project: project?.id, fresh: project?.trusted, onFiles: (picked) => picked.forEach((file) => files.attach(crypto.randomUUID(), file, false)) });
  const send = (parts: Draft["parts"]) => {
    const tiles = files.tiles();
    if (isEmpty({ parts, attachmentIds: tiles })) return;
    // Said in a toast: text under the composer would move it [D388].
    const waits = blocked ?? files.hold(parts);
    if (waits) return void showToast(waits);
    props.onSend(plainText(parts).trim(), payload(parts, tiles));
    files.sent();
  };
  useEffect(() => field.current?.focus(), [props.focus]);
  // After a restart the draft is Rust's alone: it comes back unless something was typed first.
  useEffect(() => {
    void props.loadDraft?.().then((saved) => {
      const now = field.current;
      if (!saved || !now || !isEmpty({ parts: now.parts(), attachmentIds: [] })) return;
      now.set(saved.parts);
      files.restore(saved.attachmentIds);
      setEmpty(false);
    });
  }, []);
  const setUp = props.groups?.find((group) => group.unavailable);
  return (
    <div className="scroll-gutter-both flex min-h-0 flex-1 flex-col overflow-y-auto">
      {/* The hero ends a little above the middle and the composer sits at the bottom; each takes half the height. */}
      <div className="flex min-h-fit grow basis-0 flex-col items-center justify-end gap-6 px-4 pb-11 select-none">
        <BrigadierMark spinOnHover className="hero-mark size-16 text-foreground opacity-60 hover:opacity-100" />
        {name && (
          <p className="-mb-3 text-center text-base text-muted-foreground">
            {salutation}, {name}
          </p>
        )}
        <h1 className="text-center font-display text-hero font-normal tracking-hero">
          {project && projects ? (
            <>
              What should we build in{" "}
              <ProjectPicker heading projects={projects} value={project} onChange={props.onProject} onAdd={props.onAddProject} onNone={props.onNoProject} />?
            </>
          ) : (
            "What should we build?"
          )}
        </h1>
      </div>
      <div className="flex grow basis-0 flex-col justify-end">
        <SharedComposer
          rail={
            <>
              {props.modelError && (
                <RailItem label="Notices">
                  <ul aria-live="polite">
                    <NoticeRow level="error">{props.modelError}</NoticeRow>
                  </ul>
                </RailItem>
              )}
              {!props.modelError && noModel && (
                <RailItem label="Notices">
                  <ul aria-live="polite">
                    <NoticeRow
                      level="info"
                      action={
                        setUp &&
                        props.onSetUp && (
                          <Button variant="link-blue" size={null} onClick={() => props.onSetUp?.(setUp.provider)}>
                            Set up {setUp.label}
                          </Button>
                        )
                      }
                    >
                      No model is available.
                    </NoticeRow>
                  </ul>
                </RailItem>
              )}
              {holder && (
                <RailItem label="Notices">
                  <ul aria-live="polite">
                    <NoticeRow
                      level="warning"
                      subject={
                        <ChipContext value={{ onOpen: (_, id) => openThread(id), commands: new Map() }}>
                          <ComposerChip chip={{ kind: "mention", type: "chat", id: holder.id, label: holder.title }} />
                        </ChipContext>
                      }
                      action={
                        <Button variant="link-blue" size={null} onClick={() => props.onWorkIn("worktree")}>
                          New worktree
                        </Button>
                      }
                    >
                      works in the local checkout. Start this session in a new worktree.
                    </NoticeRow>
                  </ul>
                </RailItem>
              )}
              <RailItem variant="controls" label="Composer utility bar">
                {/* Hidden, not absent, while the projects load: it holds its place and never reads "Choose project" by mistake. */}
                <UtilityBar className={projects ? undefined : "invisible"}>
                  <ProjectPicker projects={projects ?? []} value={project} onChange={props.onProject} onAdd={props.onAddProject} onNone={props.onNoProject} />
                  {project && (
                    <>
                      <WorkInPicker value={props.workIn} onChange={props.onWorkIn} repo={project.name} />
                      <BranchPicker workIn={props.workIn} repo={props.repo} name={project.name} base={props.base} worktree={props.worktree} onBase={props.onBase} onWorktree={props.onWorktree} />
                    </>
                  )}
                </UtilityBar>
              </RailItem>
            </>
          }
          onDragOver={files.onDragOver}
          onDrop={files.onDrop}
          tiles={files.tilesRow}
          plus={extras.plus}
          level={props.level}
          model={props.model && <ModelPicker groups={props.groups ?? []} value={props.model} onChange={props.onModel} onSetUp={props.onSetUp} disabled={offline || props.groups === null} asksSwitch={false} />}
          send={<SendButton empty={empty && files.tileIds.length === 0} running={false} canStop={false} blocked={blocked ?? files.hold(typed.current)} onSend={() => send(field.current?.parts() ?? [])} onStop={() => {}} />}
        >
          <ComposerField
            ref={field}
            initial={props.initial}
            placeholder="Do anything"
            autoFocus
            attachments={files.attachments}
            onAttach={files.attach}
            mentions={files.mentions}
            commands={extras.commands}
            onOpen={extras.onOpen}
            onChange={(parts) => {
              typed.current = parts;
              setEmpty(isEmpty({ parts, attachmentIds: [] }));
              props.onDraft?.({ parts, attachmentIds: files.tileIds });
            }}
            onSubmit={() => send(field.current?.parts() ?? [])}
          />
        </SharedComposer>
      </div>
    </div>
  );
}
