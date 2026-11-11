import type { ReactNode } from "react";

import { Button } from "../../components/button";
import { cx } from "../../components/cx";
import { ErrorLine } from "../../components/error-line";
import { CheckCircle, EditPencil, ExclamationMarkCircle, Spinner, Warning } from "../../icons";
import { PullRequestMerged, PullRequestOpen } from "../../landing/icons";
import type { Hero } from "../words";
import type { SourceData } from "./panel";

const HERO_TONE: Record<Hero["tone"], string> = {
  quiet: "text-muted-foreground",
  changes: "text-link",
  good: "text-success",
  warn: "text-warning",
  bad: "text-destructive",
  pr: "text-pr-yellow",
  merged: "text-pr-purple",
};

const GLYPH: Record<Hero["glyph"], ReactNode> = {
  spin: <Spinner className="animate-spin motion-reduce:animate-none" />,
  check: <CheckCircle />,
  warn: <Warning />,
  bad: <ExclamationMarkCircle />,
  pr: <PullRequestOpen />,
  edit: <EditPencil />,
  merged: <PullRequestMerged />,
};

/** Source's hero [D1200, D1206]: the state's glyph in its colour and one sentence; `children` go under it. */
export function HeroLine({ hero, children }: { hero: Hero; children?: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-1 pt-5 text-center">
      <span className={cx("flex svg:size-8", HERO_TONE[hero.tone])}>{GLYPH[hero.glyph]}</span>
      <span className="text-base font-medium">{hero.sentence}</span>
      {children}
    </div>
  );
}

/** The session's folder was removed outside the app: Source's and the card's line, with Restore when it can [D180, D1187]. */
export function Gone({ data, onRestore }: { data: SourceData; onRestore?: () => void }) {
  const restoring = data.restoring ?? false;
  return (
    <div className="flex flex-col items-center gap-2 pt-5 text-center">
      <span className="flex text-warning svg:size-8">
        <Warning />
      </span>
      <span className="text-base font-medium">This session's folder is gone</span>
      {data.truth?.restorable ? (
        <Button size="sm" disabled={restoring || data.offline} onClick={onRestore}>
          {restoring && <Spinner className="animate-spin motion-reduce:animate-none" />}
          {restoring ? "Restoring…" : data.restoreError ? "Try again" : "Restore"}
        </Button>
      ) : (
        <span className="text-xs text-muted-foreground">It can't be restored from here.</span>
      )}
      <ErrorLine error={data.restoreError ?? null} />
    </div>
  );
}

