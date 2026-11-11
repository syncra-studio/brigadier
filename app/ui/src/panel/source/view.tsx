import { useEffect } from "react";

import { useDaemon } from "../../daemon";
import { newSession, setHomeDraft, useHomeProject } from "../../home/start";
import { HOME } from "../../shell/tab-store";
import { isWorking as working, landBranch, refreshStep, restoreCheckout, retryGit, setMergeStyle, squashOf, type Target, useGit } from "../git";
import { useShare } from "../share";
import { moved, name, named, readBranches, setBase, sync, useBranchOp } from "./branch-ops";
import { read as readPr } from "./create-pr";
import type { BranchOps, SourceData, SourceOps } from "./data";

/** The branch item's moves on `target`'s checkout, Rust's [D1020, D1021]. */
function branchOps(target: Target, owner: string, project: string | null, branch: string): BranchOps {
  return {
    read: (done) => readBranches(target, done),
    sync: () => sync(target, "sync", branch),
    publish: () => sync(target, "publish", branch),
    // The step reads the branch under its new name at once [D1143].
    rename: (to) => name(target, ["rename", to], to, () => refreshStep()),
    switchTo: (to, remote) => name(target, ["switch", to, ...(remote ? ["--remote"] : [])], remote ? to.slice(to.indexOf("/") + 1) : to),
    create: (to, from) => name(target, ["create", to, ...(from ? ["--from", from] : [])], to),
    // What follows the base reads it again at once: the step and the PR's facts [D1143].
    setBase: (base) =>
      setBase(target, base, () => {
        refreshStep();
        if (owner !== HOME) readPr(owner);
      }),
    newSession: (base) => {
      // A base is a new worktree's: Home's Local checkout would drop it.
      if (project) setHomeDraft({ workIn: "worktree", spot: { project, base } });
      newSession(project);
    },
    openPage: (url) => window.brigadier?.openLink(url),
  };
}

/**
 * `owner`'s checkout as the summary card shows it, and Rust's moves on it [D1145]. Its step is Rust's next step, and
 * lands through Rust (2.22) [D1152].
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
    if (git.target && op.rejected && branch && op.rejected.branch !== branch) moved(git.target);
  }, [git.target, op.naming, op.rejected, branch]);
  const share = useShare(owner === HOME ? null : owner, git.version);
  const title = (id: string | null) => (id === null ? null : (rows?.find((row) => row.id === id)?.title ?? "Another session"));
  return {
    data: {
      source: git.source,
      step: git.step?.step ?? null,
      merge: git.step?.merge ?? null,
      at: git.step?.at ?? null,
      error: git.error,
      offline: offline && git.source !== null,
      rejected: op.rejected,
      syncing: op.syncing,
      naming: op.naming,
      // The session's own agent; a project folder's sessions are guarded in Rust [D1082, D1208].
      agentWorking: owner !== HOME && working(rows?.find((row) => row.id === owner)),
      readAtMs: git.readAtMs,
      truth: git.truth,
      restoring: git.restoring,
      restoreError: git.restoreError,
      freshness: git.step?.freshness ?? git.truth?.base ?? null,
      run: git.brief?.run,
      flags: git.brief?.flags,
      agentPaths: git.brief?.agent ?? null,
      share: share && { with: title(share.with), busy: title(share.busy), includes: title(share.includes), lands: share.lands },
    },
    ops: {
      retry: retryGit,
      branch: git.target ? branchOps(git.target, owner, project, branch ?? "the branch") : undefined,
      land: landBranch,
      setStyle: setMergeStyle,
      squashOf,
      restore: restoreCheckout,
    },
  };
}
