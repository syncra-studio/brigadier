import { useState } from "react";

import { DropdownMenuCheckboxItem, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger } from "../components/menu";
import { errorText, run } from "../onboarding/api";
import { Counts } from "../panel/source/rows";

/** An open PR of the session's repository, as `host <id> search` reads it. */
export type SourcePr = { number: number; ref: string; title: string; head: string; base: string; draft: boolean; additions: number; deletions: number };

/**
 * The Review tab's Pull requests source [D172]: the repository's open PRs, each "head → base" (· Draft) with
 * its +/−, read as the submenu opens; picking one shows its diff.
 */
export function PrSource({ owner, picked, onPick }: { owner: string; picked: SourcePr | null; onPick: (pr: SourcePr) => void }) {
  const [prs, setPrs] = useState<SourcePr[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const read = () => {
    setError(null);
    run(["host", owner, "search", "is:open"])
      .then((reply) => setPrs(reply.found[0].prs))
      .catch((cause) => setError(errorText(cause)));
  };
  return (
    <DropdownMenuSub onOpenChange={(open) => open && read()}>
      <DropdownMenuSubTrigger>Pull requests</DropdownMenuSubTrigger>
      <DropdownMenuSubContent className="max-w-80 min-w-64">
        {error ? (
          <>
            <DropdownMenuLabel variant="heading">Unable to load pull requests</DropdownMenuLabel>
            <DropdownMenuItem closeOnClick={false} onClick={read}>
              Try again
            </DropdownMenuItem>
          </>
        ) : !prs ? (
          <DropdownMenuLabel variant="heading">Loading pull requests…</DropdownMenuLabel>
        ) : prs.length === 0 ? (
          <DropdownMenuLabel variant="heading">No open pull requests</DropdownMenuLabel>
        ) : (
          prs.map((pr) => (
            <DropdownMenuCheckboxItem key={pr.ref} checked={picked?.ref === pr.ref} onCheckedChange={() => onPick(pr)} title={pr.title}>
              <span className="flex min-w-0 flex-1 gap-1">
                <span className="truncate">{pr.head}</span>
                <span className="shrink-0">→</span>
                <span className="max-w-1/3 shrink-0 truncate">{pr.base}</span>
                {pr.draft && <span className="shrink-0">· Draft</span>}
              </span>
              <Counts added={pr.additions} removed={pr.deletions} />
            </DropdownMenuCheckboxItem>
          ))
        )}
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}
