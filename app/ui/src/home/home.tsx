import { useEffect, useRef, useState, useSyncExternalStore } from "react";

import type { ModelChoice, ModelGroup } from "../components/composer/model-picker";
import type { PermissionLevel } from "../components/composer/pickers";
import { Button } from "../components/button";
import { ErrorLine } from "../components/error-line";
import { UserBubble } from "../components/thread/message";
import { SetupRow } from "../components/thread/setup";
import { WorkHeader, WorkingLine } from "../components/thread/work";
import { threadSource, useDaemon } from "../daemon";
import { errorText, run, useProfile } from "../onboarding/api";
import { useProjects } from "../projects/projects";
import { showToast } from "../components/toast";
import { openAddProject } from "../projects/store";
import { enterProject } from "../projects/trust";
import { daemonRun } from "../session/composer";
import type { Draft } from "../components/composer/draft";
import { draftOf, keepDraft, loadDraft } from "../session/draft";
import { LevelPicker } from "../session/level";
import { OvernightPill } from "../sessions/overnight-parts";
import { asGroups, levelsOf } from "../session/model";
import { readRouting } from "../settings/routing";
import { SetUpAgentDialog } from "../session/set-up";
import { discard, draftKey, pickHomeProject, retry, setHomeDraft, start, useHomeDraft, useHomeProject, useStarting } from "./start";
import { useRepo } from "./branch";
import { HomeView } from "./view";
import { prName } from "../pull-requests/route";
import { useReviewProject } from "../pull-requests/review";

/** A `models --project` group: the agent's levels, the one a new session there starts on, and whether it's held. */
type LevelGroup = ModelGroup & { levels: PermissionLevel[]; level: PermissionLevel | null; held: boolean };

/** What a row tells of the model its session last ran on (1q's fold). */
type Ran = { project: string | null; sent: number; backend: string; model?: string | null; effort?: string | null };

/**
 * Home's draft on Rust's data [D161], a project's or Chats'. The model: the one picked here, else the project's last session's, else the first an agent offers there,
 * one on this computer first; only a model the list still has counts [D129].
 */
export function HomeDraft() {
  const { daemon, rows, projects: savedProjects } = useDaemon();
  const name = useProfile().value?.name ?? "";
  const projects = useProjects()?.filter((each) => !each.pending);
  const draft = useHomeDraft();
  const key = draftKey(draft);
  const ran = (rows ?? []) as Ran[];
  const latest = (project?: string) => ran.filter((row) => (project ? row.project === project : row.project)).toSorted((a, b) => b.sent - a.sent)[0];
  // A project added from here is picked once Rust has it (the old app opened its draft).
  const before = useRef<Set<string> | null>(null);
  const added = before.current && projects?.find((each) => !before.current!.has(each.id));
  useEffect(() => {
    if (!added) return;
    before.current = null;
    void pickHomeProject(added.id);
  }, [added]);
  // A PR's review chat is in the project of its repository when there's one, else in none, the agent reading it through gh [D162 D198].
  const home = useHomeProject();
  const reviewIn = useReviewProject(draft.review);
  const project = draft.review ? (projects?.find((each) => each.id === reviewIn) ?? null) : home;

  const [listed, setListed] = useState<{ project: string | undefined; trusted: boolean | null | undefined; groups: LevelGroup[]; fresh: boolean } | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [setUp, setSetUp] = useState<string | null>(null);
  const asked = useRef(0);
  const id = project?.id;
  // A folder of repos has no placement: each chat works in its own folder and claims copies there [D494].
  const once = draft.once?.project === project?.id ? draft.once : undefined;
  // A review reads the local checkout, or a worktree from it while a session holds it.
  const held = (place: string) => rows?.some((row) => row.project === place && row.local && !row.archived);
  const workIn = draft.review ? (id && held(id) ? "worktree" : "local") : project?.kind === "folder" ? "worktree" : once ? "existing" : draft.workIn;
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
  const picked = once?.worktree ?? spot?.worktree;
  // A session's own worktree isn't one Home offers, so its one-off is taken as it is [D152].
  const worktree = once?.worktree ?? known(picked, repo.info?.worktrees, (each) => each.path === picked);
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
    run([...models, "--fresh"]).then(
      (reply) => {
        land(reply, true);
        // A new model list can make an offer; Rust works them out on a read [D386].
        readRouting().catch(() => {});
      },
      (cause) => mine === asked.current && setListError(errorText(cause)),
    );
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
  const levels = agent ? levelsOf(agent.levels, agent.provider, model?.model, groups) : [];
  const other = agent?.level && !levels.includes(agent.level) ? levels[0] : undefined;
  const pick = !agent || agent.held ? undefined : levels.includes(draft.level!) ? draft.level : other;

  return (
    <>
      <HomeView
        // Drawn again on another draft's words: the composer reads `initial` as it mounts.
        key={key}
        name={name}
        review={draft.review && prName(draft.review)}
        // Its project is looked up first: until then it can't start.
        projects={draft.review && reviewIn === undefined ? undefined : projects}
        project={project}
        // What's in the other draft is Rust's to say.
        onProject={(id) => (daemon ? void pickHomeProject(id) : void showToast("Reconnecting…"))}
        onNoProject={() => (daemon ? void pickHomeProject(null) : void showToast("Reconnecting…"))}
        onAddProject={(path) => {
          before.current = new Set(projects?.map((each) => each.id));
          openAddProject(path);
        }}
        workIn={workIn}
        localHolder={workIn === "local" && id ? rows?.find((row) => row.project === id && row.local) : undefined}
        onWorkIn={(workIn) => setHomeDraft({ workIn, once: undefined })}
        repo={repo}
        base={base}
        onBase={(branch) => id && setHomeDraft({ spot: { project: id, base: branch, worktree: worktree ?? undefined }, once: undefined })}
        worktree={worktree}
        worktreeName={once?.name}
        onWorktree={(path) => id && setHomeDraft({ spot: { project: id, base: base ?? undefined, worktree: path }, once: undefined })}
        // Only a fresh list can say no model is available: a cached one before any check offers none, so it reads as loading.
        groups={fresh || model ? groups : null}
        model={model}
        onModel={(choice) => setHomeDraft({ model: choice })}
        onSetUp={setSetUp}
        level={
          agent && (
            <>
              <LevelPicker levels={levels} level={pick ?? agent.level} held={agent.held} onChange={(level) => setHomeDraft({ level })} />
              <OvernightPill on={draft.overnight === true} onChange={(overnight) => setHomeDraft({ overnight })} />
            </>
          )
        }
        overnight={draft.overnight === true}
        onOvernight={(overnight) => setHomeDraft({ overnight })}
        modelError={listError}
        offline={!daemon}
        draft={key}
        initial={draftOf(key)}
        onDraft={(text) => keepDraft(daemonRun, key, text)}
        loadDraft={() => loadDraft(daemonRun, key)}
        focus={draft.focus}
        onSend={(text, parts) => model && start(id ?? null, { workIn, base: base ?? repo.info?.current ?? null, worktree, review: draft.review }, model, text, pick ?? agent?.level ?? undefined, parts, draft.overnight)}
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
  // One that may have reached its agent, or is in its log, is only tried again [C75]; one whose session stays after a refusal can go.
  const droppable = entry.left || (!entry.maybe && entry.outcome !== "logged");
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
              {!entry.left && (
                <Button variant="link-blue" size={null} onClick={() => retry(id)}>
                  Try again
                </Button>
              )}
              {droppable && (
                <Button variant="link-blue" size={null} onClick={() => discard(id)}>
                  Discard
                </Button>
              )}
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
      // Its time and actions in view while only the starting line is under it, as over Thinking (thread.tsx).
      older={Boolean(entry.worktree || (session?.id === id && session.setup))}
      // Rust moves its files into the session as the start begins, before the worktree is made.
      // shortcut: a start held back by a tab move, or refused before the move, shows broken thumbnails until Rust's row; upgrade when the start reply says the files moved.
      owner={id}
      parts={entry.parts ? (JSON.parse(entry.parts) as Draft).parts : undefined}
      unconfirmed={entry.unknown}
      failed={entry.error}
      signIn={entry.signIn}
      maybe={entry.maybe}
      onRetry={entry.asking || entry.left ? undefined : () => retry(id)}
      onDiscard={entry.asking || !droppable ? undefined : () => discard(id)}
    />
  );
}

