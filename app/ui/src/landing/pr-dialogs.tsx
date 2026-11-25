import { useState } from "react";

import { Button } from "../components/button";
import { ConfirmDialog } from "../components/confirm-dialog";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../components/dialog";
import { ErrorLine } from "../components/error-line";
import { Segmented } from "../components/segmented";
import { Textarea } from "../components/textarea";
import { prAct, said } from "./pr-act";
import type { PullRequest } from "./pull-requests";

/*
 * The PR tab's two dialogs [D164 D166]: Merge pull request and Submit review. Each acts on GitHub through Rust;
 * refused, it stays open with GitHub's words and what was picked or written, and the tab reads the PR again either way.
 */

const METHODS = [
  { value: "squash", label: "Squash", confirm: "Squash and merge" },
  { value: "merge", label: "Merge commit", confirm: "Create merge commit" },
  { value: "rebase", label: "Do not squash", confirm: "Merge without squashing" },
] as const;
type Method = (typeof METHODS)[number]["value"];

/** Merge pull request: a method, then the merge, only while GitHub still has the head commit shown [D164, D1077]. */
export function MergeDialog({ pr, open, onOpenChange, onDone }: { pr: PullRequest; open: boolean; onOpenChange: (open: boolean) => void; onDone: () => void }) {
  const [method, setMethod] = useState<Method>("squash");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const merge = () => {
    setBusy(true);
    setError(null);
    prAct("merge", pr, method, "--head", pr.head)
      .then(() => onOpenChange(false), (cause: Error) => setError(cause.message))
      .finally(() => {
        setBusy(false);
        onDone();
      });
  };
  return (
    <Dialog open={open} onOpenChange={(next) => !busy && (onOpenChange(next), setError(null))}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Merge pull request</DialogTitle>
          <DialogDescription>Choose a merge method and confirm.</DialogDescription>
        </DialogHeader>
        <Segmented label="Merge method" fill value={method} options={METHODS} onChange={setMethod} disabled={busy} />
        <p className="text-xs text-muted-foreground">GitHub will merge only if the displayed head commit still matches.</p>
        <ErrorLine error={error} />
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={busy} onClick={merge}>
            {busy ? "Merging…" : METHODS.find((each) => each.value === method)!.confirm}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

const DECISIONS = [
  { value: "approve", label: "Approve" },
  { value: "comment", label: "Comment" },
  { value: "changes", label: "Request changes" },
] as const;
type Decision = (typeof DECISIONS)[number]["value"];

/**
 * Submit review: Approve, Comment or Request changes, the comment required but for Approve; with a pending review its
 * comments go with it, or Discard deletes them after asking. Your own PR can't be approved or have changes asked.
 */
export function SubmitReviewDialog({ pr, open, onOpenChange, onDone }: { pr: PullRequest; open: boolean; onOpenChange: (open: boolean) => void; onDone: () => void }) {
  const own = Boolean(pr.authored);
  const [decision, setDecision] = useState<Decision>(own ? "comment" : "approve");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [discarding, setDiscarding] = useState(false);
  const pending = pr.pending?.count ?? 0;
  const required = decision !== "approve";
  const done = (close: boolean) => {
    setBusy(false);
    if (close) {
      setText("");
      onOpenChange(false);
    }
    onDone();
  };
  const submit = () => {
    setBusy(true);
    setError(null);
    prAct("review", pr, decision, ...said(text)).then(
      () => done(true),
      (cause: Error) => (setError(cause.message), done(false)),
    );
  };
  const discard = () => {
    setBusy(true);
    prAct("review-discard", pr).then(
      () => (setDiscarding(false), done(true)),
      (cause: Error) => (setDiscarding(false), setError(cause.message), done(false)),
    );
  };
  const options = DECISIONS.map((each) => ({ ...each, reason: own && each.value !== "comment" ? "You can't review your own pull request this way" : null }));
  return (
    <>
      <Dialog open={open && !discarding} onOpenChange={(next) => !busy && onOpenChange(next)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Submit review</DialogTitle>
            {pending > 0 && (
              <DialogDescription>
                {pending} pending comment{pending === 1 ? "" : "s"}. Only visible to you until you submit.
              </DialogDescription>
            )}
          </DialogHeader>
          <Segmented label="Review decision" fill value={decision} options={options} onChange={setDecision} disabled={busy} />
          <label className="flex flex-col gap-1.5 text-sm">
            <span className="flex items-center justify-between">
              Review comment
              <span className="text-xs text-muted-foreground">{required ? "Required" : "Optional"}</span>
            </span>
            <Textarea rows={5} value={text} disabled={busy} placeholder={required ? "Add a comment…" : "Optional comment"} onChange={(event) => setText(event.target.value)} />
          </label>
          <ErrorLine error={error} />
          <DialogFooter>
            {pending > 0 && (
              <Button variant="soft-destructive" className="me-auto" disabled={busy} onClick={() => setDiscarding(true)}>
                Discard
              </Button>
            )}
            <Button variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button disabled={busy || (required && !text.trim()) || (own && !pending && !text.trim())} onClick={submit}>
              Submit review
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <ConfirmDialog
        open={discarding}
        onOpenChange={setDiscarding}
        title="Discard review?"
        description="All pending comments in this review will be permanently deleted"
        cancel="Keep review"
        confirm="Discard review"
        destructive
        busy={busy}
        onConfirm={discard}
      />
    </>
  );
}
