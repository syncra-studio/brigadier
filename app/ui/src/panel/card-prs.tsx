import { useState } from "react";

import { copyWithToast } from "../components/copy-button";
import { cx } from "../components/cx";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger, DropdownMenuTrigger } from "../components/menu";
import { showToast } from "../components/toast";
import { useDaemon } from "../daemon";
import { ChevronDown, X } from "../icons";
import { useHost } from "../landing/host";
import { codeFirst } from "../landing/pr-tab";
import type { PullRequest } from "../landing/pull-requests";
import { ago, STATE_WORDS } from "../landing/pr-words";
import { type Focus, sendToAgent } from "../landing/send-to-agent";
import { errorText, run } from "../onboarding/api";
import { CardSection, WarnLine } from "./card";
import { Counts, Line, PR_LOOK, ROW, ROW_HOVER, Rows } from "./source/rows";
import type { KeptPrs, Pr } from "./types";

const REPAIRS: [Focus, string][] = [
  ["comments", "Comments"],
  ["checks", "Failing checks"],
  ["conflicts", "Merge conflicts"],
  ["everything", "Everything"],
];

/**
 * A PR's row [D143 D167 D177]: its state's icon, "PR #n" and its title, its state word and age; hovered, its
 * menu: View (its tab), Copy link, Open in browser, Code changes (its tab's Code) and Repair ▸, each our Send to agent
 * with that focus: the PR in the session's composer, nothing sent. No GitHub writes from here.
 */
function PrRow({ owner, pr, nowMs, onView }: { owner: string | null; pr: Pr; nowMs: number; onView?: (pr: Pr, code?: boolean) => void }) {
  const host = useHost(owner ?? "");
  const { rows, projects } = useDaemon();
  const [read, setRead] = useState<PullRequest | null>(null);
  const state = pr.state === "open" && pr.draft ? "draft" : pr.state;
  const { Icon, tint } = PR_LOOK[state];
  const target = pr.repo ? `${pr.repo}#${pr.number}` : String(pr.number);
  const failing = pr.state === "open" && pr.health === "failed";
  // The last read from the session's folder, for Code changes' counts: no git, no host [D207].
  const kept = () => owner && !read && run(["host", host, "view", target, "kept"]).then((reply) => reply.pr && setRead(reply.pr)).catch(() => {});
  const repair = (focus: Focus) =>
    (read ? Promise.resolve(read) : run(["host", host, "view", target, "kept"]).then((kept) => kept.pr ?? run(["host", host, "view", target]).then((live) => live.pr)))
      .then((pull: PullRequest) => sendToAgent(pull, host, target, rows ?? [], projects ?? [], () => {}, focus))
      .catch((cause) => showToast(`Couldn't send #${pr.number} to the agent: ${errorText(cause)}`, { tone: "error" }));
  return (
    <DropdownMenu modal={false} onOpenChange={(open) => open && kept()}>
      <DropdownMenuTrigger openOnHover delay={300} className={cx(ROW, ROW_HOVER, "cursor-pointer data-popup-open:bg-summary-row-hover")}>
        <span aria-hidden className={cx("flex w-5 shrink-0 items-center justify-center svg:size-4", tint)}>
          <Icon />
        </span>
        <span className="min-w-0 flex-1 truncate">
          PR #{pr.number} <span className="text-muted-foreground">{pr.title}</span>
        </span>
        <span className="flex shrink-0 items-center gap-1.5 text-muted-foreground">
          {failing && <X aria-label="Checks failed" className="size-icon-sm text-destructive" />}
          {STATE_WORDS[state]}
          {pr.updatedAtMs && state !== "open" ? ` ${ago(pr.updatedAtMs, nowMs)}` : ""}
        </span>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onClick={() => onView?.(pr)}>View</DropdownMenuItem>
        {pr.url && <DropdownMenuItem onClick={() => copyWithToast(pr.url!, "link")}>Copy link</DropdownMenuItem>}
        {pr.url && <DropdownMenuItem onClick={() => window.brigadier?.openLink(pr.url!)}>Open in browser</DropdownMenuItem>}
        {owner && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => onView?.(pr, true)}>
              Code changes
              {read && <Counts added={read.additions} removed={read.deletions} />}
            </DropdownMenuItem>
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>Repair</DropdownMenuSubTrigger>
              <DropdownMenuSubContent>
                {REPAIRS.map(([focus, label]) => (
                  <DropdownMenuItem key={focus} onClick={() => void repair(focus)}>
                    {label}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * The session's pull requests, a section [D143]: Rust's order, open first, 5 then Show N more; merged ones
 * behind "Merged PRs", which shows and hides them. A watch read that failed keeps the last PRs with why [D1009].
 * `owner` null (a folder chat's repos): View opens the PR on its host, and there's no Repair.
 */
export function PrsCard({ owner, prs, kept, nowMs, offline = false, onPr }: { owner: string | null; prs: readonly Pr[]; kept?: KeptPrs | null; nowMs: number; offline?: boolean; onPr: (pr: Pr, code?: boolean) => void }) {
  const [showMerged, setShowMerged] = useState(false);
  if (prs.length === 0 && !kept?.error) return null;
  const view = (pr: Pr, code?: boolean) => {
    if (code) codeFirst.add(pr.repo ? `${pr.repo}#${pr.number}` : String(pr.number));
    onPr(pr, code);
  };
  const row = (pr: Pr) => <PrRow key={`${pr.repo ?? ""}#${pr.number}`} owner={owner} pr={pr} nowMs={nowMs} onView={view} />;
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
