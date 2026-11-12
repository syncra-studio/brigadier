import { useEffect, useRef, useState, useSyncExternalStore } from "react";

import type { ModelChoice, ModelGroup } from "../components/composer/model-picker";
import type { PermissionLevel } from "../components/composer/pickers";
import { Button } from "../components/button";
import { ErrorLine } from "../components/error-line";
import { UserBubble } from "../components/thread/message";
import { SetupRow } from "../components/thread/setup";
import { WorkingLine } from "../components/thread/work";
import { threadSource, useDaemon } from "../daemon";
import { errorText, run, useProfile } from "../onboarding/api";
import { useProjects } from "../projects/projects";
import { openAddProject } from "../projects/store";
import { enterProject } from "../projects/trust";
import { daemonRun } from "../session/composer";
import type { Draft } from "../components/composer/draft";
import { HOME_DRAFT, keepDraft, loadDraft } from "../session/draft";
import { LevelPicker } from "../session/level";
import { asGroups } from "../session/model";
import { SetUpAgentDialog } from "../session/set-up";
import { discard, retry, setHomeDraft, start, useHomeDraft, useHomeProject, useStarting } from "./start";
import { useRepo } from "./branch";
import { HomeView } from "./view";

/** A `models --project` group: the agent's levels, the one a new session there starts on, and whether it's held. */
type LevelGroup = ModelGroup & { levels: PermissionLevel[]; level: PermissionLevel | null; held: boolean };

/** What a row tells of the model its session last ran on (1q's fold). */
type Ran = { project: string | null; sent: number; backend: string; model?: string | null; effort?: string | null };

/**
 * Home's draft on Rust's data [D161]. The project: the one picked here, else the one last sent to, else the first
 * added. The model: the one picked here, else the project's last session's, else the first an agent offers there,
 * one on this computer first; only a model the list still has counts [D129].
 */
