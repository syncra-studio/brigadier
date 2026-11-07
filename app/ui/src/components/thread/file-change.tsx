import { memo } from "react";

import type { FileChange, Progress } from "../../thread/item";
import { CopyButton } from "../copy-button";
import { cx } from "../cx";
import { OpeningRow, ROW, StepIcon, Words } from "./activity-row";

export const FILE_VERBS: Record<FileChange["change"], [string, string, string]> = {
  added: ["Creating", "Created", "create"],
  modified: ["Editing", "Edited", "edit"],
  deleted: ["Deleting", "Deleted", "delete"],
  renamed: ["Renaming", "Renamed", "rename"],
};

/** A diff past this many lines isn't drawn. */
const MAX_DIFF_LINES = 5000;

export const fileName = (path: string) => path.slice(path.lastIndexOf("/") + 1);

/**
 * One changed file: "Edited blocks.ts", then its counts (+7 −2, coloured while hovered) and a dot for a
 * created (blue) or deleted (red) file. A finished one opens to its diff. A declined change reads "Rejected".
 */
export function FileChangeRow({ keep, change, progress }: { keep: string; change: FileChange; progress: Progress }) {
  const { added, removed } = change;
  const running = progress === "running" || progress === "pending";
  const name = fileName(change.path);
  const [doing, done, waiting] = FILE_VERBS[change.change];
  const object = change.change === "renamed" && change.from ? `${fileName(change.from)} to ${name}` : name;
  const head = (
    <>
      <StepIcon kind="edit" />
      {progress === "pending" ? (
        <Words verb={`Waiting to ${waiting}`} object={object} />
      ) : progress === "cancelled" ? (
        <Words verb="Rejected" object={name} />
      ) : (
        <Words verb={running ? doing : done} object={progress === "failed" ? `${object} — failed` : object} live={progress === "running"} />
      )}
    </>
  );
  if (running) return <div className={ROW}>{head}</div>;
  const trail = (
    <>
      {added !== null && removed !== null && <Counts added={added} removed={removed} quiet />}
      {change.change === "added" && <span className="size-1.5 rounded-capsule bg-link" />}
      {change.change === "deleted" && <span className="size-1.5 rounded-capsule bg-destructive" />}
    </>
  );
  return (
    <OpeningRow keep={keep} trail={trail} detail={<DiffCard change={change} />}>
      {head}
    </OpeningRow>
  );
}

/** "+7 −2". Quiet: grey until its row is hovered; a zero stays grey. */
function Counts({ added, removed, quiet = false }: { added: number; removed: number; quiet?: boolean }) {
  const plus = added === 0 ? undefined : quiet ? "group-hover:text-success" : "text-success";
  const minus = removed === 0 ? undefined : quiet ? "group-hover:text-destructive" : "text-destructive";
  return (
    <span className={cx("shrink-0 tabular-nums", quiet ? "font-mono text-xs" : "text-xs text-muted-foreground")}>
      <span className={plus}>+{added}</span> <span className={minus}>−{removed}</span>
    </span>
  );
}

/** A file's diff: its name, counts and copy over the lines, added green, removed red. */
export function DiffCard({ change }: { change: FileChange }) {
  const { added, removed } = change;
  return (
    <div className="mt-1 flex min-h-0 min-w-0 flex-col overflow-clip rounded-shell border border-border">
      <div className="flex min-h-8 items-center gap-2 bg-fill-subtle ps-3 pe-1 text-sm text-action-hover">
        <span title={change.path} className="min-w-0 truncate">
          {fileName(change.path)}
        </span>
        {added !== null && removed !== null && <Counts added={added} removed={removed} />}
        <CopyButton text={change.diff} tooltip="Copy diff" size="icon-xs" className="ms-auto" />
      </div>
      <DiffLines diff={change.diff} gone={change.change === "deleted"} />
    </div>
  );
}

const LINE = { "+": "bg-diff-added text-success", "-": "bg-diff-removed text-destructive", "@": "text-link" } as const;

/** The unified diff's lines, coloured by their first character; only drawn once the card is open. */
const DiffLines = memo(function DiffLines({ diff, gone }: { diff: string; gone: boolean }) {
  const lines = diff ? diff.split("\n") : [];
  if (lines.at(-1) === "") lines.pop();
  const empty = lines.length === 0 ? (gone ? "Contents deleted" : "No changes") : lines.length > MAX_DIFF_LINES ? "Diff too large to preview" : null;
  if (empty) return <p className="px-3 py-2 text-sm text-muted-foreground">{empty}</p>;
  // Inside a hunk "+++x" is an added "++x": only lines before the first @@ are file headers.
  const hunk = lines.findIndex((line) => line.startsWith("@@"));
  return (
    <div className="max-h-60 min-w-0 scroll-edge-fade edge-fade-diff overflow-auto">
      <pre className="flex w-max min-w-full flex-col font-mono text-diff">
        {lines.map((line, i) => (
          <span
            // Lines never move within a diff, so their place is their key.
            key={i}
            className={cx(
              "px-3 whitespace-pre",
              i < hunk && (line.startsWith("+++") || line.startsWith("---")) ? "text-muted-foreground italic" : LINE[line[0] as keyof typeof LINE],
            )}
          >
            {line || " "}
          </span>
        ))}
      </pre>
    </div>
  );
});
