import { useEffect, useRef, useState, useSyncExternalStore } from "react";

import type { ModelChoice, ModelGroup } from "../components/composer/model-picker";
import { Button } from "../components/button";
import { ErrorLine } from "../components/error-line";
import { UserBubble } from "../components/thread/message";
import { OpeningRow, ROW, Words } from "../components/thread/activity-row";
import { threadSource, useDaemon } from "../daemon";
import { Branch } from "../icons";
import { errorText, run, useProfile } from "../onboarding/api";
import { useProjects } from "../projects/projects";
import { openAddProject } from "../projects/store";
import { asGroups } from "../session/model";
import { SetUpAgentDialog } from "../session/set-up";
import { discard, retry, setHomeDraft, start, useHomeDraft, useStarting } from "./start";
import { HomeView } from "./view";

/** What a row tells of the model its session last ran on (1q's fold). */
type Ran = { project: string | null; sent: number; backend: string; model?: string | null; effort?: string | null };

/**
 * Home's draft on Rust's data [D161]. The project: the one picked here, else the one last sent to, else the first
 * added. The model: the one picked here, else the project's last session's, else the first an agent offers there,
 * one on this computer first; only a model the list still has counts [D129].
 */
export function HomeDraft() {
  const { daemon, rows } = useDaemon();
  const name = useProfile().value?.name ?? "";
  const projects = useProjects()?.filter((each) => !each.pending);
  const draft = useHomeDraft();
  const ran = (rows ?? []) as Ran[];
  const latest = (project?: string) => ran.filter((row) => (project ? row.project === project : row.project)).toSorted((a, b) => b.sent - a.sent)[0];
  // A project added from here becomes the draft's once Rust has it (the old app opened its draft).
  const before = useRef<Set<string> | null>(null);
  const added = before.current && projects?.find((each) => !before.current!.has(each.id));
  useEffect(() => {
    if (!added) return;
    before.current = null;
    setHomeDraft({ project: added.id });
  }, [added]);
  const project = projects?.find((each) => each.id === draft.project) ?? projects?.find((each) => each.id === latest()?.project) ?? projects?.[0] ?? null;

  const [groups, setGroups] = useState<ModelGroup[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [setUp, setSetUp] = useState<string | null>(null);
  const asked = useRef(0);
  const folder = project?.folder;
  const load = () => {
    if (!folder) return;
    const mine = ++asked.current;
    const land = (reply: Record<string, any>) => mine === asked.current && (setGroups(asGroups(reply.groups)), setListError(null));
    // The last check lands at once, then a fresh one over it; only the fresh one's failure shows [D128].
    run(["models", "--cwd", folder]).then(land, () => {});
    run(["models", "--cwd", folder, "--fresh"]).then(land, (cause) => mine === asked.current && setListError(errorText(cause)));
  };
  useEffect(() => {
    if (daemon) load();
  }, [daemon, folder]);

  const has = (choice: ModelChoice | null | undefined): choice is ModelChoice =>
    Boolean(choice && groups?.some((group) => !group.unavailable && group.provider === choice.provider && group.models.some((each) => each.id === choice.model)));
  const last = latest(project?.id);
  const lastChoice = last?.model ? { provider: last.backend, model: last.model, effort: last.effort ?? null } : null;
  const offered = groups?.filter((group) => !group.unavailable).flatMap((group) => group.models.map((each) => ({ group, each })));
  const first = offered?.find(({ each }) => (each as { local?: boolean }).local) ?? offered?.[0];
  const firstChoice = first && { provider: first.group.provider, model: first.each.id, effort: first.each.defaultEffort ?? null };
  // Before the list lands, what it most likely holds shows, unpickable.
  const model = groups === null ? (draft.model ?? lastChoice) : ([draft.model, lastChoice, firstChoice].find(has) ?? null);

  return (
    <>
      <HomeView
        name={name}
        projects={projects}
        project={project}
        onProject={(id) => setHomeDraft({ project: id })}
        onAddProject={(path) => {
          before.current = new Set(projects?.map((each) => each.id));
          openAddProject(path);
        }}
        workIn={draft.workIn}
        onWorkIn={(workIn) => setHomeDraft({ workIn })}
        groups={groups}
        model={model}
        onModel={(choice) => setHomeDraft({ model: choice })}
        onSetUp={setSetUp}
        modelError={listError}
        offline={!daemon}
        initial={draft.text}
        onDraft={(text) => setHomeDraft({ text })}
        focus={draft.focus}
        onSend={(text) => project && model && start(project.id, draft.workIn, model, text, draft.level)}
      />
      <SetUpAgentDialog
        name={setUp}
        onClose={() => {
          setSetUp(null);
          load();
        }}
      />
    </>
  );
}

/**
 * A session started from Home: its first message under the thread until Rust says how it went [D30, D54]. Sent:
 * shown sending (unconfirmed while the link is down). Refused: the kit's failed bubble, with Try again and Discard.
 * Logged but not delivered: the thread already shows the message, so only the line saying so, with the same two.
 */
export function StartingBubble({ id }: { id: string }) {
  const entry = useStarting().get(id);
  const session = useSyncExternalStore(threadSource.subscribe, threadSource.get);
  const inThread = Boolean(entry && session?.items.length && session.turns.some((turn) => turn.id === entry.cid));
  if (!entry || (inThread && entry.outcome === "delivered")) return null;
  if (inThread) {
    return (
      <ErrorLine
        size="sm"
        error={entry.error ? `Couldn't send your message · ${entry.error}` : null}
        actions={
          !entry.asking && (
            <>
              <Button variant="link-blue" size={null} onClick={() => retry(id)}>
                Try again
              </Button>
              <Button variant="link-blue" size={null} onClick={() => discard(id)}>
                Discard
              </Button>
            </>
          )
        }
      />
    );
  }
  return (
    <UserBubble
      keep={entry.cid}
      text={entry.text}
      sending={!entry.error && !entry.unknown}
      unconfirmed={entry.unknown}
      failed={entry.error}
      onRetry={entry.asking ? undefined : () => retry(id)}
      onDiscard={entry.asking ? undefined : () => discard(id)}
    />
  );
}

/** Session `id` was started from Home and its thread has nothing yet: StartingThread stands in for it. */
export function useStartShown(id: string): boolean {
  const entry = useStarting().get(id);
  const session = useSyncExternalStore(threadSource.subscribe, threadSource.get);
  return Boolean(entry) && !session?.items.length;
}

/** A started session's thread before Rust has a turn in it: its message in the thread's column. */
export function StartingThread({ id }: { id: string }) {
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto w-full max-w-reading px-6 pt-4 pb-12">
        <StartingBubble id={id} />
      </div>
    </div>
  );
}

/** How the project's setup script went in this session's new worktree (1l), as Rust's row says [D229]. */
export type Setup = { state: "running" | "done" | "failed" | "interrupted"; code: number | null; tail: string } | null | undefined;

const SETUP_WORDS = {
  running: "Running the setup script",
  done: "Ran the setup script",
  failed: "The setup script failed",
  interrupted: "The setup script was interrupted",
} as const;

/** The setup line where the thread meets the composer: its words, opening to the script's last output. */
export function SetupLine({ id, setup }: { id: string; setup: Setup }) {
  if (!setup) return null;
  const words = <Words verb={SETUP_WORDS[setup.state]} live={setup.state === "running"} />;
  const icon = <Branch className="size-4 shrink-0" />;
  if (!setup.tail.trim()) {
    return (
      <div className={ROW}>
        {icon}
        {words}
      </div>
    );
  }
  return (
    <OpeningRow keep={`${id}:setup`} detail={<pre className="font-mono text-xs break-words whitespace-pre-wrap">{setup.tail}</pre>}>
      {icon}
      {words}
    </OpeningRow>
  );
}
