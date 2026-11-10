import { useEffect, useRef, useState } from "react";

import { ask, useDaemon } from "../daemon";
import { ReviewTab } from "../review/review-tab";
import type { DiffComment, FileContents, Review } from "../review/types";
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
  // Comments stay on the diff for now; they become chips with the other scopes' (2.18) [D1040].
  const [comments, setComments] = useState<readonly DiffComment[]>([]);
  // Bumped by each read, so an older read's answers are dropped.
  const run = useRef(0);

  const load = (path: string, mine = run.current) =>
    ask({ op: "run", args: ["git", owner, "--commit", sha, "--file", path] }, (reply) => {
      if (mine !== run.current || reply.error === "disconnected") return;
      setContents((now) => new Map(now).set(path, reply.ok ? reply.contents : { error: String(reply.error) }));
    });

  const read = () => {
    const mine = ++run.current;
    setLoading(true);
    ask({ op: "run", args: ["git", owner, "--commit", sha] }, (reply) => {
      if (mine !== run.current) return;
      setLoading(false);
      if (reply.error === "disconnected") return;
      if (!reply.ok) return setError(String(reply.error));
      const next: Review = reply.review;
      setError(null);
      setReview(next);
      setContents(new Map());
      for (const file of next.files) if (!file.large && !file.binary) load(file.path, mine);
    });
  };

  // A commit never changes: read when the tab first shows, and again after a reconnect if it didn't arrive.
  useEffect(() => {
    if (daemon && !review) read();
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
      onLoad={(path) => load(path)}
      states={NO_STATES}
      onRequest={() => {}}
      // shortcut: only "in a tab" opens for now; in the app and in Finder come with Review's own wiring (2.18).
      onOpenIn={(path, where) => where === "tab" && openFile(owner, path, { preview: false })}
      comments={comments}
      onComment={(comment) => setComments((now) => [...now, comment])}
      onRemoveComment={(id) => setComments((now) => now.filter((comment) => comment.id !== id))}
    />
  );
}