/** A worktree being made, under the pending message until its row is in the thread, which then draws it [D77]. */
export function StartingSetup({ id }: { id: string }) {
  const entry = useStarting().get(id);
  const session = useSyncExternalStore(threadSource.subscribe, threadSource.get);
  if (!entry || entry.fork) return null;
  // Rust sends the setup's place with the message's row, so the thread takes it over in the same frame.
  const mine = session?.id === id;
  if (mine && session.turns.some((turn) => turn.id === entry.cid)) return null;
  // Until Rust's first word on it, the worktree being made is the one asked for, as the card shows with the message.
  const setup = (mine && session.setup) || (entry.worktree && !entry.error && !entry.outcome ? { state: "running" as const, after: null, steps: [{ kind: "worktree" as const, state: "running" as const, branch: null, base: entry.worktree.base, error: null }] } : null);
  if (!setup) return null;
  // Its turn's header is there from the start, as the thread draws it, so nothing moves when the turn comes [D85]; its clock starts with Rust's turn.
  return (
    <>
      <div className="pt-6">
        <WorkHeader turn={{ id: entry.cid, status: "running", startedAt: Infinity, endedAt: null }} work={undefined} open={null} onToggle={() => {}} />
      </div>
      <div className="pt-4">
        <SetupRow keep={`${id}:setup`} setup={setup} />
      </div>
    </>
  );
}

/** While its start is out and nothing's gone wrong, a shimmering line under the message (D487), and under its worktree once made [D77]. */
export function StartingLine({ id }: { id: string }) {
  const entry = useStarting().get(id);
  const session = useSyncExternalStore(threadSource.subscribe, threadSource.get);
  // Kept until the thread has its turn, which draws Thinking in the same frame, so nothing blank comes between.
  if (!entry || entry.fork || entry.error || entry.unknown || entry.outcome === "logged") return null;
  if (session?.id === id && session.turns.some((turn) => turn.id === entry.cid)) return null;
  const setup = session?.id === id ? session.setup : null;
  if (setup ? setup.state !== "done" : entry.worktree) return null;
  // Straight under the message, where Thinking takes its place: 12 under its actions, as in the thread.
  return (
    <div className={setup ? "pt-4" : "pt-3"}>
      <WorkingLine state="live">Starting the conversation</WorkingLine>
    </div>
  );
}
