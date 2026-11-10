import type { ReactNode } from "react";

import { cx } from "../../components/cx";
import { CheckCircle, EditPencil, PullRequestOpen, SyncGlyph, Warning } from "../../icons";
import type { SourceFile } from "../types";
import type { Status } from "../words";
import { Counts } from "./rows";

const TONE: Record<Status["tone"], string> = {
  quiet: "text-muted-foreground",
  changes: "text-link",
  good: "text-success",
  warn: "text-warning",
  bad: "text-destructive",
};

const ICON: Record<Status["icon"], ReactNode> = { clean: <CheckCircle />, changes: <EditPencil />, warn: <Warning />, pr: <PullRequestOpen />, sync: <SyncGlyph /> };

/** Source's one status [D1098]: an icon and a sentence in its state's colour, then the files' +/− counts. `small`: the summary card's [D1075]. */
export function StatusLine({ status, files, small = false }: { status: Status; files: SourceFile[]; small?: boolean }) {
  const added = files.reduce((sum, file) => sum + file.added, 0);
  const removed = files.reduce((sum, file) => sum + file.removed, 0);
  return (
    <p className="flex min-w-0 items-center gap-2.5">
      <span className={cx("flex shrink-0 svg:size-icon-lg", TONE[status.tone])}>{ICON[status.icon]}</span>
      <span className={cx("min-w-0 truncate font-medium", small ? "text-sm" : "text-base")}>{status.title}</span>
      {files.length > 0 && <Counts added={added} removed={removed} />}
    </p>
  );
}
