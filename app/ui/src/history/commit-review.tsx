import { useEffect, useRef, useState } from "react";

import { ask, useDaemon } from "../daemon";
import { addChip, dropChips, useChips } from "../panel/chips";
import { ReviewTab } from "../review/review-tab";
import type { FileContents, Review, ReviewFile } from "../review/types";
import { openFile } from "../shell/tab-store";

const NO_STATES = new Map();

/**
 * One commit's diff in a Review tab [D1035, D1041], opened from History: Rust sends its file list with counts, then
 * each file's two sides, a large one when it's opened [D1036]. Read-only: a commit has no stage or revert. Any commit
 * of the session's stays readable, not only those still since its base.
 */
export function CommitReview({ owner, sha }: { owner: string; sha: string }) {
  const daemon = useDaemon().daemon;
  const [review, setReview] = useState<Review | null>(null);
  const [contents, setContents] = useState<ReadonlyMap<string, FileContents | { error: string }>>(new Map());
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  // A comment waits as a chip above the session's composer [D1040].
  const chips = useChips(owner);
  // Bumped by each read, so an older read's answers are dropped.
  const run = useRef(0);

  const load = (file: ReviewFile, mine = run.current) =>
    ask({ op: "run", args: ["source", owner, "commit", sha, file.path, ...(file.from ? [file.from] : [])] }, (reply) => {
      if (mine !== run.current || reply.error === "disconnected") return;
      setContents((now) => new Map(now).set(file.path, reply.ok ? reply.contents : { error: String(reply.error) }));
    });

  const read = () => {
    const mine = ++run.current;
    setLoading(true);
    ask({ op: "run", args: ["source", owner, "commit", sha] }, (reply) => {
      if (mine !== run.current) return;
      setLoading(false);
      if (reply.error === "disconnected") return;
      if (!reply.ok) return setError(String(reply.error));
      const next: Review = reply.review;
      setError(null);
      setReview(next);
      setContents(new Map());
      for (const file of next.files) if (!file.large && !file.binary) load(file, mine);
    });
  };

  // A commit never changes: read when the tab first shows; after a reconnect, only what didn't arrive. A large file
  // not opened yet stays unread; opening it asks.
  useEffect(() => {
    if (!daemon) return;
    if (!review) return read();
    for (const file of review.files) if (!file.large && !file.binary && !contents.has(file.path)) load(file);
  }, [owner, sha, daemon?.pid]);

  return (
    <ReviewTab
      scope="commit"
      onScope={() => {}}
      review={review}
      contents={contents}
      error={error}
      loading={loading}
      connected={!!daemon}
      onRefresh={read}
      onLoad={(path) => {
        const file = review?.files.find((entry) => entry.path === path);
        if (file) load(file);
      }}
      states={NO_STATES}
      onRequest={() => {}}
      // shortcut: only "in a tab" opens for now; in the app and in Finder come with Review's own wiring (2.18).
      onOpenIn={(path, where) => where === "tab" && openFile(owner, path, { preview: false })}
      comments={chips.filter((chip) => chip.on === sha).map((chip) => chip.comment)}
      onComment={(comment) => addChip(owner, { kind: "comment", id: comment.id, on: sha, comment })}
      onRemoveComment={(id) => dropChips(owner, [id])}
    />
  );
}