export function HomeDraft() {
  const { daemon, rows, projects: savedProjects } = useDaemon();
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
    setHomeDraft({ project: added.id, chat: false });
  }, [added]);
  const project = useHomeProject();

  const [listed, setListed] = useState<{ project: string | undefined; trusted: boolean | null | undefined; groups: LevelGroup[]; fresh: boolean } | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [setUp, setSetUp] = useState<string | null>(null);
  const asked = useRef(0);
  const id = project?.id;
  // Trust this folder? asks about the project Home is drafted in [D167].
  useEffect(() => {
    enterProject(id ?? null);
  }, [id]);
  const trusted = savedProjects?.find((each) => each.id === id)?.trusted;
  const repo = useRepo(id, Boolean(daemon));
  const spot = draft.spot?.project === id ? draft.spot : undefined;
  const known = <T,>(picked: string | undefined, list: T[] | undefined, same: (each: T) => boolean) => (picked && (!list || list.some(same)) ? picked : null);
  // A pick the repository no longer has falls back; until it's read, the pick stands.
  const base = known(spot?.base, repo.info?.branches, (each) => each === spot?.base);
  const worktree = known(spot?.worktree, repo.info?.worktrees, (each) => each.path === spot?.worktree);
  const groups = listed && listed.project === id ? listed.groups : null;
  const fresh = listed?.project === id && listed?.fresh;
  const load = () => {
    const mine = ++asked.current;
    const land = (reply: Record<string, any>, fresh: boolean) => {
      if (mine !== asked.current) return;
      // Cache fills an empty picker or updates trust; otherwise the list already shown wins.
      setListed((now) => !fresh && now && now.project === id && now.trusted === trusted ? now : { project: id, trusted, groups: asGroups(reply.groups) as LevelGroup[], fresh });
      if (fresh) setListError(null);
    };
    const models = id ? ["models", "--project", id] : ["models"];
    run(models).then((reply) => land(reply, false), () => {});
    run([...models, "--fresh"]).then((reply) => land(reply, true), (cause) => mine === asked.current && setListError(errorText(cause)));
  };
  useEffect(() => {
    if (daemon) load();
    return () => { asked.current++; };
  }, [daemon, id, trusted]);
  // Signed in or installed some other way meanwhile (a terminal): it shows when the window comes back, the list kept meanwhile.
  const missing = groups?.some((group) => group.unavailable);
  useEffect(() => {
    if (!missing || !daemon) return;
    window.addEventListener("focus", load);
    return () => window.removeEventListener("focus", load);
  }, [missing, daemon, id, trusted]);

  const has = (choice: ModelChoice | null | undefined): choice is ModelChoice =>
    Boolean(choice && groups?.some((group) => !group.unavailable && group.provider === choice.provider && group.models.some((each) => each.id === choice.model)));
  const last = latest(project?.id);
  const lastChoice = last?.model ? { provider: last.backend, model: last.model, effort: last.effort ?? null } : null;
  const offered = groups?.filter((group) => !group.unavailable).flatMap((group) => group.models.map((each) => ({ group, each })));
  const first = offered?.find(({ each }) => (each as { local?: boolean }).local) ?? offered?.[0];
  const firstChoice = first && { provider: first.group.provider, model: first.each.id, effort: first.each.defaultEffort ?? null };
  // Only a fresh list can disprove a pick; cache may offer the first one, never replace it.
  const model = fresh ? ([draft.model, lastChoice, firstChoice].find(has) ?? null) : (draft.model ?? lastChoice ?? firstChoice ?? null);
  useEffect(() => {
    if (model !== draft.model) setHomeDraft({ model });
  }, [model, draft.model]);
  // The model's agent's levels here; a pick it can't take, or any while held, falls back to Rust's start default [D166, D187, D239].
  const agent = groups?.find((group) => group.provider === model?.provider);
  const pick = agent && !agent.held && agent.levels.includes(draft.level!) ? draft.level : undefined;

  return (
    <>
      <HomeView
        name={name}
        projects={projects}
        project={project}
        onProject={(id) => setHomeDraft({ project: id, chat: false })}
        onNoProject={() => setHomeDraft({ chat: true })}
        onAddProject={(path) => {
          before.current = new Set(projects?.map((each) => each.id));
          openAddProject(path);
        }}
        workIn={draft.workIn}
        onWorkIn={(workIn) => setHomeDraft({ workIn })}
        repo={repo}
        base={base}
        onBase={(branch) => id && setHomeDraft({ spot: { project: id, base: branch, worktree: worktree ?? undefined } })}
        worktree={worktree}
        onWorktree={(path) => id && setHomeDraft({ spot: { project: id, base: base ?? undefined, worktree: path } })}
        // Only a fresh list can say no model is available: a cached one before any check offers none, so it reads as loading.
        groups={fresh || model ? groups : null}
        model={model}
        onModel={(choice) => setHomeDraft({ model: choice })}
        onSetUp={setSetUp}
        level={agent && <LevelPicker levels={agent.levels} level={pick ?? agent.level} held={agent.held} onChange={(level) => setHomeDraft({ level })} />}
        modelError={listError}
        offline={!daemon}
        initial={draft.text}
        onDraft={(text) => {
          setHomeDraft({ text });
          keepDraft(daemonRun, HOME_DRAFT, text);
        }}
        loadDraft={() => loadDraft(daemonRun, HOME_DRAFT)}
        focus={draft.focus}
        onSend={(text, parts) => model && start(id ?? null, { workIn: draft.workIn, base, worktree }, model, text, pick ?? agent?.level ?? undefined, parts)}
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
 * shown sent at once (unconfirmed while the link is down). Refused: the kit's failed bubble, with Try again and Discard.
 * Logged but not delivered: the thread already shows the message, so only the line saying so, with the same two.
 */
export function StartingBubble({ id }: { id: string }) {
  const entry = useStarting().get(id);
  const session = useSyncExternalStore(threadSource.subscribe, threadSource.get);
  const inThread = Boolean(entry && session?.items.length && session.turns.some((turn) => turn.id === entry.cid));
  // In the thread, Rust's row is the message: only a logged-but-not-delivered start says more.
  if (!entry || (inThread && entry.outcome !== "logged")) return null;
  const again = !entry.asking && (
    <>
      <Button variant="link-blue" size={null} onClick={() => retry(id)}>
        Try again
      </Button>
      <Button variant="link-blue" size={null} onClick={() => discard(id)}>
        Discard
      </Button>
    </>
  );
  // A fork has no message: wave 1's setup line until its thread opens with the inherited rows [D30, D160].
  if (entry.fork) {
    if (entry.error) return <ErrorLine size="sm" error={`Couldn't fork · ${entry.error}`} actions={again} />;
    if (entry.fork.where !== "worktree") return <WorkingLine state="live">Starting the conversation</WorkingLine>;
    return <SetupRow keep={id} setup={{ state: "running", after: null, steps: [] }} />;
  }
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
  // The footer's gap is the first row's (thread.tsx), so Rust's row takes its place without a shift.
  return (
    <UserBubble
      keep={entry.cid}
      text={entry.text}
      time={entry.sent}
      // A session's first message: dated in the footer as its row will be, so the row takes its place without a shift.
      dated
      // Rust moves its files into the session as the start begins, before the worktree is made.
      // shortcut: a start held back by a tab move, or refused before the move, shows broken thumbnails until Rust's row; upgrade when the start reply says the files moved.
      owner={id}
      parts={entry.parts ? (JSON.parse(entry.parts) as Draft).parts : undefined}
      unconfirmed={entry.unknown}
      failed={entry.error}
      onRetry={entry.asking ? undefined : () => retry(id)}
      onDiscard={entry.asking ? undefined : () => discard(id)}
    />
  );
}

/** While its start is out and nothing's gone wrong, a shimmering line under the message (D487). */
export function StartingLine({ id }: { id: string }) {
  const entry = useStarting().get(id);
  const session = useSyncExternalStore(threadSource.subscribe, threadSource.get);
  // A worktree being made says so itself, in this line's place (Thread draws it) [D70].
  if (!entry || entry.fork || entry.error || entry.unknown || entry.outcome || (session?.id === id && session.setup)) return null;
  return (
    <div className="pt-4">
      <WorkingLine state="live">Starting the conversation</WorkingLine>
    </div>
  );
}
