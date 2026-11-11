import { useEffect, useRef, useState } from "react";

import { ask, useDaemon } from "../daemon";
import { addChip, dropChips, useChips, useCommentDraft } from "../panel/chips";
import { sourceArgs, useGit } from "../panel/git";
import { HOME, openFile, setTabScope } from "../shell/tab-store";
import { ReviewTab } from "./review-tab";
import type { FileContents, RequestState, Review, ReviewFile, ReviewRequest, ReviewScope } from "./types";

/**
 * The Review tab on Rust's git [D1035, D1036]: the scope's files and counts first, then each file's patch, a large
 * one's when it's opened. Every watch read that changed something reads it again. Stage, unstage and revert go
 * through the same Rust moves as Source's, by hunk id or path [D1043]. Branch since base is read again when the base
 * moves, which the watch doesn't see [D1035]. A comment waits as a chip above the composer and leaves the diff once
 * it's sent [D1040]. `target`: the file it opened on, scrolled to once it's there.
 */
export function ReviewView({ owner, target, tab, kept: keptScope }: { owner: string; target?: string; tab?: string; kept?: string }) {
  const git = useGit();
  const { daemon } = useDaemon();
  // Last turn first: what the agent just did (D1188). Home's Review is a project's, with no turns.
  // The tab's record keeps the one picked last [D1187].
  const [scope, setScope] = useState<ReviewScope>((keptScope as ReviewScope | undefined) ?? (owner === HOME ? "uncommitted" : "last"));
  const [review, setReview] = useState<Review | null>(null);
  const [contents, setContents] = useState<ReadonlyMap<string, FileContents | { error: string }>>(new Map());
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [states, setStates] = useState<ReadonlyMap<string, RequestState>>(new Map());
  const [tick, setTick] = useState(0);
  const read = useRef(0);
  const panel = useRef<HTMLDivElement>(null);
  // The file it was last brought to: a new target brings its file into view again.
  const scrolled = useRef<string | null>(null);
  const checkout = git.target;
  const key = checkout && JSON.stringify(checkout);
  const chips = useChips(owner);
  // A turn's start and end change Last turn and the last run with no git change to say so.
  const row = useDaemon().rows?.find((each) => each.id === owner);
  const kept = useCommentDraft(owner, "review");

  const setState = (id: string, state: RequestState | null) =>
    setStates((now) => {
      const next = new Map(now);
      if (state) next.set(id, state);
      else next.delete(id);
      return next;
    });

  const load = (file: ReviewFile, at: number, turn = review?.turn) => {
    if (!checkout) return;
    // Last turn's files are read between the two captures its list was read from, not a fresh one each (D1192).
    const where = scope === "last" ? (turn ? [turn.before, turn.after] : []) : [];
    if (scope === "last" && !turn) return;
    ask({ op: "run", args: sourceArgs(checkout, "review-file", scope, ...where, file.path, ...(file.from ? [file.from] : [])) }, (reply) => {
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
      // The folder now couldn't be captured at once: what's drawn stays, and it's asked again shortly.
      if (reply.busy) return void setTimeout(() => read.current === at && setTick((n) => n + 1), 1000);
      if (!reply.ok) return setError(String(reply.error));
      const next: Review = reply.review;
      setError(null);
      // A refused move's reason lasts until the diff is read again; what's pending stays.
      setStates((now) => new Map([...now].filter(([, state]) => "pending" in state)));
      setReview(next);
      // What was drawn stays until its new read lands, so a watch read doesn't blank the diff.
      setContents((now) => new Map([...now].filter(([path]) => next.files.some((file) => file.path === path && !file.large))));
      for (const file of next.files) if (!file.large) load(file, at, next.turn);
    });
  }, [key, daemon, scope, git.version, tick, row?.sent, row?.finished]);

  // shortcut: Branch since base asks every few seconds, while the window shows, whether the base moved; a watch of
  // the base's ref would be instant.
  const since = scope === "branch" ? review?.since : undefined;
  useEffect(() => {
    if (!checkout || !daemon || !since) return;
    const timer = setInterval(() => {
      if (document.visibilityState !== "visible") return;
      ask({ op: "run", args: sourceArgs(checkout, "since") }, (reply) => reply.ok && reply.since !== since && setTick((n) => n + 1));
    }, 5000);
    return () => clearInterval(timer);
  }, [key, daemon, since]);

  // Once the opened-on file is drawn (a large one folded, with no contents), it comes into view.
  useEffect(() => {
    const file = review?.files.find((each) => each.path === target);
    if (!target || scrolled.current === target || !file || (!file.large && !contents.has(target))) return;
    scrolled.current = target;
    panel.current?.querySelector(`[data-slot="review-file"][data-path="${CSS.escape(target)}"]`)?.scrollIntoView({ block: "start" });
  }, [review, contents, target]);

  const request = ({ action, path, hunk }: ReviewRequest) => {
    if (!checkout) return;
    const id = hunk ?? path;
    const from = review?.files.find((file) => file.path === path)?.from ?? null;
    setState(id, { pending: action });
    const args = hunk ? sourceArgs(checkout, "hunk", action, scope, path, from ?? "-", hunk) : sourceArgs(checkout, action === "revert" ? "discard" : action, scope, path);
    ask({ op: "run", args }, (reply) => setState(id, reply.ok ? null : { error: reply.error === "disconnected" ? "Not connected. Try again when it's back." : String(reply.error) }));
  };

  return (
    <div ref={panel} className="flex min-h-0 flex-1 flex-col">
      <ReviewTab
      scope={scope}
      onScope={(next) => {
        // Another scope's diff isn't shown under this one's loading or error.
        setScope(next);
        if (tab) setTabScope(owner, tab, next);
        setReview(null);
        setContents(new Map());
        setError(null);
      }}
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
      comments={chips.filter((chip) => chip.on === "review").map((chip) => chip.comment)}
      // Home's composer starts a session and carries no chips, so its diff takes no comments.
      onComment={owner === HOME ? undefined : (comment) => addChip(owner, { kind: "comment", id: comment.id, on: "review", comment })}
      onRemoveComment={(id) => dropChips(owner, [id])}
      target={target}
      {...(owner === HOME ? {} : kept)}
      />
    </div>
  );
}
