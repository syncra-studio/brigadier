import { PreviewCard } from "@base-ui/react/preview-card";
import { type ReactElement, useEffect, useState } from "react";

import { cx } from "../components/cx";
import { menuSurface } from "../components/menu";
import { Skeleton } from "../components/skeleton";
import { ask } from "../daemon";
import { StateIcon } from "../landing/pr-parts";
import { STATE_WORDS } from "../landing/pr-words";
import type { PullRequest } from "../landing/pull-requests";
import { prName } from "./route";

// Each PR's last read this run: a second hover shows it at once.
const read = new Map<string, PullRequest>();

/** The PR's kept read, else a fresh one; undefined until one lands, null when GitHub can't say. */
function usePr(ref: string, open: boolean): PullRequest | null | undefined {
  const [pr, setPr] = useState<PullRequest | null | undefined>(read.get(ref));
  useEffect(() => {
    if (!open || read.has(ref)) return;
    const land = (reply: Record<string, any>) => reply.ok && reply.pr && (read.set(ref, reply.pr), setPr(reply.pr));
    ask({ op: "run", args: ["host", "@", "view", ref, "kept"] }, (kept) => {
      if (kept.ok && kept.pr) return land(kept);
      ask({ op: "run", args: ["host", "@", "view", ref] }, (fresh) => (fresh.ok ? land(fresh) : setPr(null)));
    });
  }, [ref, open]);
  return pr;
}

/**
 * A PR link's hover card [D163]: repository · #n, its state, its title on up to three lines, then +/− and how
 * many files.
 */
export function PrHoverCard({ refName, children }: { refName: string; children: ReactElement }) {
  const [open, setOpen] = useState(false);
  const pr = usePr(refName, open);
  return (
    <PreviewCard.Root open={open} onOpenChange={setOpen}>
      <PreviewCard.Trigger render={children} />
      <PreviewCard.Portal>
        <PreviewCard.Positioner side="top" sideOffset={6} className="z-popup">
          <PreviewCard.Popup className={cx(menuSurface, "flex w-72 flex-col gap-1.5 p-3")}>
            <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
              {pr && <StateIcon state={pr.state} />}
              <span className="min-w-0 flex-1 truncate">{prName(refName)}</span>
              {pr && <span>{STATE_WORDS[pr.state]}</span>}
            </span>
            {pr === undefined ? (
              <Skeleton className="h-4 w-full" />
            ) : pr === null ? (
              <span className="text-sm text-muted-foreground">Unable to load this pull request</span>
            ) : (
              <>
                <span className="line-clamp-3 text-sm text-foreground">{pr.title}</span>
                <span className="flex gap-2 text-xs text-muted-foreground tabular-nums">
                  <span className="text-success">+{pr.additions}</span>
                  <span className="text-destructive">−{pr.deletions}</span>
                  <span>
                    {pr.files} file{pr.files === 1 ? "" : "s"}
                  </span>
                </span>
              </>
            )}
          </PreviewCard.Popup>
        </PreviewCard.Positioner>
      </PreviewCard.Portal>
    </PreviewCard.Root>
  );
}
