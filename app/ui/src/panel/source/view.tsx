import { useEffect } from "react";

import { useDaemon } from "../../daemon";
import { refreshHistory, useHistory } from "../../history/store";
import { newSession, setHomeDraft, useHomeProject } from "../../home/start";
import { HOME, openFile, openTab } from "../../shell/tab-store";
import { moveFiles, retryGit, type Target, useGit } from "../git";
import { openReview } from "../open";
import { name, named, readBranches, setBase, sync, useBranchOp } from "./branch-ops";
import { read as readPr } from "./create-pr";
import { type BranchOps, type SourceData, type SourceOps, SourcePanel } from "./panel";

/** The branch item's moves on `target`'s checkout, Rust's [D1020, D1021]. */
function branchOps(target: Target, owner: string, project: string | null, branch: string): BranchOps {
  return {
    read: (done) => readBranches(target, done),
    sync: () => sync(target, "sync", branch),
    publish: () => sync(target, "publish", branch),
    rename: (to) => name(target, ["rename", to], to),
    switchTo: (to, remote) => name(target, ["switch", to, ...(remote ? ["--remote"] : [])], remote ? to.slice(to.indexOf("/") + 1) : to),
    create: (to, from) => name(target, ["create", to, ...(from ? ["--from", from] : [])], to),
    // What follows the base reads it again at once: History and the PR's facts [D1143].
    setBase: (base) =>
      setBase(target, base, () => {
        refreshHistory(owner);
        if (owner !== HOME) readPr(owner);
      }),
    newSession: (base) => {
      if (project) setHomeDraft({ spot: { project, base } });
      newSession(project);
    },
    openPage: (url) => window.brigadier?.openLink(url),
  };
}

/**
 * `owner`'s checkout as Source shows it, and Rust's moves on it: Source and the summary card read and act on the same
 * [D1145]. Stage, unstage and discard go through the same Rust moves as Review's [D1043, D1103]. The action button
 * waits for Rust's next step (2.19 on), the branch list and PRs for theirs.
 */
export function useSource(owner: string): { data: SourceData; ops: SourceOps } {
  const git = useGit();
  const { daemon, rows } = useDaemon();
  const offline = !daemon;
  const op = useBranchOp(git.target);
  const home = useHomeProject();
  const project = owner === HOME ? (home?.id ?? null) : (rows?.find((row) => row.id === owner)?.project ?? null);
  // The new name shows until the watch reads it.
  const branch = git.source?.branch ?? null;
  useEffect(() => {
    if (git.target && op.naming && op.naming === branch) named(git.target);
  }, [git.target, op.naming, branch]);
  return {
    data: {
      source: git.source,
      step: null,
      error: git.error,
      offline: offline && git.source !== null,
      pending: git.pending,
      rejected: op.rejected,
      syncing: op.syncing,
      naming: op.naming,
    },
    ops: {
      stage: (paths) => moveFiles("stage", "uncommitted", paths),
      unstage: (paths) => moveFiles("unstage", "uncommitted", paths),
      discard: (paths, scope) => moveFiles("discard", scope === "unstaged" ? "unstaged" : "uncommitted", paths),
      review: (path) => openReview(owner, path),
      openFile: (path) => openFile(owner, path, { preview: false }),
      retry: retryGit,
      branch: git.target ? branchOps(git.target, owner, project, branch ?? "the branch") : undefined,
    },
  };
}

/** The Source view of a session or project chat, on Rust's git; a project chat shows its folder [D1039]. */
export function SourceView({ owner }: { owner: string }) {
  const { data, ops } = useSource(owner);
  // History is Rust's (2.29): the menu lists what the History tab does, and opens its commits and the tab [D1041, D1114].
  const { history, error } = useHistory(owner);
  return (
    <SourcePanel
      data={{
        ...data,
        history: {
          commits: history?.commits ?? [],
          base: history?.base ?? null,
          error,
          onCommit: (sha) => openTab(owner, "commit", sha),
          onOpen: () => openTab(owner, "history"),
          onMenu: () => refreshHistory(owner),
        },
      }}
      draftKey={owner}
      session={owner === HOME ? null : owner}
      nowMs={Date.now()}
      ops={ops}
    />
  );
}
