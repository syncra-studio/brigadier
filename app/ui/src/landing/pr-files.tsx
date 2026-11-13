import { useEffect, useRef, useState } from "react";

import { ask, useDaemon } from "../daemon";
import { ReviewTab } from "../review/review-tab";
import type { PrFiles as Files, PullRequest } from "./pull-requests";
import { FRESH_MS } from "./pr-words";

const NONE = () => {};

/**
 * A PR's Files changed, any PR's, from its host through Rust [D231]: read when the tab is first opened, its last read
 * kept beside the page's and painted at once on the next, read again when the head moved, when it's older than the
 * watch's pace, on Check again (`tick`) and on Refresh. Drawn by the Review tab's own diff, the host's patch of each
 * file; a list the host cut says so, with the rest on the host.
 */
export function PrFiles({ owner, target, pr, tick, onOpen }: { owner: string; target: string; pr: PullRequest; tick: number; onOpen: () => void }) {
  const { daemon } = useDaemon();
  const [files, setFiles] = useState<Files | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const shown = useRef<Files | null>(null);
  const seen = useRef(tick);
  const at = useRef(0);
  const land = (next: Files) => {
    shown.current = next;
    setFiles(next);
  };
  const read = () => {
    const mine = ++at.current;
    setLoading(true);
    ask({ op: "run", args: ["host", owner, "files", target] }, (reply) => {
      if (at.current !== mine) return;
      setLoading(false);
      if (reply.ok) {
        land(reply.files);
        setError(null);
      } else if (reply.error !== "disconnected") {
        // The last read stays on screen with why [D1009].
        setError(String(reply.error));
      }
    });
  };
  const current = (got: Files | null) => got && got.head === pr.head && Date.now() - got.checkedAtMs < FRESH_MS;
  useEffect(() => {
    if (!daemon) return;
    const forced = seen.current !== tick;
    seen.current = tick;
    if (shown.current) return void ((forced || !current(shown.current)) && read());
    ask({ op: "run", args: ["host", owner, "files", target, "kept"] }, (reply) => {
      const kept: Files | null = reply.ok ? reply.files : null;
      if (kept && !shown.current) land(kept);
      if (!current(shown.current)) read();
    });
  }, [daemon, owner, target, pr.head, tick]);

  const contents = new Map((files?.files ?? []).map((file) => [file.path, file]));
  const cut = files && files.total > files.files.length;
  return (
    <ReviewTab
      scope="branch"
      review={files}
      contents={contents}
      error={error}
      loading={loading}
      connected={Boolean(daemon)}
      onRefresh={read}
      onLoad={NONE}
      comments={[]}
      onRemoveComment={NONE}
      more={
        cut && (
          <p className="p-4 text-sm text-muted-foreground">
            Showing {files.files.length} of {files.total} files ·{" "}
            <button type="button" className="cursor-pointer underline-offset-2 hover:underline" onClick={onOpen}>
              See the rest on {pr.host}
            </button>
          </p>
        )
      }
    />
  );
}
