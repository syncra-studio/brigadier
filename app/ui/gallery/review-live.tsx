// The Review tab's live copy: Rust's part played by timers over the fake data (review-data.ts).
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";

import { Button } from "../src/components/button";
import { ComposerCard, ComposerFooter, ComposerTools, PlusButton } from "../src/components/composer/composer";
import { ComposerField, type ComposerFieldHandle } from "../src/components/composer/field";
import { SendButton } from "../src/components/composer/send-button";
import { showToast } from "../src/components/toast";
import { CommentChip } from "../src/review/comments";
import { ReviewTab } from "../src/review/review-tab";
import type { DiffComment, FileContents, RequestState, ReviewRequest, ReviewScope } from "../src/review/types";
import { type Done, FIRST_STAGED, read } from "./review-data";

/** How long the fake daemon takes to answer. */
const LATENCY = 700;

/** The comments waiting as chips, over the composer they go with; Send takes them and they leave the diff (D1040). */
export function ChipComposer({ comments, onRemove, onSend }: { comments: readonly DiffComment[]; onRemove: (id: string) => void; onSend: () => void }) {
  const field = useRef<ComposerFieldHandle>(null);
  const [empty, setEmpty] = useState(true);
  const send = () => {
    if (empty && comments.length === 0) return;
    field.current?.set([]);
    onSend();
  };
  return (
    <ComposerCard>
      {comments.length > 0 && (
        <div data-slot="composer-attachments" className="flex w-full flex-wrap items-end gap-2 px-1 pt-1 pb-1.5">
          {comments.map((comment) => (
            <CommentChip key={comment.id} comment={comment} onRemove={() => onRemove(comment.id)} />
          ))}
        </div>
      )}
      <ComposerField ref={field} placeholder="Ask for follow-up changes" onChange={(parts) => setEmpty(parts.length === 0)} onSubmit={send} />
      <ComposerFooter>
        <ComposerTools>
          <PlusButton />
        </ComposerTools>
        <SendButton empty={empty && comments.length === 0} running={false} canStop={false} onSend={send} onStop={() => {}} />
      </ComposerFooter>
    </ComposerCard>
  );
}

/** A tab's frame at a main area's size. */
export function Frame({ children, tall = false }: { children: ReactNode; tall?: boolean }) {
  return <div className={tall ? "flex h-180 w-full max-w-240 flex-col overflow-hidden rounded-surface border border-border" : "flex h-120 w-full max-w-240 flex-col overflow-hidden rounded-surface border border-border"}>{children}</div>;
}

export function LiveReview() {
  const [scope, setScope] = useState<ReviewScope>("uncommitted");
  const [done, setDone] = useState<Done>(FIRST_STAGED);
  const [connected, setConnected] = useState(true);
  const [failNext, setFailNext] = useState(false);
  const [loading, setLoading] = useState(false);
  // What has arrived: contents follow the list, a large file's only when asked for (D1036).
  const [arrived, setArrived] = useState<ReadonlySet<string>>(new Set());
  const [states, setStates] = useState<ReadonlyMap<string, RequestState>>(new Map());
  const [comments, setComments] = useState<DiffComment[]>([]);
  const { review, contents, changes } = useMemo(() => read(scope, done), [scope, done]);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    setArrived(new Set());
    setLoading(true);
    const timer = setTimeout(() => {
      setArrived(new Set(review.files.filter((file) => !file.large).map((file) => file.path)));
      setLoading(false);
    }, LATENCY);
    return () => clearTimeout(timer);
    // A new scope or a refresh reads again; a stage or revert settles in place.
  }, [scope, tick]);
  const shown = useMemo(() => new Map<string, FileContents>([...contents].filter(([path]) => arrived.has(path))), [contents, arrived]);
  const setState = (key: string, state: RequestState | null) =>
    setStates((current) => {
      const next = new Map(current);
      if (state) next.set(key, state);
      else next.delete(key);
      return next;
    });
  const request = ({ action, path, hunk }: ReviewRequest) => {
    const key = hunk ?? path;
    // Shown at once, settled by its id when the daemon answers (D30).
    setState(key, { pending: action });
    const failing = failNext;
    setFailNext(false);
    setTimeout(() => {
      if (failing) return setState(key, { error: "The file changed since this diff was read. Refresh and try again." });
      setState(key, null);
      const own = hunk ? (changes.get(hunk) ?? []) : [...changes].filter(([id]) => id.startsWith(`${path}:`)).flatMap(([, list]) => list);
      setDone((current) => {
        const staged = new Set(current.staged);
        const reverted = new Set(current.reverted);
        for (const change of own.length ? own : [path]) {
          if (action === "stage") staged.add(change);
          else if (action === "unstage") staged.delete(change);
          else reverted.add(change);
        }
        return { staged, reverted };
      });
    }, LATENCY);
  };
  return (
    <div className="flex w-full flex-col gap-3">
      <div className="flex gap-2">
        <Button size="sm" variant={connected ? "outline" : "default"} onClick={() => setConnected(!connected)}>
          Reconnecting
        </Button>
        <Button size="sm" variant={failNext ? "default" : "outline"} onClick={() => setFailNext(!failNext)}>
          Fail the next action
        </Button>
        <Button size="sm" variant="outline" onClick={() => setDone(FIRST_STAGED)}>
          Start over
        </Button>
      </div>
      <Frame tall>
        <ReviewTab
          scope={scope}
          onScope={setScope}
          review={review}
          contents={shown}
          error={null}
          loading={loading}
          connected={connected}
          onRefresh={() => setTick(tick + 1)}
          onLoad={(path) => setTimeout(() => setArrived((current) => new Set([...current, path])), LATENCY)}
          states={states}
          onRequest={request}
          onOpenIn={(path, where) => showToast(`Open ${path} in ${where}`)}
          comments={comments}
          onComment={(comment) => setComments((list) => [...list, comment])}
          onRemoveComment={(id) => setComments((list) => list.filter((comment) => comment.id !== id))}
        />
      </Frame>
      <div className="w-full max-w-reading">
        <ChipComposer
          comments={comments}
          onRemove={(id) => setComments((list) => list.filter((comment) => comment.id !== id))}
          onSend={() => {
            showToast(`Sent with ${comments.length} comments`);
            setComments([]);
          }}
        />
      </div>
    </div>
  );
}
