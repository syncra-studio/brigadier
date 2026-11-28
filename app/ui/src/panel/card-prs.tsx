import { useState } from "react";

import { copyWithToast } from "../components/copy-button";
import { cx } from "../components/cx";
import { DropdownMenuItem } from "../components/menu";
import { ChevronDown, Link, PR_LOOK, X } from "../icons";
import { Eye } from "../icons/settings";
import { ago, STATE_WORDS } from "../landing/pr-words";
import { openTab } from "../shell/tab-store";
import { CardSection, RowMenu, WarnLine } from "./card";
import { prTarget } from "./open";
import { Line, Rows } from "./source/rows";
import type { KeptPrs, Pr } from "./types";

/**
 * A PR's row [D143]: its state's icon, "PR #n" and its title, its state word and age, opening its tab; on
 * hover its "…", with View (the same) and Copy link. One nothing can open or copy has neither.
 */
function PrRow({ owner, pr, nowMs }: { owner: string; pr: Pr; nowMs: number }) {
  const state = pr.state === "open" && pr.draft ? "draft" : pr.state;
  const { Icon, tint } = PR_LOOK[state];
  const target = prTarget(owner, pr);
  const view = target ? () => openTab(owner, "pr", target) : undefined;
  return (
    <Line
      icon={<Icon className={tint} />}
      onClick={view}
      end={
        <>
          {pr.state === "open" && pr.health === "failed" && <X aria-label="Checks failed" className="size-icon-sm text-destructive" />}
          {STATE_WORDS[state]}
          {pr.updatedAtMs && state !== "open" ? ` ${ago(pr.updatedAtMs, nowMs)}` : ""}
        </>
      }
      action={
        (view || pr.url) && (
          <RowMenu label={`More for PR #${pr.number}`}>
            {view && (
              <DropdownMenuItem onClick={view}>
                <Eye />
                View
              </DropdownMenuItem>
            )}
            {pr.url && (
              <DropdownMenuItem onClick={() => copyWithToast(pr.url!, "link")}>
                <Link />
                Copy link
              </DropdownMenuItem>
            )}
          </RowMenu>
        )
      }
    >
      PR #{pr.number} <span className="text-muted-foreground">{pr.title}</span>
    </Line>
  );
}

/**
 * The session's pull requests, a section [D143]: Rust's order, open first, 5 then Show N more; merged ones
 * behind "Merged PRs", which shows and hides them. A watch read that failed keeps the last PRs with why [D1009].
 */
export function PrsCard({ owner, prs, kept, nowMs, offline = false }: { owner: string; prs: readonly Pr[]; kept?: KeptPrs | null; nowMs: number; offline?: boolean }) {
  const [showMerged, setShowMerged] = useState(false);
  if (prs.length === 0 && !kept?.error) return null;
  const row = (pr: Pr) => <PrRow key={`${pr.repo ?? ""}#${pr.number}`} owner={owner} pr={pr} nowMs={nowMs} />;
  const done = prs.filter((pr) => pr.state === "merged");
  return (
    <CardSection title="Pull requests" fold="pull-requests" count={prs.length}>
      <div className={cx("flex flex-col", offline && "opacity-disabled")} inert={offline}>
        <Rows items={prs.filter((pr) => pr.state !== "merged")}>{row}</Rows>
        {done.length > 0 && (
          <>
            {showMerged && done.map(row)}
            <Line
              icon={<ChevronDown className={showMerged ? "rotate-180" : "-rotate-90"} />}
              onClick={() => setShowMerged(!showMerged)}
              className="text-muted-foreground"
            >
              {showMerged ? "Hide merged PRs" : "Merged PRs"}
            </Line>
          </>
        )}
        {kept?.error && <WarnLine text={["Couldn't check", kept.okAt && ago(kept.okAt, nowMs), kept.error.split("\n")[0]].filter(Boolean).join(" · ")} />}
      </div>
    </CardSection>
  );
}
