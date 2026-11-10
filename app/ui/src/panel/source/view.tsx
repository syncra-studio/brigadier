import { useDaemon } from "../../daemon";
import { refreshHistory, useHistory } from "../../history/store";
import { HOME, openFile, openTab } from "../../shell/tab-store";
import { moveFiles, retryGit, useGit } from "../git";
import { openReview } from "../open";
import { type SourceData, type SourceOps, SourcePanel } from "./panel";

/**
 * `owner`'s checkout as Source shows it, and Rust's moves on it: Source and the summary card read and act on the same
 * [D1145]. Stage, unstage and discard go through the same Rust moves as Review's [D1043, D1103]. The action button
 * waits for Rust's next step (2.19 on), the branch list and PRs for theirs.
 */
export function useSource(owner: string): { data: SourceData; ops: SourceOps } {
  const git = useGit();
  const offline = !useDaemon().daemon;
  return {
    data: { source: git.source, step: null, error: git.error, offline: offline && git.source !== null, pending: git.pending },
    ops: {
      stage: (paths) => moveFiles("stage", "uncommitted", paths),
      unstage: (paths) => moveFiles("unstage", "uncommitted", paths),
      discard: (paths, scope) => moveFiles("discard", scope === "unstaged" ? "unstaged" : "uncommitted", paths),
      review: (path) => openReview(owner, path),
      openFile: (path) => openFile(owner, path, { preview: false }),
      retry: retryGit,
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
