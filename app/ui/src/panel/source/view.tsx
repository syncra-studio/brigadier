import { useDaemon } from "../../daemon";
import { openFile } from "../../shell/tab-store";
import { moveFiles, retryGit, useGit } from "../git";
import { openReview } from "../open";
import { SourcePanel } from "./panel";

/**
 * The Source view of a session or project chat, on Rust's git; a project chat shows its folder [D1039]. Stage, unstage
 * and discard go through the same Rust moves as Review's [D1043, D1103]. The action button waits for Rust's next step
 * (2.19 on), the branch list, PRs and history for theirs.
 */
export function SourceView({ owner }: { owner: string }) {
  const git = useGit();
  const offline = !useDaemon().daemon;
  return (
    <SourcePanel
      data={{ source: git.source, step: null, error: git.error, offline: offline && git.source !== null, pending: git.pending }}
      draftKey={owner}
      nowMs={Date.now()}
      ops={{
        stage: (paths) => moveFiles("stage", "uncommitted", paths),
        unstage: (paths) => moveFiles("unstage", "uncommitted", paths),
        discard: (paths, scope) => moveFiles("discard", scope === "unstaged" ? "unstaged" : "uncommitted", paths),
        review: (path) => openReview(owner, path),
        openFile: (path) => openFile(owner, path, { preview: false }),
        retry: retryGit,
      }}
    />
  );
}
