import { useState } from "react";

import { Badge } from "../components/badge";
import { Button } from "../components/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../components/collapsible";
import { showToast } from "../components/toast";
import { ChevronRight } from "../icons";
import { prAct, said } from "./pr-act";
import { CommentCard, Writer } from "./pr-comment";
import type { Sends } from "./pr-parts";
import type { PrComment, PrThread, PullRequest } from "./pull-requests";

/**
 * A review's line thread [D166]: its file and line, Outdated and Resolved, folded when resolved or outdated
 * as GitHub folds it; its comments, then Reply (into the viewer's pending review when there is one) and Resolve or
 * Unresolve. Quote reply fills the reply box.
 */
export function ThreadCard({
  pr,
  thread,
  comments,
  sends,
  onAddToChat,
  bare = false,
}: {
  pr: PullRequest;
  thread: PrThread;
  comments: Map<string, PrComment>;
  sends: Sends;
  onAddToChat?: (comment: PrComment) => void;
  /** Under its line in a diff: no file name over it. */
  bare?: boolean;
}) {
  const said_ = thread.comments.flatMap((id) => comments.get(id) ?? []);
  const first = said_[0];
  const [replying, setReplying] = useState(false);
  const [quote, setQuote] = useState<{ text: string; n: number }>();
  const [busy, setBusy] = useState(false);
  const resolve = () => {
    setBusy(true);
    prAct(thread.resolved ? "unresolve" : "resolve", pr, thread.id)
      .catch((cause: Error) => showToast(`Could not update this review thread: ${cause.message}`, { tone: "error" }))
      .finally(() => (setBusy(false), sends.onChanged()));
  };
  const where = first?.path && (first.line === null ? first.path : `${first.path}:${first.line}`);
  return (
    <Collapsible defaultOpen={!(thread.resolved || thread.outdated)} className="overflow-clip rounded-surface border border-border bg-background">
      <CollapsibleTrigger className="group flex min-h-control-md w-full cursor-pointer items-center gap-2 px-3 text-start text-xs hover:bg-fill-subtle focus-visible:focus-ring">
        <ChevronRight className="size-icon-xs shrink-0 text-muted-foreground transition-transform group-data-panel-open:rotate-90" />
        <span className="min-w-0 flex-1 truncate font-mono text-foreground">{bare ? (first?.author ?? "") : (where ?? thread.path)}</span>
        {thread.outdated && <Badge variant="outline">Outdated</Badge>}
        {thread.resolved && <Badge variant="outline">Resolved</Badge>}
      </CollapsibleTrigger>
      <CollapsibleContent className="flex flex-col gap-3 border-t border-border p-3">
        {said_.map((comment) => (
          <CommentCard
            key={comment.id}
            pr={pr}
            comment={comment}
            sends={sends}
            onAddToChat={onAddToChat}
            onQuote={(text) => (setReplying(true), setQuote((now) => ({ text, n: (now?.n ?? 0) + 1 })))}
          />
        ))}
        {replying ? (
          <Writer
            label="Reply"
            placeholder="Reply…"
            verb="Reply"
            rows={3}
            quote={quote}
            onCancel={() => setReplying(false)}
            onSend={(text) => prAct("reply", pr, thread.id, ...said(text)).then(() => (setReplying(false), sends.onChanged()))}
          />
        ) : (
          <div className="flex gap-2">
            <Button size="sm" variant="outline" className="flex-1 justify-start text-muted-foreground" onClick={() => setReplying(true)}>
              Reply…
            </Button>
            <Button size="sm" variant="outline" disabled={busy} onClick={resolve}>
              {thread.resolved ? "Unresolve" : "Resolve"}
            </Button>
          </div>
        )}
      </CollapsibleContent>
    </Collapsible>
  );
}
