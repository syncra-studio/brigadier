import { useState } from "react";

import { cx } from "../components/cx";
import { ErrorLine } from "../components/error-line";
import { Skeleton } from "../components/skeleton";
import { showToast } from "../components/toast";
import type { Pr } from "../panel/types";
import { prAct } from "./pr-act";
import { MergeDialog, SubmitReviewDialog } from "./pr-dialogs";
import { type ChangesLook, PrFiles } from "./pr-files";
import type { Sends } from "./pr-parts";
import { Summary } from "./pr-summary";
import { PrToolbar } from "./pr-toolbar";
import type { PrComment, PullRequest } from "./pull-requests";

/** Why Merge can't be pressed now; null when it can [D164]. */
export function mergeBlocked(pr: PullRequest): string | null {
  if (pr.state === "closed") return "Reopen this pull request before merging";
  if (pr.state === "draft") return "Mark this pull request ready for review before merging";
  if (pr.blockers?.conflicts || pr.mergeState === "dirty") return "Resolve merge conflicts before merging";
  if (pr.checks.some((check) => check.state === "failed")) return "Fix failing checks before merging";
  if (pr.checks.some((check) => check.state === "running")) return "Wait for checks to finish before merging";
  if (pr.mergeState === "blocked") return "This pull request can’t be merged yet";
  if (!pr.mergeState || pr.mergeState === "unknown") return "GitHub is still checking whether this can be merged";
  return null;
}

/**
 * A pull request [D164 D240]: its toolbar (pr-toolbar.tsx), then Summary or Changes. It paints its last read at once; when a read fails, the last one stays with why [D1009].
 */
export function PrTab({
  owner,
  target,
  pr,
  row,
  error,
  checking,
  sends,
  onCheck,
  onFix,
  onReview,
  onAddToChat,
}: {
  owner: string;
  /** Its tab's target: `n`, `owner/name#n`, or `host/owner/name#n` [D213]. */
  target: string;
  /** undefined until its first read lands. */
  pr: PullRequest | undefined;
  /** Its row as the watch keeps it: the header before the first read. */
  row: Pr | undefined;
  error?: string;
  /** A read under way. */
  checking: boolean;
  sends: Sends;
  onCheck: () => void;
  onFix: (focus: "checks" | "conflicts" | "comments", check?: string) => void;
  onReview: (instructions: string) => void;
  onAddToChat: (comment: PrComment) => void;
}) {
  // Refresh reads Changes again too, when it's open [D231].
  const [tick, setTick] = useState(0);
  const check = () => {
    onCheck();
    setTick((n) => n + 1);
  };
  // Changes is drawn once first opened, then kept laid out under Summary, so going back to it is only a repaint [D656].
  const [tab, setTab] = useState<"summary" | "code">("summary");
  const [coded, setCoded] = useState(false);
  const [merging, setMerging] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [look, setLook] = useState<ChangesLook>({ split: false, tree: true, generated: false });
  // Changes picked while the PR still loads draws once it lands.
  const pick = (next: "summary" | "code") => {
    setTab(next);
    if (next === "code") setCoded(true);
  };
  if (!pr) {
    return (
      <div data-slot="pr-tab" className="flex min-h-0 flex-1 flex-col">
        <PrToolbar pr={undefined} tab={tab} onTab={pick} checking={checking} onCheck={check} look={look} onLook={setLook} busy={false} blocked={null} onReview={onReview} onApprove={() => {}} onMerge={() => {}} act={() => {}} />
        <div className="mx-auto flex w-full max-w-6xl flex-col gap-4 px-6 pt-8">
          {row ? <h1 className="font-display text-2xl font-medium">{row.title}</h1> : <Skeleton className="h-6 w-2/3" />}
          {error ? (
            <ErrorLine error={error} />
          ) : (
            <div aria-label="Loading pull request details" className="flex flex-col gap-3">
              <Skeleton className="h-4 w-1/2" />
              <Skeleton className="h-24 w-full" />
            </div>
          )}
        </div>
      </div>
    );
  }
  const act = (verb: "close" | "reopen" | "draft" | "ready" | "automerge", ...rest: string[]) => {
    setBusy(true);
    prAct(verb, pr, ...rest)
      .catch((cause: Error) => showToast(cause.message || "GitHub could not update this pull request", { tone: "error" }))
      .finally(() => (setBusy(false), sends.onChanged()));
  };
  const blocked = mergeBlocked(pr);
  const writable = Boolean(pr.ref);
  return (
    <div data-slot="pr-tab" className="flex min-h-0 flex-1 flex-col">
      <PrToolbar
        pr={pr}
        tab={tab}
        onTab={pick}
        checking={checking}
        onCheck={check}
        look={look}
        onLook={setLook}
        busy={busy}
        blocked={blocked}
        onReview={onReview}
        onApprove={() => setReviewing(true)}
        onMerge={() => setMerging(true)}
        act={act}
      />
      {/* Why the last read didn't go: what shows is the last read that did [D1009]. */}
      <ErrorLine error={error ?? pr.problem} className="px-6 pt-3" />
      <div className="relative min-h-0 flex-1">
        <div hidden={tab !== "summary"} className="absolute inset-0 overflow-y-auto">
          <Summary pr={pr} sends={sends} onFix={onFix} onAddToChat={onAddToChat} />
        </div>
        {/* Invisible, not hidden: display none would lay every diff out again on each return. */}
        <div inert={tab !== "code"} className={cx("absolute inset-0 flex flex-col", tab !== "code" && "invisible")}>
          {coded && <PrFiles owner={owner} target={target} pr={pr} tick={tick} sends={sends} look={look} onOpen={() => sends.onOpen("pr")} onAddToChat={onAddToChat} />}
        </div>
      </div>
      {writable && (
        <>
          <MergeDialog pr={pr} open={merging} onOpenChange={setMerging} onDone={sends.onChanged} />
          <SubmitReviewDialog pr={pr} open={reviewing} onOpenChange={setReviewing} onDone={sends.onChanged} />
        </>
      )}
    </div>
  );
}
