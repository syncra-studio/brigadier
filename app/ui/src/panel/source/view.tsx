import { useEffect } from "react";

import { useDaemon } from "../../daemon";
import { HOME } from "../../shell/tab-store";
import { isWorking as working, restoreCheckout, retryGit, type Target, useGit } from "../git";
import { useShare } from "../share";
import { name, named, readBranches, useBranchOp } from "./branch-ops";
import type { BranchOps, SourceData, SourceOps } from "./data";

/** The branch item's moves on `target`'s checkout, Rust's [D1020, D1021]. */
function branchOps(target: Target, branch: string): BranchOps {
  return {
    read: (done) => readBranches(target, done),
    switchTo: (to, remote) => name(target, ["switch", to, ...(remote ? ["--remote"] : [])], remote ? to.slice(to.indexOf("/") + 1) : to),
    create: (to, from) => name(target, ["create", to, ...(from ? ["--from", from] : [])], to),
  };
}

/**
 * `owner`'s checkout as the summary card shows it, and Rust's moves on it [D1145].
 */
export function useSource(owner: string): { data: SourceData; ops: SourceOps } {
  const git = useGit();
  const { daemon, rows } = useDaemon();
  const offline = !daemon;
  const op = useBranchOp(git.target);
  // The new name shows until the watch reads it.
  const branch = git.source?.branch ?? null;
  useEffect(() => {
    if (git.target && op.naming && op.naming === branch) named(git.target);
  }, [git.target, op.naming, branch]);
  const share = useShare(owner === HOME ? null : owner, git.version);
  const title = (id: string | null) => (id === null ? null : (rows?.find((row) => row.id === id)?.title ?? "Another session"));
  return {
    data: {
      source: git.source,
      error: git.error,
      offline: offline && git.source !== null,
      naming: op.naming,
      // The session's own agent; a project folder's sessions are guarded in Rust [D1082, D1208].
      agentWorking: owner !== HOME && working(rows?.find((row) => row.id === owner)),
      readAtMs: git.readAtMs,
      truth: git.truth,
      restoring: git.restoring,
      restoreError: git.restoreError,
      freshness: git.truth?.base ?? null,
      run: git.brief?.run,
      flags: git.brief?.flags,
      agentPaths: git.brief?.agent ?? null,
      share: share && { with: title(share.with) },
    },
    ops: {
      retry: retryGit,
      branch: git.target ? branchOps(git.target, branch ?? "the branch") : undefined,
      restore: restoreCheckout,
    },
  };
}
