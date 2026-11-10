import type { ReactNode } from "react";

import { Button } from "../../components/button";
import { TooltipIconButton } from "../../components/icon-button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger, MenuRow } from "../../components/menu";
import { Clock, DotsHorizontal, PullRequestClosed, PullRequestMerged, PullRequestOpen } from "../../icons";
import type { Commit, Pr, PrWatch } from "../types";
import { ago, clock, plural, prDot, prWords, type Tone, watchWords } from "../words";

const TEXT: Record<Tone, string> = { quiet: "text-muted-foreground", good: "text-success", warn: "text-warning", bad: "text-destructive" };
const DOT: Record<Tone, string> = { quiet: "", good: "bg-success", warn: "bg-warning", bad: "bg-destructive" };

const place = (held?: HTMLElement) => held && { container: held, collisionAvoidance: { side: "none", align: "none" } as const };

/** Source's title row [D1114]: "Source", then History and PRs when there are some, then More Actions. */
export function SourceHeader({ children }: { children?: ReactNode }) {
  return (
    <header className="flex h-control-md shrink-0 items-center gap-0.5 ps-3 pe-2">
      <h2 className="min-w-0 flex-1 text-sm font-medium">Source</h2>
      {children}
    </header>
  );
}

/** More Actions (`menu`, its content). `held`: the gallery holds it open. */
export function MoreButton({ locked, menu, held = false }: { locked: boolean; menu: ReactNode; held?: boolean }) {
  return (
    <DropdownMenu modal={false} {...(held && { open: true })}>
      <DropdownMenuTrigger render={<TooltipIconButton tooltip="More Actions" size="icon-sm" disabled={locked} />}>
        <DotsHorizontal />
      </DropdownMenuTrigger>
      {menu}
    </DropdownMenu>
  );
}

/** A menu's last row: one button into the whole tab [D1114]. */
function OpenTab({ onClick, children }: { onClick?: () => void; children: ReactNode }) {
  return (
    <div className="px-1 pt-1 pb-0.5">
      <Button size="sm" variant="soft" className="w-full" onClick={onClick}>
        {children}
      </Button>
    </div>
  );
}

/**
 * The session's last five commits since its base, a click opening that commit's diff in a Review tab; then Open
 * history, the History tab (2.29) [D1041, D1111, D1114]. Both open once those tabs land.
 */
export function HistoryMenu({ commits, base, held, onCommit, onOpen }: { commits: Commit[]; base: string; held?: HTMLElement; onCommit?: (sha: string) => void; onOpen?: () => void }) {
  return (
    <DropdownMenu modal={false} {...(held && { open: true })}>
      <DropdownMenuTrigger render={<TooltipIconButton tooltip="History" size="icon-sm" />}>
        <Clock />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-72" {...place(held)}>
        <DropdownMenuLabel>
          {plural(commits.length, "commit")} since {base}
        </DropdownMenuLabel>
        {commits.slice(0, 5).map((commit) => (
          <DropdownMenuItem key={commit.sha} onClick={() => onCommit?.(commit.sha)}>
            <MenuRow title={commit.subject} hint={commit.sha} mono />
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <OpenTab onClick={onOpen}>Open history</OpenTab>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function PrGlyph({ pr }: { pr: Pr }) {
  const tone = TEXT[prWords(pr).tone];
  if (pr.state === "merged") return <PullRequestMerged className={tone} />;
  if (pr.state === "closed") return <PullRequestClosed className={tone} />;
  return <PullRequestOpen className={tone} />;
}

/**
 * Every PR of the branch, a row opening the Pull requests tab on it (2.13); the watch's news, which replaces the old
 * clock popover; then Open pull requests [D1017, D1114, D1116]. The icon's dot is the worst open PR's colour.
 */
export function PrMenu({ prs, watch, nowMs, held, onPr, onOpen }: { prs: Pr[]; watch: PrWatch | null; nowMs: number; held?: HTMLElement; onPr?: (number: number) => void; onOpen?: () => void }) {
  const dot = prDot(prs);
  const events = watch?.events.filter((event) => prs.some((pr) => pr.number === event.pr)) ?? [];
  return (
    <DropdownMenu modal={false} {...(held && { open: true })}>
      <DropdownMenuTrigger render={<TooltipIconButton tooltip={plural(prs.length, "pull request")} size="icon-sm" {...(dot && { dot: DOT[dot] })} />}>
        <PullRequestOpen />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-72" {...place(held)}>
        <DropdownMenuLabel>Pull requests</DropdownMenuLabel>
        {prs.map((pr) => {
          const words = prWords(pr);
          return (
            <DropdownMenuItem key={pr.number} onClick={() => onPr?.(pr.number)}>
              <MenuRow
                icon={<PrGlyph pr={pr} />}
                title={
                  <>
                    <span className="text-muted-foreground">#{pr.number}</span> {pr.title}
                  </>
                }
                hint={<span className={TEXT[words.tone]}>{words.word}</span>}
              />
            </DropdownMenuItem>
          );
        })}
        {watch && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel>Watching · checked {ago(watch.checkedAtMs, nowMs)}</DropdownMenuLabel>
            {events.map((event) => (
              <div key={`${event.atMs}:${event.pr}:${event.kind}`} className="flex min-w-0 items-baseline gap-2 px-2 py-0.5 text-xs">
                <span className="shrink-0 font-mono text-muted-foreground">{clock(event.atMs)}</span>
                <span className="min-w-0 flex-1 truncate">{watchWords(event)}</span>
                <span className="shrink-0 text-muted-foreground">{event.detail}</span>
              </div>
            ))}
          </>
        )}
        <OpenTab onClick={onOpen}>Open pull requests</OpenTab>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
