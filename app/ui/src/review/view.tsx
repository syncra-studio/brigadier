import { useEffect, useRef, useState } from "react";

import { ask, useDaemon } from "../daemon";
import { sourceArgs, useGit } from "../panel/git";
import { openFile } from "../shell/tab-store";
import { ReviewTab } from "./review-tab";
import type { FileContents, RequestState, Review, ReviewFile, ReviewRequest, ReviewScope } from "./types";

/**
 * The Review tab on Rust's git [D1035, D1036]: the scope's files and counts first, then each file's patch, a large
 * one's when it's opened. Every watch read that changed something reads it again. Stage, unstage and revert go
 * through the same Rust moves as Source's, by hunk id or path [D1043]. Branch since base and comments come with
 * 2.18. `target`: the file it opened on, scrolled to once it's there.
 */
export function ReviewView({ owner, target }: { owner: string; target?: string }) {
  const git = useGit();
  const { daemon } = useDaemon();
  const [scope, setScope] = useState<ReviewScope>("uncommitted");
  const [review, setReview] = useState<Review | null>(null);
  const [contents, setContents] = useState<ReadonlyMap<string, FileContents | { error: string }>>(new Map());
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [states, setStates] = useState<ReadonlyMap<string, RequestState>>(new Map());
  const [tick, setTick] = useState(0);
  const read = useRef(0);
  const scrolled = useRef(false);
  const checkout = git.target;
  const key = checkout && JSON.stringify(checkout);

  const setState = (id: string, state: RequestState | null) =>
    setStates((now) => {
      const next = new Map(now);
      if (state) next.set(id, state);
      else next.delete(id);
      return next;
    });

  const load = (file: ReviewFile, at: number) => {
    if (!checkout) return;
    ask({ op: "run", args: sourceArgs(checkout, "review-file", scope, file.path, ...(file.from ? [file.from] : [])) }, (reply) => {
      if (read.current !== at) return;
      const got = reply.ok ? (reply.contents.error ? { error: String(reply.contents.error) } : reply.contents) : { error: String(reply.error) };
      setContents((now) => new Map(now).set(file.path, got));
    });
  };

  useEffect(() => {
    if (!checkout || !daemon) return;
    const at = ++read.current;
    setLoading(true);
    ask({ op: "run", args: sourceArgs(checkout, "review", scope) }, (reply) => {
      if (read.current !== at) return;
      setLoading(false);
      if (!reply.ok) return setError(String(reply.error));
      const next: Review = reply.review;
      setError(null);
      // A refused move's reason lasts until the diff is read again; what's pending stays.
      setStates((now) => new Map([...now].filter(([, state]) => "pending" in state)));
      setReview(next);
      // What was drawn stays until its new read lands, so a watch read doesn't blank the diff.
      setContents((now) => new Map([...now].filter(([path]) => next.files.some((file) => file.path === path && !file.large))));
      for (const file of next.files) if (!file.large) load(file, at);
    });
  }, [key, daemon, scope, git.version, tick]);

  // Once the opened-on file is drawn, it comes into view.
  useEffect(() => {
    if (scrolled.current || !target || !contents.has(target)) return;
    scrolled.current = true;
    document.querySelector(`[data-slot="review-file"][data-path="${CSS.escape(target)}"]`)?.scrollIntoView({ block: "start" });
  }, [contents, target]);

  const request = ({ action, path, hunk }: ReviewRequest) => {
    if (!checkout) return;
    const id = hunk ?? path;
    const from = review?.files.find((file) => file.path === path)?.from ?? null;
    setState(id, { pending: action });
    const args = hunk ? sourceArgs(checkout, "hunk", action, scope, path, from ?? "-", hunk) : sourceArgs(checkout, action === "revert" ? "discard" : action, scope, path);
    ask({ op: "run", args }, (reply) => setState(id, reply.ok ? null : { error: reply.error === "disconnected" ? "Not connected. Try again when it's back." : String(reply.error) }));
  };

  return (
    <ReviewTab
      scope={scope}
      onScope={setScope}
      review={review}
      contents={contents}
      error={error}
      loading={loading}
      connected={Boolean(daemon)}
      onRefresh={() => setTick(tick + 1)}
      onLoad={(path) => {
        const file = review?.files.find((each) => each.path === path);
        if (file) load(file, read.current);
      }}
      states={states}
      onRequest={request}
      onOpenIn={(path) => openFile(owner, path, { preview: false })}
      comments={[]}
      onComment={() => {}}
      onRemoveComment={() => {}}
    />
  );
}
