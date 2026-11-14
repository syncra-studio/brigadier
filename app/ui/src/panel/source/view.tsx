import { useDaemon } from "../../daemon";
import { HOME } from "../../shell/tab-store";
import { restoreCheckout, retryGit, useGit } from "../git";
import { useShare } from "../share";
import type { SourceData, SourceOps } from "./data";

/**
 * `owner`'s checkout as the summary card shows it, and Rust's moves on it [D1145].
 */
export function useSource(owner: string): { data: SourceData; ops: SourceOps } {
  const git = useGit();
  const { daemon, rows } = useDaemon();
  const offline = !daemon;
  const share = useShare(owner === HOME ? null : owner, git.version);
  const title = (id: string | null) => (id === null ? null : (rows?.find((row) => row.id === id)?.title ?? "Another session"));
  return {
    data: {
      source: git.source,
      error: git.error,
      offline: offline && git.source !== null,
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
      restore: restoreCheckout,
    },
  };
}
