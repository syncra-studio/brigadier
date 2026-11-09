import { type ReactNode, useEffect, useRef, useState } from "react";

import { Button } from "../components/button";
import { Composer, ComposerCard, ComposerFooter, ComposerTools } from "../components/composer/composer";
import { type Draft, isEmpty, plainText } from "../components/composer/draft";
import { ComposerField, type ComposerFieldHandle } from "../components/composer/field";
import { type ModelChoice, type ModelGroup, ModelPicker } from "../components/composer/model-picker";
import { ComposerRail, RailItem } from "../components/composer/rail";
import { SendButton } from "../components/composer/send-button";
import { ErrorLine } from "../components/error-line";
import { BrigadierMark } from "../onboarding/mark";
import { type DraftProject, ProjectPicker, type WorkIn, WorkInPicker } from "./pills";

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
  workIn: WorkIn;
  onWorkIn: (next: WorkIn) => void;
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
  onSend: (text: string) => void;
  /** Changed to put the cursor back in the field (⌘N on Home). */
  focus?: number;
  /** The gallery's box to hold a picker open in. */
  held?: { box: HTMLElement; picker: "project" | "workIn" | "heading" };
};

/**
 * Home: a new session's draft [D161]. The old app's hero ("What should we build in {project}?", the name a
 * picker) over the composer, whose rail holds the project and Work in pills [D160]; the model pill sits in its
 * footer. With no project yet it asks for one first. Nothing is made until Send.
 */
export function HomeView(props: HomeProps) {
  const { name, projects, project, offline, held } = props;
  const salutation = useGreeting(Boolean(name));
  const [empty, setEmpty] = useState(() => !props.initial || isEmpty(props.initial));
  const none = projects?.length === 0;
  const noModel = props.groups !== null && !props.model;
  const blocked = offline ? "Reconnecting…" : !project ? "Choose a project first" : !props.model ? "Pick a model first" : undefined;
  const send = (parts: Draft["parts"]) => {
    if (blocked || isEmpty({ parts, attachmentIds: [] })) return;
    props.onSend(plainText(parts).trim());
  };
  const field = useRef<ComposerFieldHandle>(null);
  useEffect(() => field.current?.focus(), [props.focus]);
  const setUp = props.groups?.find((group) => group.unavailable);
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
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
              <ProjectPicker heading projects={projects} value={project} onChange={props.onProject} onAdd={props.onAddProject} held={held?.picker === "heading" ? held.box : undefined} />?
            </>
          ) : (
            "What should we build?"
          )}
        </h1>
        {none && (
          <div className="flex flex-col items-center gap-3">
            <p className="text-sm text-muted-foreground">Add a project to start a session in it.</p>
            <Button onClick={() => props.onAddProject("")}>Add a project</Button>
          </div>
        )}
      </div>
      <div className="flex grow basis-0 flex-col justify-end">
      {projects && !none && (
        <Composer>
          <ComposerRail>
            <RailItem variant="controls" label="Composer utility bar">
              <div className="flex items-center gap-2 px-1 py-1.25">
                <ProjectPicker projects={projects} value={project} onChange={props.onProject} onAdd={props.onAddProject} held={held?.picker === "project" ? held.box : undefined} />
                {project && <WorkInPicker value={props.workIn} onChange={props.onWorkIn} repo={project.name} held={held?.picker === "workIn" ? held.box : undefined} />}
              </div>
            </RailItem>
          </ComposerRail>
          <ComposerCard>
            <ComposerField
              ref={field}
              initial={props.initial}
              placeholder="Do anything"
              autoFocus
              onChange={(parts) => {
                setEmpty(isEmpty({ parts, attachmentIds: [] }));
                props.onDraft?.({ parts, attachmentIds: [] });
              }}
              onSubmit={() => send(field.current?.parts() ?? [])}
            />
            <ComposerFooter>
              {props.level}
              <ComposerTools />
              {props.model && <ModelPicker groups={props.groups ?? []} value={props.model} onChange={props.onModel} onSetUp={props.onSetUp} disabled={offline || props.groups === null} asksSwitch={false} />}
              <SendButton empty={empty} running={false} canStop={false} blocked={blocked} onSend={() => send(field.current?.parts() ?? [])} onStop={() => {}} />
            </ComposerFooter>
          </ComposerCard>
          <ErrorLine error={props.modelError} className="px-2 pt-2 text-xs" />
          {!props.modelError && noModel && (
            <p className="flex items-center gap-2 px-2 pt-2 text-xs text-muted-foreground">
              No model is available.
              {setUp && props.onSetUp && (
                <Button variant="link-blue" size={null} onClick={() => props.onSetUp?.(setUp.provider)}>
                  Set up {setUp.label}
                </Button>
              )}
            </p>
          )}
        </Composer>
      )}
      </div>
    </div>
  );
}
